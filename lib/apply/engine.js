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
 * `commitPatch` performs the steps in patch order: writes of updated and added
 * files, moves, and deletions. Every step is guarded by the version the patch
 * expects: the version checked while preparing for existing files, the version
 * our own step left for files the patch created or moved. When one step fails,
 * the steps already done are undone in reverse order with the same guards and
 * without the call's abort signal; a file changed by someone else in the
 * meantime is left as it is. The error names every file whose undo was
 * incomplete or whose state is unknown.
 *
 * Writes go through `ctx.fs.writeText`. `ctx.fs` cannot rename or delete, so
 * moves and deletions use one constant POSIX shell command ({@link RELINK})
 * run through the session's shell with the paths in environment variables and
 * the call's sandbox policy. It gives the file a new name with a hard link,
 * which never replaces an existing file, and then removes the old name if it
 * still names the same file. The file keeps its inode, permission bits
 * (including setuid, setgid and sticky), and bytes.
 *
 * - Move to: the source is relinked to the destination (missing parent
 *   directories are created first). With changes, the new text is then written
 *   to the destination, guarded by the version the move left.
 * - Delete File: the file is relinked into a private staging directory next to
 *   it (`.dsh-apply-patch-trash-<random>`, mode 700). The staging directories
 *   are removed only after the whole patch succeeded; an undo relinks the file
 *   back, so any file, binary included, is restored byte for byte with its mode.
 * - Undoing an added file relinks it into staging too, and staging is removed
 *   after the undo; undoing a move relinks the destination back to the source.
 *
 * Each relink stats the old name just before the command and runs only if it is
 * still the expected version, then stats both names to learn the outcome,
 * whatever the shell reported. The check and the command are not atomic; see
 * the threat model in the README.
 *
 * Read observations (`fs/observed`) are published for every changed file after
 * the whole patch succeeded; after a failure, only for the files the undo put
 * back, whose state is then known.
 * @module dsh-apply-patch/apply/engine
 */
import { randomBytes } from 'node:crypto';
import { posix } from 'node:path';
import { tmpdir } from 'node:os';
import { PatchError } from '../errors.js';
import { applyToFile } from './content.js';
const SHELL_TIMEOUT_MS = 30_000;
const POSIX = process.platform !== 'win32';
const STAGING_PREFIX = '.dsh-apply-patch-trash-';
/**
 * Give `$DSH_APPLY_PATCH_FROM` the name `$DSH_APPLY_PATCH_TO` without replacing
 * anything. `$DSH_APPLY_PATCH_MKDIR` is `parents` (create the new name's
 * missing parent directories), `private` (create its parent, which must not
 * exist, with mode 700) or empty. The link is made with `ln`, which fails on an
 * existing name; the old name is removed only while it still names the linked
 * file, and the new name is removed again when that removal fails. Exit codes:
 * 90 directory, 91 old name not a regular file, 92 new name exists, 93 link
 * failed, 94 old name replaced after linking, 95 old name not removed.
 */
const RELINK = [
    'f=$DSH_APPLY_PATCH_FROM; t=$DSH_APPLY_PATCH_TO',
    'case "$DSH_APPLY_PATCH_MKDIR" in',
    'parents) mkdir -p -- "${t%/*}" || exit 90 ;;',
    'private) mkdir -m 700 -- "${t%/*}" || exit 90 ;;',
    'esac',
    '[ -f "$f" ] && [ ! -L "$f" ] || exit 91',
    '[ -e "$t" ] || [ -L "$t" ] && exit 92',
    'ln -- "$f" "$t" || exit 93',
    '[ "$f" -ef "$t" ] || exit 94',
    'rm -f -- "$f" && exit 0',
    '[ "$f" -ef "$t" ] && rm -f -- "$t"',
    'exit 95',
].join('\n');
/** Remove the staging directory `$DSH_APPLY_PATCH_TO` with its files. */
const DISCARD_DIR = 'rm -rf -- "$DSH_APPLY_PATCH_TO"';
/** Remove the staged file `$DSH_APPLY_PATCH_TO`. */
const DISCARD_FILE = 'rm -f -- "$DSH_APPLY_PATCH_TO"';
const RELINK_FAILURES = {
    90: 'its directory could not be created',
    91: 'it is no longer a regular file',
    92: 'the new name exists',
    93: 'the link could not be made',
    95: 'the old name could not be removed',
};
/**
 * Staging directories, one per parent directory of a staged file, created by
 * the first relink into them.
 */
