/**
 * Compact display diffs: only the changed region of a file plus a few context
 * lines, so a small edit in a large file still shows a diff card.
 * @module dsh-apply-patch/diff
 */
/** One display diff entry, in the shape DSH diff cards read. */
export type DisplayDiff = {
    path: string;
    oldText: string | null;
    newText: string;
    /** True when the region exceeded the byte limit and its text was dropped. */
    truncated?: boolean;
};
/**
 * Cut `before`/`after` down to the lines between their common prefix and suffix, plus context.
 * @param path - display path.
 * @param before - old text, or `null` for a new file.
 * @param after - new text, or `null` for a deleted file.
 * @param maxBytes - UTF-8 byte limit for the two texts together.
 * @returns the display diff.
 */
export declare function compactDiff(path: string, before: string | null, after: string | null, maxBytes: number): DisplayDiff;
