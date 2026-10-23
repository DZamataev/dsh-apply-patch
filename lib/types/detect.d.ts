/**
 * Patch format detection, run before parsing.
 * @module dsh-apply-patch/detect
 */
/** Accepted patch formats. */
export type PatchFormat = 'unified' | 'codex';
/**
 * Classify patch text by its first structural line: a `*** Begin Patch` line
 * (surrounding whitespace ignored, as codex-rs does) means Codex; a
 * `diff --git` line, a `---`/`+++` pair or a hunk header means unified diff.
 * A `*** Begin Patch` context line inside a unified diff therefore does not
 * make it a Codex patch.
 * @param text - the patch text.
 * @returns the format.
 * @throws {@link PatchError} `PATCH_PARSE` with a Codex example for anything else.
 */
export declare function detectFormat(text: string): PatchFormat;