class Staging {
    fs;
    policy;
    dirs = new Map();
    constructor(fs, policy) {
        this.fs = fs;
        this.policy = policy;
    }
    /**
     * A fresh name in the staging directory next to `target`.
     * @throws {@link PatchError} when the name is outside what the sandbox allows.
     */
    async slot(target, signal) {
        const parent = posix.dirname(this.fs.processPath(target));
        let dir = this.dirs.get(parent);
        if (dir === undefined) {
            const path = posix.join(parent, `${STAGING_PREFIX}${randomBytes(8).toString('hex')}`);
            dir = { path, target: await fsCall(() => this.fs.resolve(path, { signal }), path), made: false, slots: 0 };
            this.dirs.set(parent, dir);
        }
        const path = posix.join(dir.path, String(dir.slots));
        dir.slots += 1;
        const staged = await fsCall(() => this.fs.resolve(path, { signal }), path);
        await checkShellSandbox(this.fs, this.policy, staged, path, 'stage');
        return { place: { target: staged, path }, dir };
    }
}
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
    // Moves, deletions, and the undo of a created file when another step may fail, run through a POSIX shell.
    const needsShell = patch.ops.some(op => op.kind === 'delete' || (op.kind === 'update' && op.moveTo !== undefined))
        || (patch.ops.length > 1 && patch.ops.some(op => op.kind === 'add'));
    if (needsShell && (shellOf(ctx) === undefined || !POSIX)) {
        const why = POSIX ? 'none is available' : 'there is none on Windows';
        throw new PatchError('PATCH_UNSUPPORTED', `Delete File, Move to, and Add File together with other changes need a POSIX shell in this session (files are moved and removed through it, also to undo a failed patch), and ${why}. Put each new file in its own call, and delete or move files another way.`);
    }
    const staging = new Staging(fs, sandboxPolicy);
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
    /** A path to delete or move must not be a symbolic link and must be changeable under the sandbox policy. */
    const removable = async (path, target, verb) => {
        if ((await fsCall(() => fs.lstat(path, at, signal), path))?.type === 'symlink') {
            throw new PatchError('PATCH_UNSUPPORTED', `Cannot ${verb} "${path}": it is a symbolic link, and apply_patch does not delete or move links. Use the shell to change the link itself.`);
        }
        await checkShellSandbox(fs, sandboxPolicy, target, path, verb);
    };
    const files = [];
    const writes = [];
    const moves = [];
    const deletes = [];
    for (const op of patch.ops) {
        const target = await resolve(op.path);
        const place = { target, path: op.path };
        if (op.kind === 'add') {
            if (!await absent(op.path, target))
                throw new PatchError('PATCH_CONFLICT', `Cannot add "${op.path}": it already exists. Read it and use "*** Update File:", or delete it first.`);
            writes.push({ kind: 'write', place, guard: { kind: 'createIfAbsent' }, before: null, after: op.content });
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
            const before = op.chunks === undefined ? await readTextIfText(fs, target, signal) : await fsCall(() => readWhole(fs, target, signal), op.path);
            if (op.chunks !== undefined && before !== null && !['', BOM].includes(applyToFile(op.path, before, op.chunks, 'unified'))) {
                throw new PatchError('PATCH_CONFLICT', `The diff deletes "${op.path}", but its hunks do not remove the whole file. Read the file again and list every line of it as removed.`);
            }
            deletes.push({ kind: 'delete', place, version: guard.version, staged: await staging.slot(target, signal) });
            files.push({ path: op.path, action: 'deleted', before, after: null });
            continue;
        }
        const before = await fsCall(() => readWhole(fs, target, signal), op.path);
        const after = op.chunks.length === 0 ? before : applyToFile(op.path, before, op.chunks, patch.format);
        if (op.moveTo === undefined) {
            if (after !== before)
                writes.push({ kind: 'write', place, guard, before, after });
            files.push({ path: op.path, action: 'modified', before, after });
            continue;
        }
        const destination = await resolve(op.moveTo);
        if (!await absent(op.moveTo, destination)) {
            throw new PatchError('PATCH_CONFLICT', `Cannot move "${op.path}" to "${op.moveTo}": the destination already exists.`);
        }
        await checkShellSandbox(fs, sandboxPolicy, destination, op.moveTo, 'move a file to');
        moves.push({ kind: 'move', source: place, destination: { target: destination, path: op.moveTo }, version: guard.version, before, after: after === before ? null : after });
        files.push({ path: op.moveTo, from: op.path, action: 'modified', before, after });
    }
    return { files, steps: [...writes, ...moves, ...deletes], sandboxPolicy, staging };
}
/**
 * Perform the checked steps; on failure undo the steps already done.
 * @param ctx - plugin context.
 * @param exec - the tool call.
 * @param prepared - the checked patch.
 * @returns notes on deleted files whose staged copy could not be removed afterwards.
 * @throws {@link PatchError} naming the failed step, the files whose undo was incomplete and the files in an unknown state.
 */
