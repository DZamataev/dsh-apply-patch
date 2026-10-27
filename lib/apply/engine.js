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
 *   it (`.dsh-apply-patch-trash-<random>`, mode 700, made by this patch's own
 *   `mkdir`; a name that exists already is never used). The staged file must
 *   hold the bytes checked while preparing (SHA-256), or it is put back (or
 *   kept and named) and the patch fails. Staged files are removed only after
 *   the whole patch succeeded, each after checking its bytes again, and then
 *   their empty directory; an undo relinks the file back, so any file, binary
 *   included, is restored byte for byte with its mode.
 * - Undoing an added file relinks it into staging too, verified against the
 *   text written, and removed after the undo; undoing a move relinks the
 *   destination back to the source and checks its text.
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
import { createHash, randomBytes } from 'node:crypto';
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
 * 89 private directory exists, 90 directory not created, 91 old name not a
 * regular file, 92 new name exists, 93 link failed, 94 old name replaced after
 * linking, 95 old name not removed. Any other exit code means this command
 * created the private directory.
 */
const RELINK = [
    'f=$DSH_APPLY_PATCH_FROM; t=$DSH_APPLY_PATCH_TO',
    'case "$DSH_APPLY_PATCH_MKDIR" in',
    'parents) mkdir -p -- "${t%/*}" || exit 90 ;;',
    'private) if [ -e "${t%/*}" ] || [ -L "${t%/*}" ]; then exit 89; fi',
    '  mkdir -m 700 -- "${t%/*}" || exit 90 ;;',
    'esac',
    '[ -f "$f" ] && [ ! -L "$f" ] || exit 91',
    '[ -e "$t" ] || [ -L "$t" ] && exit 92',
    'ln -- "$f" "$t" || exit 93',
    '[ "$f" -ef "$t" ] || exit 94',
    'rm -f -- "$f" && exit 0',
    '[ "$f" -ef "$t" ] && rm -f -- "$t"',
    'exit 95',
].join('\n');
/** Remove the staging directory `$DSH_APPLY_PATCH_TO` if it is empty. */
const DISCARD_DIR = 'rmdir -- "$DSH_APPLY_PATCH_TO"';
/** Remove the staged file `$DSH_APPLY_PATCH_TO`. */
const DISCARD_FILE = 'rm -f -- "$DSH_APPLY_PATCH_TO"';
const RELINK_FAILURES = {
    89: 'the staging directory name is taken',
    90: 'its directory could not be created',
    91: 'it is no longer a regular file',
    92: 'the new name exists',
    93: 'the link could not be made',
    95: 'the old name could not be removed',
};
/** Attempts with fresh random names when a staging directory name exists already. */
const STAGING_ATTEMPTS = 3;
/** Staging directories, one in use per parent directory of a staged file. */
class Staging {
    fs;
    policy;
    dirs = [];
    current = new Map();
    constructor(fs, policy) {
        this.fs = fs;
        this.policy = policy;
    }
    /**
     * Check that a file next to `target` may be staged.
     * @throws {@link PatchError} when staging there is outside what the sandbox allows.
     */
    async check(target, signal) {
        await this.dir(target, signal);
    }
    /**
     * A fresh name in the staging directory next to `target`, in a new directory
     * when the current one is not usable (`foreign` or `unknown`).
     * @throws {@link PatchError} when the name cannot be resolved or is outside what the sandbox allows.
     */
    async slot(target, signal) {
        const dir = await this.dir(target, signal);
        const path = posix.join(dir.path, String(dir.slots.length));
        const staged = await fsCall(() => this.fs.resolve(path, { signal }), path);
        await checkWritable(this.fs, this.policy, staged, path, 'stage');
        const slot = { place: { target: staged, path }, dir };
        dir.slots.push(slot);
        return slot;
    }
    async dir(target, signal) {
        const parent = posix.dirname(this.fs.processPath(target));
        const known = this.current.get(parent);
        if (known !== undefined && (known.state === 'new' || known.state === 'made'))
            return known;
        const path = posix.join(parent, `${STAGING_PREFIX}${randomBytes(8).toString('hex')}`);
        const resolved = await fsCall(() => this.fs.resolve(path, { signal }), path);
        await checkWritable(this.fs, this.policy, resolved, path, 'stage');
        const dir = { path, target: resolved, state: 'new', slots: [] };
        this.dirs.push(dir);
        this.current.set(parent, dir);
        return dir;
    }
}
/**
 * Relink `from`, if it is still at `version`, into a fresh staging slot. A
 * staging directory is used only when this relink created it; when its name
 * exists already, a new random name is tried, up to {@link STAGING_ATTEMPTS}.
 * @throws {@link PatchError} when no slot can be resolved.
 */
