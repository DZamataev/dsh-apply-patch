/**
 * Locating a sequence of lines in a file for Codex patches, after codex-rs
 * `seek_sequence`: exact match first, then ignoring trailing whitespace, then
 * surrounding whitespace, then typographic punctuation (dashes, quotes, odd
 * spaces). Whitespace is Rust's `char::is_whitespace` set (Unicode White_Space:
 * it includes U+0085 and excludes U+FEFF, unlike `String.prototype.trim`).
 *
 * An exact match takes the first candidate at or after the cursor, as
 * codex-rs does, and the search stops there. The tolerant levels accept only
 * a single candidate: where codex-rs edits the first of several tolerant
 * matches, two or more are reported as ambiguous instead, with at most
 * {@link AMBIGUOUS_SHOWN} of them.
 *
 * A {@link LineSearch} serves all searches in one file: each level normalizes
 * the file lines once, when a search first needs it, and from its second
 * search on indexes them by normalized text, so a search costs about its
 * candidates (the places of its rarest line), not the rest of the file. Where those candidates would cost
 * more than the remaining lines (a pattern of lines that are frequent in the
 * file), or few starts remain, the level is one Knuth-Morris-Pratt search over
 * the remaining normalized lines instead, which compares O(remaining lines +
 * pattern lines) lines also in a file of many near matches (codex-rs compares
 * every candidate with the whole pattern); so is the first search of a level,
 * which an index would not repay.
 * @module dsh-apply-patch/apply/seek
 */
/** Result of a search. */
export type SeekResult = {
    kind: 'found';
    index: number;
} | {
    kind: 'none';
} | {
    kind: 'ambiguous';
    indices: number[];
};
/** Tolerant candidates collected before a match is reported as ambiguous; the scan stops at this many. */
export declare const AMBIGUOUS_SHOWN = 5;
/**
 * Find `pattern` in `lines` at or after `from`; one search of {@link LineSearch}.
 * @param lines - file lines without line terminators.
 * @param pattern - lines to find; an empty pattern matches at `from`, also with `endOfFile`, as in codex-rs.
 * @param from - first index a match may start at.
 * @param options - `endOfFile` pins the match to the end.
 * @returns the match, no match, or the first {@link AMBIGUOUS_SHOWN} (at least two) ambiguous tolerant candidates.
 */
export declare function seek(lines: readonly string[], pattern: readonly string[], from: number, options?: {
    endOfFile?: boolean;
}): SeekResult;
/** Searches in the lines of one file, which must not change while the object is used. */
export declare class LineSearch {
    private readonly lines;
    /** Per level: the normalized file lines, the ascending indices of each normalized text, and whether a search scanned them. */
    private readonly levels;
    /** @param lines - file lines without line terminators. */
    constructor(lines: readonly string[]);
    /**
     * Find `pattern` at or after `from`, as {@link seek}.
     * @param pattern - lines to find; an empty pattern matches at `from`, also with `endOfFile`, as in codex-rs.
     * @param from - first index a match may start at.
     * @param options - `endOfFile` pins the match to the end.
     * @returns the match, no match, or the first {@link AMBIGUOUS_SHOWN} (at least two) ambiguous tolerant candidates.
     */
    seek(pattern: readonly string[], from: number, options?: {
        endOfFile?: boolean;
    }): SeekResult;
    /** The first `limit` starts from `first` to `last` where the normalized `wanted` matches at `level`, ascending. */
    private find;
    private normalized;
}
