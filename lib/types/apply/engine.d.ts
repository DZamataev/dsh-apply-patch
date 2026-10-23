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
import type { Context } from '@deepseek-ai/cordis';
import type { FsTarget, FsWriteIntent } from '@deepseek-ai/dsh-fs';
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
type Step = {
    kind: 'write';
    target: FsTarget;
    guard: FsWriteIntent;
    before: string | null;
    after: string;
} | {
    kind: 'remove';
    target: FsTarget;
    before: string | null;
};
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
 * @throws {@link PatchError} naming the failed step and anything that could not be restored.
 */
export declare function commitPatch(ctx: Context, exec: ToolRunContext, prepared: PreparedPatch): Promise<void>;
export {};
