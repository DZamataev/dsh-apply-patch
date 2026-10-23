/**
 * Planning, checking and committing a parsed patch.
 *
 * `preparePatch` resolves every path, checks the files against the patch and
 * against the session's read-before-write policy, and computes every new file
 * text. Nothing is written until all of that succeeds, so a dry run reports
 * the same failures a real run would.
 *
 * `commitPatch` performs the writes first and the removals last. When one step
 * fails, the steps already done are undone in reverse order (rewrites restore
 * the old text, created files are removed, removed text files are recreated),
 * and the error names anything that could not be restored. Read observations
 * (`fs/observed`) are published only after the whole patch succeeded.
 *
 * Writes go through `ctx.fs.writeText` with a version guard, like the native
 * `write` tool. `ctx.fs` cannot delete, so Delete File and the source side of
 * Move to run a constant `rm`/`Remove-Item` command through the session's shell
 * with the path in an environment variable and the call's sandbox policy.
 * @module dsh-apply-patch/apply/engine
 */
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
    const sandboxPolicy = resolvePolicy(ctx, exec);
    if (sandboxPolicy?.mode === 'read-only') {
        throw new PatchError('PATCH_SANDBOX', '[sandbox: file access denied under read-only mode] This session may not change files.');
    }
    if (patch.ops.some(op => op.kind === 'delete' || (op.kind === 'update' && op.moveTo !== undefined)) && shellOf(ctx) === undefined) {
        throw new PatchError('PATCH_UNSUPPORTED', 'Delete File and Move to need a shell in this session, and none is available. Delete or move the file another way.');
    }
    const cwd = await workingDirectory(ctx, exec);
    const seen = new Map();
    const resolve = async (path) => {
        const target = await fsCall(() => fs.resolve(path, { ...cwd === undefined ? {} : { cwd }, signal: exec.signal }), path);
        const key = foldKey(String(target.targetKey));
        const other = seen.get(key);
        if (other !== undefined)
            throw new PatchError('PATCH_CONFLICT', `"${path}" and "${other}" are the same file; change each file once per patch.`);
        seen.set(key, path);
        return target;
    };
    const files = [];
    const writes = [];
    const removes = [];
    for (const op of patch.ops) {
        const target = await resolve(op.path);
        const info = await fsCall(() => fs.stat(target, exec.signal), op.path);
        if (op.kind === 'add') {
            if (info !== undefined)
                throw new PatchError('PATCH_CONFLICT', `Cannot add "${op.path}": it already exists. Read it and use "*** Update File:", or delete it first.`);
            writes.push({ kind: 'write', target, guard: { kind: 'createIfAbsent' }, before: null, after: op.content });
            files.push({ path: op.path, action: 'added', before: null, after: op.content });
            continue;
        }
        if (info === undefined)
            throw new PatchError('PATCH_CONFLICT', `Cannot ${op.kind} "${op.path}": the file does not exist.`);
        if (info.type !== 'file')
            throw new PatchError('PATCH_CONFLICT', `Cannot ${op.kind} "${op.path}": it is not a regular file.`);
        if (op.kind === 'delete') {
            const before = await readTextIfText(fs, target, exec.signal);
            removes.push({ kind: 'remove', target, before });
            files.push({ path: op.path, action: 'deleted', before, after: null });
            continue;
        }
        const guard = await writeGuard(ctx, exec, target, info.version, op.path);
        const before = await fsCall(() => fs.readText(target, exec.signal), op.path);
        const after = op.chunks.length === 0 ? before : applyChunks(op.path, before, op.chunks, patch.format);
        if (op.moveTo === undefined) {
            if (after !== before)
                writes.push({ kind: 'write', target, guard, before, after });
            files.push({ path: op.path, action: 'modified', before, after });
            continue;
        }
        const destination = await resolve(op.moveTo);
        if (await fsCall(() => fs.stat(destination, exec.signal), op.moveTo) !== undefined) {
            throw new PatchError('PATCH_CONFLICT', `Cannot move "${op.path}" to "${op.moveTo}": the destination already exists.`);
        }
        writes.push({ kind: 'write', target: destination, guard: { kind: 'createIfAbsent' }, before: null, after });
        removes.push({ kind: 'remove', target, before });
        files.push({ path: op.moveTo, from: op.path, action: 'modified', before, after });
    }
    return { files, steps: [...writes, ...removes], sandboxPolicy };
}
/**
 * Perform the checked steps; on failure undo the steps already done.
 * @param ctx - plugin context.
 * @param exec - the tool call.
 * @param prepared - the checked patch.
 * @throws {@link PatchError} naming the failed step and anything that could not be restored.
 */
