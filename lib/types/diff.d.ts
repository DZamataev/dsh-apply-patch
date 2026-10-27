/**
 * Display diffs for DSH diff cards: one entry per changed region of a file
 * (a hunk with three context lines), as the native `write` and `edit` tools
 * report them, with byte caps per entry and per call.
 * @module dsh-apply-patch/diff
 */
/** One display diff entry, in the shape DSH diff cards read. */
export type DisplayDiff = {
    path: string;
    /** Old lines of the hunk joined with LF, without a final line ending; `null` when the hunk has no old lines (a created or empty file). */
    oldText: string | null;
    /** New lines of the hunk joined with LF, without a final line ending. */
    newText: string;
    /** True when the entry did not fit a byte cap and its texts were dropped. */
    truncated?: boolean;
};
/** A file as the patch changes it, for its display diff. */
export interface DisplayFile {
    /** Path stamped on every entry of the file. */
    path: string;
    action: 'added' | 'modified' | 'deleted';
    /** Text before the patch; `null` for an added file or a deleted file without text (binary). */
    before: string | null;
    /** Text after the patch; `null` for a deleted file. */
    after: string | null;
}
/** A changed run of lines: old lines `[oldStart, oldEnd)` are replaced by new lines `[newStart, newEnd)`. */
export interface LineChange {
    oldStart: number;
    oldEnd: number;
    newStart: number;
    newEnd: number;
}
/** Context lines on each side of a hunk; changes at most twice this far apart share a hunk. */
export declare const DIFF_CONTEXT = 3;
/**
 * The display diffs of a patch, file by file and hunk by hunk.
 * An added file has one entry with `oldText: null`; a deleted file one entry with `newText: ''`
 * (none when its text is unknown or empty); a modified or moved file one entry per hunk
 * (none when its text is unchanged). An entry whose UTF-8 size (path, `oldText` and `newText`)
 * exceeds `maxBytes` keeps its path with empty texts and `truncated: true`; entries are kept in
 * order until the next one would bring the call over `maxTotalBytes`, and every later entry is
 * truncated too. Consecutive truncated entries of one file are merged into one.
 * @param files - the files in patch order.
 * @param maxBytes - UTF-8 byte cap of one entry.
 * @param maxTotalBytes - UTF-8 byte cap of all kept entries together.
 * @returns the entries.
 */
export declare function displayDiffs(files: readonly DisplayFile[], maxBytes: number, maxTotalBytes: number): DisplayDiff[];
/**
 * The hunks between two texts, each with up to {@link DIFF_CONTEXT} unchanged lines on each side.
 * A line ends after LF. Its CRLF or LF counts when lines are compared, so a change of only the
 * line ending is a hunk, and is dropped when the line is shown; a lone CR stays in its line.
 * A leading byte order mark is not shown.
 * @param before - old text.
 * @param after - new text.
 * @returns the hunks in file order; empty when the texts are equal.
 */
export declare function hunkTexts(before: string, after: string): {
    oldText: string | null;
    newText: string;
}[];
/**
 * A line diff of `a` and `b`: the shortest edit script (Myers) while it is cheap, otherwise
 * lines unique to both sides (patience) split the work into parts that are diffed the same way,
 * and a part that is still too costly becomes one change. Every result turns `a` into `b`.
 * @param a - old lines.
 * @param b - new lines.
 * @returns the changed runs in order, separated by at least one equal line.
 */
export declare function diffLines(a: readonly string[], b: readonly string[]): LineChange[];