async function stage(ctx, staging, from, version, signal, policy) {
    for (let attempt = 1;; attempt += 1) {
        const slot = await staging.slot(from.target, signal);
        const fresh = slot.dir.state === 'new';
        const { outcome, exit } = await relink(ctx, from, slot.place, version, fresh ? 'private' : '', signal, policy);
        if (fresh && exit !== 'not run')
            slot.dir.state = exit === undefined ? 'unknown' : exit === 89 || exit === 90 ? 'foreign' : 'made';
        if (outcome.kind !== 'collision' || attempt === STAGING_ATTEMPTS)
            return { slot, outcome };
    }
}
/**
 * Relink a staged file whose bytes are not the expected ones back to `place`,
 * if it is still at `version` and the name is free.
 * @returns whether it is back at `place`.
 */
async function putBack(ctx, slot, place, version, policy) {
    return (await relink(ctx, slot.place, place, version, '', undefined, policy)).outcome.kind === 'done';
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
        await checkWritable(fs, sandboxPolicy, target, path, verb);
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
            await checkWritable(fs, sandboxPolicy, target, op.path, 'add');
            writes.push({ kind: 'write', place, guard: { kind: 'createIfAbsent' }, before: null, after: op.content });
            files.push({ path: op.path, absolutePath: fs.processPath(target), action: 'added', before: null, after: op.content });
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
            const print = await fsCall(() => fingerprint(fs, target, signal), op.path);
            if (print?.version !== guard.version)
                throw new PatchError('PATCH_STALE', `"${op.path}" changed while the patch was being checked. Read it again and retry.`);
            await staging.check(target, signal);
            deletes.push({ kind: 'delete', place, version: guard.version, digest: print.digest });
            files.push({ path: op.path, absolutePath: fs.processPath(target), action: 'deleted', before, after: null });
            continue;
        }
        const before = await fsCall(() => readWhole(fs, target, signal), op.path);
        const after = op.chunks.length === 0 ? before : applyToFile(op.path, before, op.chunks, patch.format);
        if (op.moveTo === undefined) {
            if (after !== before) {
                await checkWritable(fs, sandboxPolicy, target, op.path, 'update');
                writes.push({ kind: 'write', place, guard, before, after });
            }
            files.push({ path: op.path, absolutePath: fs.processPath(target), action: 'modified', before, after });
            continue;
        }
        const destination = await resolve(op.moveTo);
        if (!await absent(op.moveTo, destination)) {
            throw new PatchError('PATCH_CONFLICT', `Cannot move "${op.path}" to "${op.moveTo}": the destination already exists.`);
        }
        await checkWritable(fs, sandboxPolicy, destination, op.moveTo, 'move a file to');
        moves.push({ kind: 'move', source: place, destination: { target: destination, path: op.moveTo }, version: guard.version, before, after: after === before ? null : after });
        files.push({ path: op.moveTo, absolutePath: fs.processPath(destination), from: op.path, action: 'modified', before, after });
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
            const relinked = (await relink(ctx, step.source, step.destination, step.version, 'parents', signal, policy)).outcome;
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
            const staged = await stage(ctx, prepared.staging, step.place, step.version, signal, policy).catch((error) => toPatchError(error, step.place.path, policy));
            if (staged instanceof PatchError) {
                failure = staged;
            }
            else {
                const { slot, outcome } = staged;
                const version = outcome.kind === 'done' ? await holdingBytes(fs, slot.place.target, step.digest, outcome.version, signal) : undefined;
                if (version !== undefined) {
                    slot.held = { version, digest: step.digest };
                    done.push({ kind: 'delete', step, slot, held: slot.held });
                    continue;
                }
                if (outcome.kind === 'done') {
                    failure = signal?.aborted === true
                        ? new PatchError('PATCH_IO', `Deleting "${step.place.path}" was aborted while its staged copy was being checked.`)
                        : new PatchError('PATCH_STALE', `"${step.place.path}" changed while it was being deleted, or could not be checked.`);
                    if (await putBack(ctx, slot, step.place, outcome.version, policy)) {
                        extra.push(`It was put back as it is now; read it again before retrying.`);
                    }
                    else {
                        extra.push(`It is kept, as it is now, at "${slot.place.path}"; check it before retrying.`);
                        kept.add(slot);
                    }
                }
                else {
                    failure = relinkFailure(outcome, step.place.path, `Deleting "${step.place.path}"`);
                    if (outcome.kind === 'split')
                        extra.push(`"${step.place.path}" was kept; the version this session read is kept at "${slot.place.path}".`);
                    if (outcome.kind === 'unknown')
                        extra.push(`The state of "${step.place.path}" is unknown; check it, and "${slot.place.path}", before retrying.`);
                    if (outcome.kind === 'split' || outcome.kind === 'unknown')
                        kept.add(slot);
                }
            }
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
    const notes = await clearStaging(ctx, prepared.staging, new Set(), policy);
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
 * observations for the files put back (only after checking their content),
 * and clear staging except for the slots in `kept` or that could not be put back.
 * @returns one note per file whose undo was incomplete or could not be verified.
 */