export async function commitPatch(ctx, exec, prepared) {
    const fs = ctx.fs;
    const policy = prepared.sandboxPolicy;
    const done = [];
    for (const step of prepared.steps) {
        try {
            if (step.kind === 'write') {
                const outcome = await fs.writeText(step.target, step.after, step.guard, exec.signal, policy);
                done.push({ step, version: outcome.version });
            }
            else {
                await removeFile(ctx, exec, step.target, policy);
                done.push({ step });
            }
        }
        catch (error) {
            const failure = toPatchError(error, step.target.displayPath, policy);
            const lost = await rollback(ctx, exec, done, policy);
            const undo = done.length === 0
                ? 'Nothing had been changed.'
                : lost.length === 0
                    ? `The ${done.length} earlier change(s) of this patch were undone.`
                    : `Undoing the earlier changes failed for: ${lost.join(', ')}. Check these files before retrying.`;
            throw new PatchError(failure.code, `${failure.message}\n${undo}`, { cause: error });
        }
    }
    for (const { step, version } of done) {
        if (step.kind === 'write' && version !== undefined)
            ctx.emit('fs/observed', step.target, { kind: 'present', version }, exec);
        else if (step.kind === 'remove')
            ctx.emit('fs/observed', step.target, { kind: 'absent' }, exec);
    }
}
/** Undo done steps in reverse order; returns the display paths that could not be restored. */
async function rollback(ctx, exec, done, policy) {
    const fs = ctx.fs;
    const lost = [];
    for (const { step, version } of [...done].reverse()) {
        try {
            if (step.kind === 'write' && step.before === null)
                await removeFile(ctx, exec, step.target, policy);
            else if (step.kind === 'write' && version !== undefined)
                await fs.writeText(step.target, step.before, { kind: 'replaceIfVersion', version }, undefined, policy);
            else if (step.kind === 'remove' && step.before !== null)
                await fs.writeText(step.target, step.before, { kind: 'createIfAbsent' }, undefined, policy);
            else
                lost.push(step.target.displayPath);
        }
        catch {
            // The step stays changed; the caller reports the path.
            lost.push(step.target.displayPath);
        }
    }
    return lost;
}
/** The guard for rewriting an existing file, enforcing the read-before-write policy now instead of at write time. */
async function writeGuard(ctx, exec, target, current, path) {
    const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined);
    if (intent?.kind === 'createIfAbsent') {
        throw new PatchError('PATCH_NOT_OBSERVED', `Read "${path}" with the read tool before changing it; this session has not read it yet.`);
    }
    if (intent?.kind === 'replaceIfVersion' && intent.version !== current) {
        throw new PatchError('PATCH_STALE', `"${path}" changed after this session read it. Read it again and rebuild the change from its current lines.`);
    }
    return intent ?? { kind: 'replaceIfVersion', version: current };
}
async function removeFile(ctx, exec, target, policy) {
    const shell = shellOf(ctx);
    if (shell === undefined)
        throw new PatchError('PATCH_UNSUPPORTED', 'No shell is available to remove files.');
    const request = {
        command: process.platform === 'win32' ? PWSH_REMOVE : POSIX_REMOVE,
        env: { DSH_APPLY_PATCH_TARGET: ctx.fs.processPath(target) },
        signal: exec.signal,
        timeoutMs: SHELL_TIMEOUT_MS,
        ...policy === undefined ? {} : { sandboxPolicy: policy },
    };
    const result = await (await shell.execute(shell.resolve(request))).result();
    if (result.sandbox?.denied === true) {
        throw new PatchError('PATCH_SANDBOX', `[sandbox: file access denied under ${result.sandbox.mode ?? policy?.mode ?? 'unknown'} mode] Cannot remove "${target.displayPath}".`);
    }
    if (result.aborted || result.exitCode !== 0) {
        const tail = result.stderr.text.trim().split('\n').at(-1)?.slice(0, 200) ?? '';
        throw new PatchError('PATCH_IO', `Removing "${target.displayPath}" failed${result.aborted ? ' (aborted)' : ` with exit code ${result.exitCode ?? 'none'}`}${tail === '' ? '' : `: ${tail}`}`);
    }
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
    const message = error instanceof Error ? error.message : String(error);
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
