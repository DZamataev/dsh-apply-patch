/**
 * Planning, checking and committing a parsed patch.
 *
 * `preparePatch` resolves every path, checks the files against the patch and
 * against the session's read-before-write policy, and computes every new file
 * text. Nothing is written until all of that succeeds, so a dry run reports
 * the same failures a real run would. Updating, deleting and moving an
 * existing file all require that the session read it and that it did not
 * change since (the `fs/write-intent` waterfall decides, as for the native
 * `write` tool).
 *
 * `commitPatch` performs the writes first and the removals last. Every write
 * and every removal is guarded by the version the patch expects: the version
 * checked while preparing for existing files, the version our own write
 * returned for files the patch created. When one step fails, the steps already
 * done are undone in reverse order with the same guards and without the call's
 * abort signal; a file changed by someone else in the meantime is left as it
 * is, and a move destination is kept when its source could not be put back.
 * The error names every file whose undo was incomplete or whose state is
 * unknown.
 *
 * Read observations (`fs/observed`) are published for every changed file after
 * the whole patch succeeded; after a failure, only for the files the undo put
 * back, whose state is then known.
 *
 * Writes go through `ctx.fs.writeText`. `ctx.fs` cannot delete, so removals run
 * a constant `rm`/`Remove-Item` command through the session's shell with the
 * path in an environment variable and the call's sandbox policy. A removal
 * stats the file just before the command and compares the version; the check
 * and the command are not atomic, so a change in that window is still lost.
 * Full atomicity would need a versioned delete in `ctx.fs`. Delete File and
 * Move to refuse a symbolic link at the given path, so a link is never followed
 * to remove its target.
 * @module dsh-apply-patch/apply/engine
 */
import { tmpdir } from 'node:os';
import { PatchError } from '../errors.js';
import { applyChunks } from './content.js';
const SHELL_TIMEOUT_MS = 30_000;
const POSIX_REMOVE = 'rm -f -- "$DSH_APPLY_PATCH_TARGET"';
const PWSH_REMOVE = 'Remove-Item -LiteralPath $env:DSH_APPLY_PATCH_TARGET -Force';
/**
 * Resolve and check every operation and compute the new file texts.
 * @param ctx - plugin context with `fs`; `workingDirectory`, `sandboxPolicy` and `shell` are used when present.
 * @param exec - the tool call.
 * @param patch - the parsed patch.
 * @param cfg - resolved configuration.
 * @returns the checked patch.
 * @throws {@link PatchError} for any operation that cannot be applied; nothing has been written.
 */
