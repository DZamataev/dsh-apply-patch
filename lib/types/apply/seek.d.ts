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
 * Find `pattern` in `lines` at or after `from`.
 * @param lines - file lines without line terminators.
 * @param pattern - lines to find; an empty pattern matches at `from`, also with `endOfFile`, as in codex-rs.
 * @param from - first index a match may start at.
 * @param options - `endOfFile` pins the match to the end.
 * @returns the match, no match, or the first {@link AMBIGUOUS_SHOWN} (at least two) ambiguous tolerant candidates.
 */
export declare function seek(lines: readonly string[], pattern: readonly string[], from: number, options?: {
    endOfFile?: boolean;
}): SeekResult;
