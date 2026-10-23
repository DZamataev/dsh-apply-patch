/**
 * Locating a sequence of lines in a file, after codex-rs `seek_sequence`:
 * exact match first, then ignoring trailing whitespace, then surrounding
 * whitespace, then typographic punctuation (dashes, quotes, odd spaces).
 *
 * An exact match takes the candidate nearest to the hint (the first one at or
 * after the cursor without a hint). The tolerant levels accept only a single
 * candidate: two or more tolerant matches are reported as ambiguous instead of
 * silently editing one of them.
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
 * @param pattern - lines to find; empty matches at `from` (at the end with `endOfFile`).
 * @param from - first index a match may start at.
 * @param options - `endOfFile` pins the match to the end; `hint` prefers the nearest exact candidate.
 * @returns the match, no match, or the ambiguous tolerant candidates.
 */
export declare function seek(lines: readonly string[], pattern: readonly string[], from: number, options?: {
    endOfFile?: boolean;
    hint?: number;
}): SeekResult;
