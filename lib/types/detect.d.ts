/**
 * Patch format detection, run before parsing.
 * @module dsh-apply-patch/detect
 */
/** Accepted patch formats. */
export type PatchFormat = 'unified' | 'codex';
/**
 * Classify patch text: a `*** Begin Patch` line anywhere means Codex; a
 * `diff --git` line, a `---`/`+++` pair or a hunk header means unified diff.
 * @param text - the patch text.
 * @returns the format.
 * @throws {@link PatchError} `PATCH_PARSE` with a Codex example for anything else.
 */
export declare function detectFormat(text: string): PatchFormat;
