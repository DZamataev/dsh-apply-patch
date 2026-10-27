/**
 * The model-facing `apply_patch` tool.
 * @module dsh-apply-patch/tool
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import type { ResolvedConfig } from './config.js';
import type { DisplayDiff } from './diff.js';
/** Result value of one call. */
export interface ApplyPatchResult {
    applied: boolean;
    summary: string;
    /** The files with their paths as written in the patch. */
    files: {
        path: string;
        action: 'added' | 'modified' | 'deleted';
        from?: string;
    }[];
    /** Display hunks (see `displayDiffs`) whose `path` is the resolved absolute path, as for the native `write` and `edit`. */
    diffs: DisplayDiff[];
}
/**
 * Build the tool definition.
 * @param ctx - plugin context; execution uses its services.
 * @param cfg - resolved configuration.
 * @returns the tool definition.
 */
export declare function buildApplyPatchTool(ctx: Context, cfg: ResolvedConfig): ToolDefinition;
/**
 * Model-facing text: the summary, then one `A`/`M`/`D` line per file.
 * @param value - the result value.
 * @returns the text.
 */
export declare function formatResult(value: ApplyPatchResult): string;
