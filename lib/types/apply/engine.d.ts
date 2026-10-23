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
import type { Context } from '@deepseek-ai/cordis';
import type { FsTarget, FsVersion, FsWriteIntent } from '@deepseek-ai/dsh-fs';
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
/** A write; `before` is null for a created file, `source` is the move source removed by a later step. */
interface WriteStep {
    kind: 'write';
    target: FsTarget;
    path: string;
    guard: FsWriteIntent;
    before: string | null;
    after: string;
    source?: string;
}
/** A removal of the file at `version`; `before` is null for a file that cannot be read as text, which therefore cannot be restored. */
interface RemoveStep {
    kind: 'remove';
    target: FsTarget;
    path: string;
    version: FsVersion;
    before: string | null;
}
type Step = WriteStep | RemoveStep;
/** A checked patch, ready to commit. */
export interface PreparedPatch {
    files: FileChange[];
    steps: Step[];
    sandboxPolicy: SandboxExecutionPolicy | undefined;
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
 * @throws {@link PatchError} naming the failed step, the files whose undo was incomplete and the files in an unknown state.
 */
export declare function commitPatch(ctx: Context, exec: ToolRunContext, prepared: PreparedPatch): Promise<void>;
export {};