export async function preparePatch(ctx, exec, patch, cfg) {
    if (patch.ops.length > cfg.maxFiles) {
        throw new PatchError('PATCH_LIMIT', `The patch changes ${patch.ops.length} files; the limit is ${cfg.maxFiles}. Split it into several calls.`);
    }
    const fs = ctx.fs;
    const signal = exec.signal;
    const sandboxPolicy = resolvePolicy(ctx, exec);
    if (sandboxPolicy?.mode === 'read-only') {
        throw new PatchError('PATCH_SANDBOX', '[sandbox: file access denied under read-only mode] This session may not change files.');
    }
    // Removals, and the undo of a created file when another step may fail, run through the shell.
    const needsShell = patch.ops.some(op => op.kind === 'delete' || (op.kind === 'update' && op.moveTo !== undefined))
        || (patch.ops.length > 1 && patch.ops.some(op => op.kind === 'add'));
    if (needsShell && shellOf(ctx) === undefined) {
        throw new PatchError('PATCH_UNSUPPORTED', 'Delete File, Move to, and Add File together with other changes need a shell in this session (files are removed through it, also to undo a failed patch), and none is available. Put each new file in its own call, and delete or move files another way.');
    }
    const cwd = await workingDirectory(ctx, exec);
    const at = cwd === undefined ? {} : { cwd };
    const seen = new Map();
    const resolve = async (path) => {
        const target = await fsCall(() => fs.resolve(path, { ...at, signal }), path);
        const key = foldKey(String(target.targetKey));
        const other = seen.get(key);
        if (other !== undefined)
            throw new PatchError('PATCH_CONFLICT', `"${path}" and "${other}" are the same file; change each file once per patch.`);
        seen.set(key, path);
        return target;
    };
    /** A path to create must not exist, not even as a dangling symbolic link. */
    const absent = async (path, target) => await fsCall(() => fs.stat(target, signal), path) === undefined && await fsCall(() => fs.lstat(path, at, signal), path) === undefined;
    /** A path to delete or move must not be a symbolic link and must be removable under the sandbox policy. */
    const removable = async (path, target, verb) => {
        if ((await fsCall(() => fs.lstat(path, at, signal), path))?.type === 'symlink') {
            throw new PatchError('PATCH_UNSUPPORTED', `Cannot ${verb} "${path}": it is a symbolic link, and apply_patch does not delete or move links. Use the shell to change the link itself.`);
        }
        await checkRemovalSandbox(fs, sandboxPolicy, target, path);
    };
    const files = [];
    const writes = [];
    const removes = [];
    for (const op of patch.ops) {
        const target = await resolve(op.path);
        if (op.kind === 'add') {
            if (!await absent(op.path, target))
                throw new PatchError('PATCH_CONFLICT', `Cannot add "${op.path}": it already exists. Read it and use "*** Update File:", or delete it first.`);
            writes.push({ kind: 'write', target, path: op.path, guard: { kind: 'createIfAbsent' }, before: null, after: op.content });
            files.push({ path: op.path, action: 'added', before: null, after: op.content });
            continue;
        }
        const info = await fsCall(() => fs.stat(target, signal), op.path);
        if (info === undefined)
            throw new PatchError('PATCH_CONFLICT', `Cannot ${op.kind} "${op.path}": the file does not exist.`);
        if (info.type !== 'file')
            throw new PatchError('PATCH_CONFLICT', `Cannot ${op.kind} "${op.path}": it is not a regular file.`);
        if (op.kind === 'delete' || op.moveTo !== undefined)
            await removable(op.path, target, op.kind === 'delete' ? 'delete' : 'move');
        const guard = await writeGuard(ctx, exec, target, info.version, op.path);
        if (op.kind === 'delete') {
            const before = await readTextIfText(fs, target, signal);
            removes.push({ kind: 'remove', target, path: op.path, version: guard.version, before });
            files.push({ path: op.path, action: 'deleted', before, after: null });
            continue;
        }
        const before = await fsCall(() => fs.readText(target, signal), op.path);
        const after = op.chunks.length === 0 ? before : applyChunks(op.path, before, op.chunks, patch.format);
        if (op.moveTo === undefined) {
            if (after !== before)
                writes.push({ kind: 'write', target, path: op.path, guard, before, after });
            files.push({ path: op.path, action: 'modified', before, after });
            continue;
        }
        const destination = await resolve(op.moveTo);
        if (!await absent(op.moveTo, destination)) {
            throw new PatchError('PATCH_CONFLICT', `Cannot move "${op.path}" to "${op.moveTo}": the destination already exists.`);
        }
        writes.push({ kind: 'write', target: destination, path: op.moveTo, guard: { kind: 'createIfAbsent' }, before: null, after, source: op.path });
        removes.push({ kind: 'remove', target, path: op.path, version: guard.version, before });
        files.push({ path: op.moveTo, from: op.path, action: 'modified', before, after });
    }
    return { files, steps: [...writes, ...removes], sandboxPolicy };
}
/**
 * Perform the checked steps; on failure undo the steps already done.
 * @param ctx - plugin context.
 * @param exec - the tool call.
 * @param prepared - the checked patch.
 * @throws {@link PatchError} naming the failed step, the files whose undo was incomplete and the files in an unknown state.
 */
export async function commitPatch(ctx, exec, prepared) {
    const fs = ctx.fs;
    const policy = prepared.sandboxPolicy;
    const done = [];
    for (const step of prepared.steps) {
        let failure;
        let unknown;
        if (step.kind === 'write') {
            try {
                const outcome = await fs.writeText(step.target, step.after, step.guard, exec.signal, policy);
                done.push({ step, version: outcome.version });
                continue;
            }
            catch (error) {
                failure = toPatchError(error, step.path, policy);
            }
        }
        else {
            const removal = await removeGuarded(ctx, step.target, step.version, exec.signal, policy);
            if (removal.kind === 'removed') {
                done.push({ step });
                continue;
            }
            failure = removal.kind === 'changed'
                ? new PatchError('PATCH_STALE', `"${step.path}" ${removal.gone ? 'disappeared' : 'changed, so it was not removed,'} while the patch was being applied. Read it again and retry.`)
                : removal.kind === 'kept'
                    ? new PatchError(removal.code, `Removing "${step.path}" failed: ${removal.reason}`)
                    : new PatchError('PATCH_IO', `Removing "${step.path}" failed: ${removal.reason}`);
            if (removal.kind === 'unknown')
                unknown = step.path;
        }
        const undo = await rollback(ctx, exec, done, policy, unknown);
        const lines = [failure.message];
        if (unknown !== undefined)
            lines.push(`The state of "${unknown}" is unknown; check it before retrying.`);
        if (done.length === 0) {
            if (unknown === undefined)
                lines.push('No file had been changed.');
        }
        else if (undo.length === 0) {
            lines.push(`The ${done.length} earlier change(s) of this patch were undone.`);
        }
        else {
            lines.push('Undoing the earlier changes of this patch was incomplete:', ...undo.map(note => `- ${note}`), 'Check these files before retrying.');
        }
        throw new PatchError(failure.code, lines.join('\n'), { cause: failure });
    }
    for (const { step, version } of done) {
        observe(ctx, exec, step.target, step.kind === 'write' && version !== undefined ? { kind: 'present', version } : { kind: 'absent' });
    }
}
/**
 * Undo done steps in reverse order, without the call's abort signal, and
 * publish observations for the files put back.
 * @param unknownSource - path of a removal whose outcome is unknown; a move destination of it is kept.
 * @returns one note per file whose undo was incomplete.
 */