async function rollback(ctx, exec, staging, done, kept, policy) {
    const fs = ctx.fs;
    const notes = [];
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
                const staged = await stage(ctx, staging, place, entry.version, undefined, policy).catch((error) => toPatchError(error, place.path, policy));
                if (staged instanceof PatchError) {
                    notes.push(`"${place.path}" was created by this patch and could not be removed: ${staged.message}`);
                    break;
                }
                const { slot, outcome: removed } = staged;
                if (removed.kind === 'done') {
                    const digest = sha256(Buffer.from(entry.step.after, 'utf8'));
                    const version = await holdingBytes(fs, slot.place.target, digest, removed.version);
                    if (version !== undefined) {
                        slot.held = { version, digest };
                        if (!removed.fromBack)
                            observe(ctx, exec, place.target, { kind: 'absent' });
                    }
                    else if (await putBack(ctx, slot, place, removed.version, policy)) {
                        notes.push(changedNote(place.path));
                    }
                    else {
                        kept.add(slot);
                        notes.push(`"${place.path}" was changed while it was being removed; it is kept, as it is now, at "${slot.place.path}".`);
                    }
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
                const back = (await relink(ctx, destination, source, version, '', undefined, policy)).outcome;
                if (back.kind === 'done') {
                    const restored = await holding(fs, source.target, before);
                    if (!back.fromBack)
                        observe(ctx, exec, destination.target, { kind: 'absent' });
                    if (restored !== undefined)
                        observe(ctx, exec, source.target, { kind: 'present', version: restored });
                    else
                        notes.push(`"${source.path}" was moved back from "${destination.path}", but it changed right after or could not be checked; check it before retrying.`);
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
                const { place, digest } = entry.step;
                const { slot, held } = entry;
                const back = (await relink(ctx, slot.place, place, held.version, '', undefined, policy)).outcome;
                if (back.kind === 'done') {
                    slot.held = undefined;
                    const restored = await holdingBytes(fs, place.target, digest, back.version);
                    if (restored !== undefined)
                        observe(ctx, exec, place.target, { kind: 'present', version: restored });
                    else
                        notes.push(`"${place.path}" was put back, but it changed right after or could not be checked; check it before retrying.`);
                    break;
                }
                kept.add(slot);
                notes.push(back.kind === 'occupied'
                    ? `"${place.path}" was created again by someone else; the deleted file is kept at "${slot.place.path}".`
                    : `"${place.path}" could not be restored (${relinkReason(back)}); the deleted file is kept at "${slot.place.path}".`);
                break;
            }
        }
    }
    notes.push(...await clearStaging(ctx, staging, kept, policy));
    return notes;
}
/**
 * Remove the files this patch staged, except the slots in `kept`, each only
 * after checking again that it holds the verified version and bytes, and then
 * every staging directory this patch made that is left empty. A staged file
 * that changed is kept and named; nothing else in a staging directory is
 * removed.
 * @returns notes on staged files and directories that were kept or could not be removed.
 */
async function clearStaging(ctx, staging, kept, policy) {
    const fs = ctx.fs;
    const notes = [];
    for (const dir of staging.dirs) {
        let empty = true;
        for (const slot of dir.slots) {
            if (kept.has(slot)) {
                empty = false;
                continue;
            }
            if (slot.held === undefined)
                continue;
            if (await holdingBytes(fs, slot.place.target, slot.held.digest, slot.held.version) === undefined) {
                empty = false;
                notes.push(`"${slot.place.path}" changed after this patch staged it, so it was kept: it is a file this patch deleted or created, as changed since. Check it, then remove it.`);
                continue;
            }
            const run = await runShell(ctx, DISCARD_FILE, { DSH_APPLY_PATCH_TO: fs.processPath(slot.place.target) }, undefined, policy);
            if (!run.clean) {
                empty = false;
                notes.push(`"${slot.place.path}" could not be removed (${run.reason}); it is a copy of a file this patch deleted or created. Remove it.`);
                continue;
            }
            slot.held = undefined;
        }
        if (!empty)
            continue;
        if (dir.state === 'made') {
            const run = await runShell(ctx, DISCARD_DIR, { DSH_APPLY_PATCH_TO: fs.processPath(dir.target) }, undefined, policy);
            if (!run.clean)
                notes.push(`The staging directory "${dir.path}" could not be removed (${run.reason}). Remove it when it is empty.`);
        }
        else if (dir.state === 'unknown' && await fs.stat(dir.target).then(info => info !== undefined, () => true)) {
            notes.push(`The staging directory "${dir.path}" may have been left by this patch (whether this patch created it is unknown); remove it if it is empty.`);
        }
    }
    return notes;
}
/**
 * Relink `from`, if it is still at `version`, to `to` with {@link RELINK},
 * then stat both names to learn the outcome.
 */
