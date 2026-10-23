/**
 * Locating a sequence of lines in a file for Codex patches, after codex-rs
 * `seek_sequence`: exact match first, then ignoring trailing whitespace, then
 * surrounding whitespace, then typographic punctuation (dashes, quotes, odd
 * spaces). Whitespace is Rust's `char::is_whitespace` set (Unicode White_Space:
 * it includes U+0085 and excludes U+FEFF, unlike `String.prototype.trim`).
 *
 * An exact match takes the first candidate at or after the cursor, as
 * codex-rs does. The tolerant levels accept only a single candidate: where
 * codex-rs edits the first of several tolerant matches, two or more are
 * reported as ambiguous instead.
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
/**
 * Find `pattern` in `lines` at or after `from`.
 * @param lines - file lines without line terminators.
 * @param pattern - lines to find; an empty pattern matches at `from`, also with `endOfFile`, as in codex-rs.
 * @param from - first index a match may start at.
 * @param options - `endOfFile` pins the match to the end.
 * @returns the match, no match, or the ambiguous tolerant candidates.
 */
export declare function seek(lines: readonly string[], pattern: readonly string[], from: number, options?: {
    endOfFile?: boolean;
}): SeekResult;