async function rollback(ctx, exec, done, policy, unknownSource) {
    const fs = ctx.fs;
    const notes = [];
    const unrestored = new Set(unknownSource === undefined ? [] : [unknownSource]);
    const restore = async (step, text, guard) => {
        try {
            const outcome = await fs.writeText(step.target, text, guard, undefined, policy);
            observe(ctx, exec, step.target, { kind: 'present', version: outcome.version });
            return true;
        }
        catch (error) {
            notes.push(guard.kind === 'replaceIfVersion' && error.code === 'FS_STALE_VERSION'
                ? `"${step.path}" was changed after this patch wrote it; it was left as it is.`
                : `"${step.path}" could not be restored: ${describe(error)}`);
            return false;
        }
    };
    for (const { step, version } of [...done].reverse()) {
        if (step.kind === 'remove') {
            if (step.before === null)
                notes.push(`"${step.path}" was deleted and cannot be restored: it is not a text file.`);
            if (step.before === null || !await restore(step, step.before, { kind: 'createIfAbsent' }))
                unrestored.add(step.path);
            continue;
        }
        if (version === undefined)
            continue;
        if (step.before !== null) {
            await restore(step, step.before, { kind: 'replaceIfVersion', version });
            continue;
        }
        if (step.source !== undefined && unrestored.has(step.source)) {
            notes.push(`The moved file is kept at "${step.path}".`);
            continue;
        }
        const removal = await removeGuarded(ctx, step.target, version, undefined, policy);
        switch (removal.kind) {
            case 'removed':
                observe(ctx, exec, step.target, { kind: 'absent' });
                break;
            case 'changed':
                if (removal.gone)
                    break;
                notes.push(`"${step.path}" was changed after this patch wrote it; it was left as it is.`);
                break;
            case 'kept':
                notes.push(`"${step.path}" was created by this patch and could not be removed: ${removal.reason}`);
                break;
            case 'unknown':
                notes.push(`"${step.path}" was created by this patch; whether removing it succeeded is unknown: ${removal.reason}`);
                break;
        }
    }
    return notes;
}
/** The guard for changing an existing file, enforcing the read-before-write policy now instead of at write time. */
async function writeGuard(ctx, exec, target, current, path) {
    const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined);
    if (intent?.kind === 'createIfAbsent') {
        throw new PatchError('PATCH_NOT_OBSERVED', `Read "${path}" with the read tool before changing it; this session has not read it yet.`);
    }
    if (intent?.kind === 'replaceIfVersion' && intent.version !== current) {
        throw new PatchError('PATCH_STALE', `"${path}" changed after this session read it. Read it again and rebuild the change from its current lines.`);
    }
    return { kind: 'replaceIfVersion', version: current };
}
/**
 * In `workspace-write` mode, refuse removing a file outside the workspace and
 * the temp directories, the roots the DSH fs sandbox allows writing. The shell
 * that performs the removal may not confine it itself.
 */
async function checkRemovalSandbox(fs, policy, target, path) {
    if (policy?.mode !== 'workspace-write')
        return;
    const roots = process.platform === 'win32' ? [policy.workspaceRoot, tmpdir()] : [policy.workspaceRoot, '/tmp', tmpdir()];
    for (const root of roots) {
        try {
            if (fs.contains(await fs.resolve(root), target))
                return;
        }
        catch {
            // A root that cannot be resolved contains nothing.
        }
    }
    throw new PatchError('PATCH_SANDBOX', `[sandbox: file access denied under workspace-write mode] Cannot remove "${path}": it is outside the workspace ${policy.workspaceRoot}.`);
}
/**
 * Remove `target` through the shell if it is still at `version`, then stat it
 * again to learn the outcome: gone means removed; still at `version` means
 * kept; a different file at the path means removed when the command succeeded
 * (someone created a new file there since) and unknown otherwise.
 */
