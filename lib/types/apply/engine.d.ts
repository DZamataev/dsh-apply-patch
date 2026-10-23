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
import type { Context } from '@deepseek-ai/cordis';
import type { FileSystem, FsTarget, FsVersion, FsWriteIntent } from '@deepseek-ai/dsh-fs';
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { ResolvedConfig } from '../config.js';
import type { ParsedPatch } from '../parse/types.js';
/** One file in the result. */
export interface FileChange {
    path: string;
    action: 'added' | 'modified' | 'deleted';
    /** Original path of a moved file. */
    from?: string;
    before: string | null;
    after: string | null;
}
/** A file by its resolved target and its path as written in the patch (or the staging path). */
interface Place {
    target: FsTarget;
    path: string;
}
/** A write in place; `before` is null for a created file. */
interface WriteStep {
    kind: 'write';
    place: Place;
    guard: FsWriteIntent;
    before: string | null;
    after: string;
}
/** A move of the source at `version`; `after` is the text to write at the destination, null to keep the bytes. */
interface MoveStep {
    kind: 'move';
    source: Place;
    destination: Place;
    version: FsVersion;
    before: string;
    after: string | null;
}
/** A deletion of the file at `version`: it is relinked to `staged`. */
interface DeleteStep {
    kind: 'delete';
    place: Place;
    version: FsVersion;
    staged: Slot;
}
type Step = WriteStep | MoveStep | DeleteStep;
/** A checked patch, ready to commit. */
export interface PreparedPatch {
    files: FileChange[];
    steps: Step[];
    sandboxPolicy: SandboxExecutionPolicy | undefined;
    staging: Staging;
}
/** A staged file: a name inside a staging directory. */
interface Slot {
    place: Place;
    dir: StagingDir;
}
interface StagingDir {
    path: string;
    target: FsTarget;
    made: boolean;
    slots: number;
}
/**
 * Staging directories, one per parent directory of a staged file, created by
 * the first relink into them.
 */
declare class Staging {
    private readonly fs;
    private readonly policy;
    readonly dirs: Map<string, StagingDir>;
    constructor(fs: FileSystem, policy: SandboxExecutionPolicy | undefined);
    /**
     * A fresh name in the staging directory next to `target`.
     * @throws {@link PatchError} when the name is outside what the sandbox allows.
     */
    slot(target: FsTarget, signal?: AbortSignal): Promise<Slot>;
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
export declare function preparePatch(ctx: Context, exec: ToolRunContext, patch: ParsedPatch, cfg: ResolvedConfig): Promise<PreparedPatch>;
/**
 * Perform the checked steps; on failure undo the steps already done.
 * @param ctx - plugin context.
 * @param exec - the tool call.
 * @param prepared - the checked patch.
 * @returns notes on deleted files whose staged copy could not be removed afterwards.
 * @throws {@link PatchError} naming the failed step, the files whose undo was incomplete and the files in an unknown state.
 */
export declare function commitPatch(ctx: Context, exec: ToolRunContext, prepared: PreparedPatch): Promise<string[]>;
export {};