async function relink(ctx, from, to, version, mkdir, signal, policy) {
    const fs = ctx.fs;
    try {
        const now = await fs.stat(from.target);
        if (now?.version !== version)
            return { outcome: { kind: 'changed', gone: now === undefined }, exit: 'not run' };
    }
    catch (error) {
        return { outcome: { kind: 'failed', code: 'PATCH_IO', reason: `checking "${from.path}" failed: ${describe(error)}` }, exit: 'not run' };
    }
    const run = await runShell(ctx, RELINK, {
        DSH_APPLY_PATCH_FROM: fs.processPath(from.target),
        DSH_APPLY_PATCH_TO: fs.processPath(to.target),
        DSH_APPLY_PATCH_MKDIR: mkdir,
    }, signal, policy);
    return { outcome: await relinkOutcome(fs, from, to, run), exit: run.exitCode };
}
/** The outcome of a {@link RELINK} run, from its exit code and a stat of both names. */
async function relinkOutcome(fs, from, to, run) {
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
    // Exit codes 89 to 93 stop the command before it changes anything.
    switch (run.exitCode) {
        case 89:
            return { kind: 'collision' };
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
        case 'collision': return 'the staging directory name is taken';
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
        case 'collision': return new PatchError('PATCH_IO', `${action} failed: every staging directory name tried exists already.`);
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
/** Window size for reading a file's bytes into its digest. */
const DIGEST_WINDOW = 1 << 20;
function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
/**
 * The version of `target` and the SHA-256 of its bytes, read in windows up to
 * the size the first stat reported, when that version holds before, between
 * and after the windows. A file that changes during the read is reported as
 * changed at the next window, so a file that keeps growing ends the read.
 * @param signal - aborts the read; omitted only for bounded undo and cleanup checks.
 * @returns undefined for a missing file or when the version changed during the read.
 * @throws the filesystem's error when the file cannot be read, or the abort reason.
 */
async function fingerprint(fs, target, signal) {
    const first = await fs.stat(target, signal);
    if (first === undefined)
        return undefined;
    const size = first.size ?? Number.POSITIVE_INFINITY;
    const hash = createHash('sha256');
    for (let offset = 0; offset < size;) {
        signal?.throwIfAborted();
        const window = await fs.readByteRange(target, { offset, length: Math.min(DIGEST_WINDOW, size - offset) }, signal);
        if (window.length === 0)
            break;
        hash.update(window);
        offset += window.length;
        if (offset < size && (await fs.stat(target, signal))?.version !== first.version)
            return undefined;
    }
    return (await fs.stat(target, signal))?.version === first.version ? { version: first.version, digest: hash.digest('hex') } : undefined;
}
/**
 * The version of `target` when it holds bytes with SHA-256 `digest` at version
 * `expected` (see {@link fingerprint}).
 * @param signal - the call's abort signal for a forward step; omitted while undoing and clearing staging.
 * @returns the version, or undefined when the file differs, cannot be checked, or the check was aborted.
 */
async function holdingBytes(fs, target, digest, expected, signal) {
    try {
        const print = await fingerprint(fs, target, signal);
        return print?.version === expected && print.digest === digest ? expected : undefined;
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
 * In `workspace-write` mode, refuse a change of a path outside the workspace
 * root, `/tmp` and `os.tmpdir()`: the writable roots of `writableRoots` in
 * `@deepseek-ai/dsh-sandbox`, which the DSH fs sandbox checks on every write.
 * Every write target, move destination and staging path is checked while
 * preparing, so a dry run reports the denial; a shell that performs a change
 * may not confine it itself.
 */
async function checkWritable(fs, policy, target, path, verb) {
    if (policy?.mode !== 'workspace-write')
        return;
    const roots = [policy.workspaceRoot, '/tmp', tmpdir()];
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