async function removeGuarded(ctx, target, version, signal, policy) {
    const fs = ctx.fs;
    try {
        const now = await fs.stat(target);
        if (now?.version !== version)
            return { kind: 'changed', gone: now === undefined };
    }
    catch (error) {
        return { kind: 'kept', code: 'PATCH_IO', reason: `checking the file failed: ${describe(error)}` };
    }
    const shell = shellOf(ctx);
    if (shell === undefined)
        return { kind: 'kept', code: 'PATCH_UNSUPPORTED', reason: 'no shell is available to remove files.' };
    const request = {
        command: process.platform === 'win32' ? PWSH_REMOVE : POSIX_REMOVE,
        env: { DSH_APPLY_PATCH_TARGET: fs.processPath(target) },
        timeoutMs: SHELL_TIMEOUT_MS,
        ...signal === undefined ? {} : { signal },
        ...policy === undefined ? {} : { sandboxPolicy: policy },
    };
    let code = 'PATCH_IO';
    let reason = '';
    let clean = false;
    try {
        const result = await (await shell.execute(shell.resolve(request))).result();
        const tail = result.stderr.text.trim().split('\n').at(-1)?.slice(0, 200) ?? '';
        if (result.sandbox?.denied === true) {
            code = 'PATCH_SANDBOX';
            reason = `[sandbox: file access denied under ${result.sandbox.mode ?? policy?.mode ?? 'unknown'} mode]`;
        }
        else if (!result.aborted && result.exitCode === 0) {
            clean = true;
        }
        else {
            reason = `${result.aborted ? 'the command was aborted' : `the command exited with code ${result.exitCode ?? 'none'}`}${tail === '' ? '' : `: ${tail}`}`;
        }
    }
    catch (error) {
        reason = `the command failed: ${describe(error)}`;
    }
    let after;
    try {
        after = await fs.stat(target);
    }
    catch (error) {
        return { kind: 'unknown', reason: `${clean ? 'the command succeeded' : reason}; checking the file afterwards failed: ${describe(error)}` };
    }
    if (after === undefined)
        return { kind: 'removed' };
    if (after.version === version)
        return { kind: 'kept', code, reason: clean ? 'the file is still there.' : reason };
    // Another file is at the path now: it replaced ours after a successful removal, or during a failed one.
    return clean ? { kind: 'removed' } : { kind: 'unknown', reason: `${reason}; the file has changed since` };
}
function observe(ctx, exec, target, observation) {
    ctx.emit('fs/observed', target, observation, exec);
}
function shellOf(ctx) {
    return ctx.get('shell');
}
function resolvePolicy(ctx, exec) {
    const service = ctx.get('sandboxPolicy');
    if (service === undefined)
        return undefined;
    return exec.agent === undefined ? service.resolve() : service.resolve({ session: exec.agent.session });
}
async function workingDirectory(ctx, exec) {
    if (exec.agent === undefined)
        return undefined;
    const service = ctx.get('workingDirectory');
    if (service !== undefined)
        return service.ensure(exec.agent, exec.signal);
    return exec.agent.session.header.cwd;
}
/** Case- and Unicode-insensitive key on file systems that are usually case-insensitive. */
function foldKey(key) {
    return process.platform === 'darwin' || process.platform === 'win32' ? key.normalize('NFC').toLowerCase() : key;
}
async function readTextIfText(fs, target, signal) {
    try {
        return await fs.readText(target, signal);
    }
    catch {
        // A binary or unreadable file is still removable; it just cannot be restored.
        return null;
    }
}
function describe(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Run one filesystem call, mapping its failure to a {@link PatchError}. */
async function fsCall(call, path) {
    try {
        return await call();
    }
    catch (error) {
        throw toPatchError(error, path, undefined);
    }
}
function toPatchError(error, path, policy) {
    if (error instanceof PatchError)
        return error;
    const code = error?.code;
    const message = describe(error);
    switch (code) {
        case 'FS_NOT_OBSERVED':
            return new PatchError('PATCH_NOT_OBSERVED', `Read "${path}" with the read tool before changing it.`, { cause: error });
        case 'FS_STALE_VERSION':
            return new PatchError('PATCH_STALE', `"${path}" changed while the patch was being applied. Read it again and retry.`, { cause: error });
        case 'FS_SANDBOX_DENIED':
        case 'FS_PERMISSION_DENIED':
            return new PatchError('PATCH_SANDBOX', `[sandbox: file access denied under ${policy?.mode ?? 'the current'} mode] Cannot write "${path}": ${message}`, { cause: error });
        case 'FS_NOT_FOUND':
        case 'FS_NOT_DIRECTORY':
            return new PatchError('PATCH_CONFLICT', `"${path}": ${message}`, { cause: error });
        default:
            return new PatchError('PATCH_IO', `"${path}": ${message}`, { cause: error });
    }
}