export async function commitPatch(ctx, exec, prepared) {
    const fs = ctx.fs;
    const policy = prepared.sandboxPolicy;
    const signal = exec.signal;
    const done = [];
    for (const step of prepared.steps) {
        let failure;
        const extra = [];
        const kept = new Set();
        if (step.kind === 'write') {
            const written = await write(fs, step.place, step.after, step.guard, signal, policy);
            if (!(written instanceof PatchError)) {
                done.push({ kind: 'write', step, version: written });
                continue;
            }
            failure = written;
        }
        else if (step.kind === 'move') {
            const relinked = await relink(ctx, prepared.staging, step.source, step.destination, step.version, 'parents', signal, policy);
            const moved = relinked.kind === 'done' ? await holding(fs, step.destination.target, step.before) : undefined;
            if (moved !== undefined) {
                if (step.after === null) {
                    done.push({ kind: 'move', step, moved });
                    continue;
                }
                const written = await write(fs, step.destination, step.after, { kind: 'replaceIfVersion', version: moved }, signal, policy);
                if (!(written instanceof PatchError)) {
                    done.push({ kind: 'move', step, moved, written });
                    continue;
                }
                done.push({ kind: 'move', step, moved });
                failure = written;
            }
            else if (relinked.kind === 'done') {
                failure = new PatchError('PATCH_STALE', `"${step.destination.path}" changed right after "${step.source.path}" was moved there, or could not be checked; it was left as it is.`);
                extra.push(`Check "${step.destination.path}" before retrying; "${step.source.path}" no longer exists.`);
            }
            else {
                const moved = relinked;
                failure = relinkFailure(moved, step.source.path, `Moving "${step.source.path}" to "${step.destination.path}"`);
                if (moved.kind === 'split')
                    extra.push(`"${step.destination.path}" holds "${step.source.path}" as this session read it; "${step.source.path}" holds the newer file. Both were kept.`);
                if (moved.kind === 'unknown')
                    extra.push(`The state of "${step.source.path}" and "${step.destination.path}" is unknown; check them before retrying.`);
            }
        }
        else {
            const staged = await relink(ctx, prepared.staging, step.place, step.staged.place, step.version, mkdirFor(step.staged), signal, policy);
            if (staged.kind === 'done') {
                done.push({ kind: 'delete', step, staged: staged.version });
                continue;
            }
            failure = relinkFailure(staged, step.place.path, `Deleting "${step.place.path}"`);
            if (staged.kind === 'split')
                extra.push(`"${step.place.path}" was kept; the version this session read is kept at "${step.staged.place.path}".`);
            if (staged.kind === 'unknown')
                extra.push(`The state of "${step.place.path}" is unknown; check it, and "${step.staged.place.path}", before retrying.`);
            if (staged.kind === 'split' || staged.kind === 'unknown')
                kept.add(step.staged);
        }
        const undo = await rollback(ctx, exec, prepared.staging, done, kept, policy);
        const lines = [failure.message, ...extra];
        if (done.length === 0) {
            if (extra.length === 0)
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
    const notes = await clearStaging(ctx, prepared.staging, new Set(), undefined, policy);
    for (const entry of done) {
        switch (entry.kind) {
            case 'write':
                observe(ctx, exec, entry.step.place.target, { kind: 'present', version: entry.version });
                break;
            case 'move':
                observe(ctx, exec, entry.step.source.target, { kind: 'absent' });
                observe(ctx, exec, entry.step.destination.target, { kind: 'present', version: entry.written ?? entry.moved });
                break;
            case 'delete':
                observe(ctx, exec, entry.step.place.target, { kind: 'absent' });
                break;
        }
    }
    return notes;
}
/**
 * Undo done steps in reverse order, without the call's abort signal, publish
 * observations for the files put back, and remove the staging directories
 * except for the staged files in `kept` or that could not be put back.
 * @returns one note per file whose undo was incomplete.
 */
async function rollback(ctx, exec, staging, done, kept, policy) {
    const fs = ctx.fs;
    const notes = [];
    const discard = new Set();
    const changedNote = (path) => `"${path}" was changed after this patch wrote it; it was left as it is.`;
    /** Write `text` back over our version; the new version, or undefined with a note. */
    const restoreText = async (place, text, version) => {
        const restored = await write(fs, place, text, { kind: 'replaceIfVersion', version }, undefined, policy);
        if (!(restored instanceof PatchError))
            return restored;
        notes.push(restored.code === 'PATCH_STALE' ? changedNote(place.path) : `"${place.path}" could not be restored: ${restored.message}`);
        return undefined;
    };
    for (const entry of [...done].reverse()) {
        switch (entry.kind) {
            case 'write': {
                const { place, before } = entry.step;
                if (before !== null) {
                    const version = await restoreText(place, before, entry.version);
                    if (version !== undefined)
                        observe(ctx, exec, place.target, { kind: 'present', version });
                    break;
                }
                const slot = await staging.slot(place.target).catch((error) => toPatchError(error, place.path, policy));
                if (slot instanceof PatchError) {
                    notes.push(`"${place.path}" was created by this patch and could not be removed: ${slot.message}`);
                    break;
                }
                const removed = await relink(ctx, staging, place, slot.place, entry.version, mkdirFor(slot), undefined, policy);
                if (removed.kind === 'done') {
                    discard.add(slot);
                    if (!removed.fromBack)
                        observe(ctx, exec, place.target, { kind: 'absent' });
                    break;
                }
                if (removed.kind === 'split')
                    kept.add(slot);
                notes.push(removed.kind === 'changed'
                    ? removed.gone ? `"${place.path}" was created by this patch and has been removed by someone else.` : changedNote(place.path)
                    : removed.kind === 'split'
                        ? `"${place.path}" was changed while it was being removed; the newer file is at "${place.path}", the one this patch created at "${slot.place.path}".`
                        : `"${place.path}" was created by this patch and could not be removed: ${relinkReason(removed)}`);
                break;
            }
            case 'move': {
                const { source, destination, before } = entry.step;
                let version = entry.moved;
                if (entry.written !== undefined)
                    version = await restoreText(destination, before, entry.written);
                if (version === undefined) {
                    notes.push(`The moved file is kept at "${destination.path}".`);
                    break;
                }
                const back = await relink(ctx, staging, destination, source, version, '', undefined, policy);
                if (back.kind === 'done') {
                    const restored = await holding(fs, source.target, before);
                    if (restored !== undefined)
                        observe(ctx, exec, source.target, { kind: 'present', version: restored });
                    if (!back.fromBack)
                        observe(ctx, exec, destination.target, { kind: 'absent' });
                    break;
                }
                notes.push(back.kind === 'occupied'
                    ? `"${source.path}" was created again by someone else, so the moved file is kept at "${destination.path}".`
                    : back.kind === 'changed'
                        ? back.gone ? `The moved file at "${destination.path}" has been removed by someone else.` : `"${destination.path}" was changed after this patch moved "${source.path}" there; it was left as it is, and "${source.path}" was not put back.`
                        : back.kind === 'split'
                            ? `"${destination.path}" was changed while it was being moved back; the moved file is at "${source.path}", the newer one at "${destination.path}".`
                            : `The moved file could not be moved back from "${destination.path}" to "${source.path}": ${relinkReason(back)}`);
                break;
            }
            case 'delete': {
                const { place, staged } = entry.step;
                const back = await relink(ctx, staging, staged.place, place, entry.staged, '', undefined, policy);
                if (back.kind === 'done') {
                    observe(ctx, exec, place.target, { kind: 'present', version: back.version });
                    break;
                }
                kept.add(staged);
                notes.push(back.kind === 'occupied'
                    ? `"${place.path}" was created again by someone else; the deleted file is kept at "${staged.place.path}".`
                    : `"${place.path}" could not be restored (${relinkReason(back)}); the deleted file is kept at "${staged.place.path}".`);
                break;
            }
        }
    }
    notes.push(...await clearStaging(ctx, staging, kept, discard, policy));
    return notes;
}
/**
 * Remove the staging directories made, keeping the slots in `kept`: a
 * directory with a kept slot loses only its slots in `discard` (all others
 * after a successful patch, where `discard` is undefined).
 * @returns notes on staged files that could not be removed.
 */
async function clearStaging(ctx, staging, kept, discard, policy) {
    const fs = ctx.fs;
    const notes = [];
    const keptDirs = new Set([...kept].map(slot => slot.dir));
    for (const dir of staging.dirs.values()) {
        if (!dir.made)
            continue;
        if (!keptDirs.has(dir)) {
            const run = await runShell(ctx, DISCARD_DIR, { DSH_APPLY_PATCH_TO: fs.processPath(dir.target) }, undefined, policy);
            if (!run.clean)
                notes.push(`The staging directory "${dir.path}" could not be removed (${run.reason}); it holds only copies of files this patch deleted or created. Remove it.`);
            continue;
        }
        for (const slot of discard ?? []) {
            if (slot.dir !== dir)
                continue;
            const run = await runShell(ctx, DISCARD_FILE, { DSH_APPLY_PATCH_TO: fs.processPath(slot.place.target) }, undefined, policy);
            if (!run.clean)
                notes.push(`"${slot.place.path}" could not be removed (${run.reason}). Remove it.`);
        }
    }
    return notes;
}
/** The mkdir mode for the first relink into a staging directory. */
function mkdirFor(slot) {
    return slot.dir.made ? '' : 'private';
}
/**
 * Relink `from`, if it is still at `version`, to `to` with {@link RELINK},
 * then stat both names to learn the outcome. A staging directory the command
 * made is recorded in `staging`.
 */
async function relink(ctx, staging, from, to, version, mkdir, signal, policy) {
    const fs = ctx.fs;
    try {
        const now = await fs.stat(from.target);
        if (now?.version !== version)
            return { kind: 'changed', gone: now === undefined };
    }
    catch (error) {
        return { kind: 'failed', code: 'PATCH_IO', reason: `checking "${from.path}" failed: ${describe(error)}` };
    }
    const run = await runShell(ctx, RELINK, {
        DSH_APPLY_PATCH_FROM: fs.processPath(from.target),
        DSH_APPLY_PATCH_TO: fs.processPath(to.target),
        DSH_APPLY_PATCH_MKDIR: mkdir,
    }, signal, policy);
    if (mkdir === 'private') {
        for (const dir of staging.dirs.values()) {
            if (dir.made || fs.processPath(dir.target) !== posix.dirname(fs.processPath(to.target)))
                continue;
            dir.made = await fs.stat(dir.target).then(info => info !== undefined, () => true);
        }
    }
    let source;
    let target;
    try {
        source = await fs.stat(from.target);
        target = await fs.stat(to.target);
    }
    catch (error) {
        return { kind: 'unknown', reason: `${run.clean ? 'the command succeeded' : run.reason}; checking the files afterwards failed: ${describe(error)}` };
    }
    const known = run.exitCode === undefined ? undefined : RELINK_FAILURES[run.exitCode];
    const reason = known === undefined ? run.reason : `${known}${run.tail === '' ? '' : `: ${run.tail}`}`;
    // Exit codes 90 to 93 stop the command before it changes anything.
    switch (run.exitCode) {
        case 90:
        case 93:
            return { kind: 'failed', code: 'PATCH_IO', reason };
        case 91:
            return { kind: 'changed', gone: source === undefined };
        case 92:
            return { kind: 'occupied' };
    }
    if (target === undefined) {
        if (source === undefined)
            return { kind: 'unknown', reason: `${run.clean ? 'the command succeeded' : reason}, but neither name exists now` };
        return { kind: 'failed', code: run.denied ? 'PATCH_SANDBOX' : 'PATCH_IO', reason };
    }
    if (run.clean)
        return { kind: 'done', version: target.version, fromBack: source !== undefined };
    if (source === undefined)
        return { kind: 'done', version: target.version, fromBack: false };
    if (run.exitCode === 94)
        return { kind: 'split' };
    return { kind: 'unknown', reason: `${reason}; both names exist now` };
}
function relinkReason(outcome) {
    switch (outcome.kind) {
        case 'changed': return outcome.gone ? 'it no longer exists' : 'it changed in the meantime';
        case 'occupied': return 'the name is taken';
        case 'split': return 'it changed while being relinked';
        case 'failed':
        case 'unknown': return outcome.reason;
    }
}
/** The error for a failed forward relink of `path`. */
function relinkFailure(outcome, path, action) {
    switch (outcome.kind) {
        case 'changed': return new PatchError('PATCH_STALE', `"${path}" ${outcome.gone ? 'disappeared' : 'changed, so it was not touched,'} while the patch was being applied. Read it again and retry.`);
        case 'occupied': return new PatchError('PATCH_CONFLICT', `${action} failed: the new name was created by someone else in the meantime.`);
        case 'split': return new PatchError('PATCH_STALE', `"${path}" changed while the patch was being applied.`);
        case 'failed': return new PatchError(outcome.code, `${action} failed: ${outcome.reason}`);
        case 'unknown': return new PatchError('PATCH_IO', `${action} failed: ${outcome.reason}`);
    }
}
/**
 * The version of `target` when it holds `text`: stat, read, and stat again
 * agree. A file someone else changed right after this patch moved it is
 * therefore not taken as this patch's (one that holds the same text is).
 * @returns the version, or undefined when the file differs or cannot be checked.
 */
async function holding(fs, target, text) {
    try {
        const first = await fs.stat(target);
        if (first === undefined || await readWhole(fs, target, undefined) !== text)
            return undefined;
        return (await fs.stat(target))?.version === first.version ? first.version : undefined;
    }
    catch {
        // A file that cannot be checked is not taken as this patch's.
        return undefined;
    }
}
/** Guarded `writeText`; the version written, or the failure. */
async function write(fs, place, text, guard, signal, policy) {
    return fs.writeText(place.target, text, guard, signal, policy).then(outcome => outcome.version, (error) => toPatchError(error, place.path, policy));
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
 * In `workspace-write` mode, refuse a shell change of a path outside the
 * workspace and the temp directories, the roots the DSH fs sandbox allows
 * writing. The shell that performs it may not confine it itself.
 */
async function checkShellSandbox(fs, policy, target, path, verb) {
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
    throw new PatchError('PATCH_SANDBOX', `[sandbox: file access denied under workspace-write mode] Cannot ${verb} "${path}": it is outside the workspace ${policy.workspaceRoot}.`);
}
/**
 * Run a constant command with paths in environment variables and the call's sandbox policy.
 * @returns the outcome; a missing shell or a throwing command is reported, not thrown.
 */
async function runShell(ctx, command, env, signal, policy) {
    const shell = shellOf(ctx);
    if (shell === undefined)
        return { clean: false, denied: false, tail: '', reason: 'no shell is available.' };
    const request = {
        command,
        env,
        timeoutMs: SHELL_TIMEOUT_MS,
        ...signal === undefined ? {} : { signal },
        ...policy === undefined ? {} : { sandboxPolicy: policy },
    };
    try {
        const result = await (await shell.execute(shell.resolve(request))).result();
        const tail = result.stderr.text.trim().split('\n').at(-1)?.slice(0, 200) ?? '';
        if (result.sandbox?.denied === true) {
            return { clean: false, denied: true, tail, reason: `[sandbox: file access denied under ${result.sandbox.mode ?? policy?.mode ?? 'unknown'} mode]` };
        }
        if (!result.aborted && result.exitCode === 0)
            return { clean: true, denied: false, exitCode: 0, tail, reason: '' };
        const why = result.aborted ? 'the command was aborted' : `the command exited with code ${result.exitCode ?? 'none'}`;
        return { clean: false, denied: false, ...result.aborted || result.exitCode === null ? {} : { exitCode: result.exitCode }, tail, reason: `${why}${tail === '' ? '' : `: ${tail}`}` };
    }
    catch (error) {
        return { clean: false, denied: false, tail: '', reason: `the command failed: ${describe(error)}` };
    }
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
const BOM = '\uFEFF';
/**
 * The whole text of a file, starting with U+FEFF when the file starts with a
 * UTF-8 byte order mark: `readText` drops the mark, and writing this text back
 * with `writeText` gives the same bytes.
 */
async function readWhole(fs, target, signal) {
    const text = await fs.readText(target, signal);
    const head = await fs.readByteRange(target, { offset: 0, length: 3 }, signal);
    return head.length === 3 && head[0] === 0xEF && head[1] === 0xBB && head[2] === 0xBF ? BOM + text : text;
}
/** The text of a file to delete, for the result's diff; null for a binary or unreadable file, which is deleted all the same. */
async function readTextIfText(fs, target, signal) {
    try {
        return await readWhole(fs, target, signal);
    }
    catch {
        // A binary or unreadable file has no text diff; it is staged and restorable like any other.
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
