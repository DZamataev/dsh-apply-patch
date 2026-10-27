/**
 * Display diffs for DSH diff cards: one entry per changed region of a file (a hunk with three
 * context lines around the edits the patch made), with byte caps per entry and per call.
 * @module dsh-apply-patch/diff
 */
/** One display diff entry, in the shape DSH diff cards read. */
export type DisplayDiff = {
    path: string;
    /** Old lines of the hunk as a fragment (see {@link displayDiffs}); `null` when the hunk has no old lines (a created or empty file). */
    oldText: string | null;
    /** New lines of the hunk as a fragment; `''` when it has none. */
    newText: string;
    /** True when the entry did not fit a byte cap and its texts were dropped. */
    truncated?: boolean;
};
/** A replaced range: `before[oldFrom, oldTo)` became `after[newFrom, newTo)` (UTF-16 offsets). */
export interface TextEdit {
    oldFrom: number;
    oldTo: number;
    newFrom: number;
    newTo: number;
}
/** A file as the patch changes it, for its display diff. */
export interface DisplayFile {
    /** Path stamped on every entry of the file. */
    path: string;
    action: 'added' | 'modified' | 'deleted';
    /** Text before the patch; `null` for an added file or a deleted file without text (binary). */
    before: string | null;
    /** Text after the patch; `null` for a deleted file. */
    after: string | null;
    /**
     * For a modified file: the edits that turn `before` into `after`, in order and disjoint, as the
     * patch made them. When omitted, one edit spans from the first to the last changed character.
     */
    edits?: readonly TextEdit[];
}
/** Context lines on each side of a hunk; changes at most twice this far apart share a hunk. */
export declare const DIFF_CONTEXT = 3;
/**
 * The display diffs of a patch, file by file and hunk by hunk.
 *
 * A fragment (`oldText`, `newText`) is its lines, each followed by LF (`lines.join('\n') + '\n'`),
 * the form of a whole file text, so a reader that drops one final LF as the file's terminator
 * gets the exact lines; CRLF and LF are not shown, a lone CR stays in its line, and a leading
 * byte order mark is not shown. When the fragment ends with the file's last line and that line
 * has no line ending, the fragment ends without LF (`lines.join('\n')`), so such a reader again
 * gets the exact lines; a change of only that line ending then shows as equal sides.
 *
 * A hunk covers the lines the edits touch, merged when at most `2 * DIFF_CONTEXT` unchanged lines
 * lie between them, with up to {@link DIFF_CONTEXT} unchanged lines on each side; the common
 * characters at both ends of an edit are not counted as changed. An added file has one entry with
 * `oldText: null`; a deleted file one entry with `newText: ''` (none when its text is unknown or
 * empty); a modified or moved file one entry per hunk (none when its text is unchanged).
 *
 * An entry whose UTF-8 size (path, `oldText` and `newText`) exceeds `maxBytes` keeps its path with
 * empty texts and `truncated: true`; entries are kept in order until the next one would bring the
 * call over `maxTotalBytes`, and every later entry is truncated too, without computing its texts.
 * Consecutive truncated entries of one file are merged into one. The work is proportional to the
 * edits and the shown lines, not to the size of the files.
 * @param files - the files in patch order.
 * @param maxBytes - UTF-8 byte cap of one entry.
 * @param maxTotalBytes - UTF-8 byte cap of all kept entries together.
 * @returns the entries.
 */
export declare function displayDiffs(files: readonly DisplayFile[], maxBytes: number, maxTotalBytes: number): DisplayDiff[];
/**
 * The hunks between two texts, as {@link displayDiffs} shows them, without byte caps.
 * @param before - old text.
 * @param after - new text.
 * @param edits - the edits that turn `before` into `after`, in order and disjoint; when omitted, one edit spans the whole texts.
 * @returns the hunks in file order; empty when the edits change nothing.
 */
export declare function hunkTexts(before: string, after: string, edits?: readonly TextEdit[]): {
    oldText: string | null;
    newText: string;
}[];
