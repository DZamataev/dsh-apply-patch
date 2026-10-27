/**
 * Locating a sequence of lines in a file for Codex patches, after codex-rs
 * `seek_sequence`: exact match first, then ignoring trailing whitespace, then
 * surrounding whitespace, then typographic punctuation (dashes, quotes, odd
 * spaces). Whitespace is Rust's `char::is_whitespace` set (Unicode White_Space:
 * it includes U+0085 and excludes U+FEFF, unlike `String.prototype.trim`).
 *
 * An exact match takes the first candidate at or after the cursor, as
 * codex-rs does, and the search stops there. Each level is one
 * Knuth-Morris-Pratt search over the normalized lines, so it compares
 * O(file lines + pattern lines) lines also in a file of many near matches
 * (codex-rs compares every candidate with the whole pattern). The tolerant levels accept only
 * a single candidate: where codex-rs edits the first of several tolerant
 * matches, two or more are reported as ambiguous instead, with at most
 * {@link AMBIGUOUS_SHOWN} of them.
 * @module dsh-apply-patch/apply/seek
 */
import { rustTrim, rustTrimEnd } from '../parse/whitespace.js';
const PUNCTUATION = {
    '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2015': '-', '\u2212': '-',
    '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'",
    '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u201F': '"',
    '\u00A0': ' ', '\u2002': ' ', '\u2003': ' ', '\u2004': ' ', '\u2005': ' ', '\u2006': ' ', '\u2007': ' ',
    '\u2008': ' ', '\u2009': ' ', '\u200A': ' ', '\u202F': ' ', '\u205F': ' ', '\u3000': ' ',
};
/** Tolerant candidates collected before a match is reported as ambiguous; the scan stops at this many. */
export const AMBIGUOUS_SHOWN = 5;
const LEVELS = [
    line => line,
    rustTrimEnd,
    rustTrim,
    line => Array.from(rustTrim(line), ch => PUNCTUATION[ch] ?? ch).join(''),
];
/**
 * Find `pattern` in `lines` at or after `from`.
 * @param lines - file lines without line terminators.
 * @param pattern - lines to find; an empty pattern matches at `from`, also with `endOfFile`, as in codex-rs.
 * @param from - first index a match may start at.
 * @param options - `endOfFile` pins the match to the end.
 * @returns the match, no match, or the first {@link AMBIGUOUS_SHOWN} (at least two) ambiguous tolerant candidates.
 */
export function seek(lines, pattern, from, options = {}) {
    if (pattern.length === 0)
        return { kind: 'found', index: from };
    const last = lines.length - pattern.length;
    if (last < from)
        return { kind: 'none' };
    const first = options.endOfFile === true ? last : from;
    for (let level = 0; level < LEVELS.length; level += 1) {
        const norm = LEVELS[level];
        // Each file line is normalized once per level, not once per candidate it is compared in.
        const normalized = level === 0 ? lines : lines.slice(first, last + pattern.length).map(norm);
        const hits = matches(normalized, level === 0 ? first : 0, last - first + 1, pattern.map(norm), level === 0 ? 1 : AMBIGUOUS_SHOWN);
        if (hits.length === 0)
            continue;
        const offset = level === 0 ? 0 : first;
        if (hits.length > 1)
            return { kind: 'ambiguous', indices: hits.map(i => i + offset) };
        return { kind: 'found', index: hits[0] + offset };
    }
    return { kind: 'none' };
}
/**
 * Start indices of `wanted` in `text`, in order and overlapping ones included,
 * by Knuth-Morris-Pratt over whole lines: every text line is compared a
 * bounded number of times, so a search costs O(text lines + pattern lines)
 * line comparisons however many near matches the text has.
 * @param text - the lines to search.
 * @param from - first index a match may start at.
 * @param starts - number of start indices to try (`from` up to `from + starts - 1`).
 * @param wanted - the non-empty pattern.
 * @param limit - stop after this many matches.
 * @returns up to `limit` start indices.
 */
function matches(text, from, starts, wanted, limit) {
    // fail[j]: length of the longest proper prefix of wanted[0..j] that is also its suffix.
    const fail = new Int32Array(wanted.length);
    for (let j = 1, k = 0; j < wanted.length; j += 1) {
        while (k > 0 && wanted[j] !== wanted[k])
            k = fail[k - 1];
        if (wanted[j] === wanted[k])
            k += 1;
        fail[j] = k;
    }
    const hits = [];
    const end = from + starts - 1 + wanted.length;
    for (let i = from, k = 0; i < end; i += 1) {
        while (k > 0 && text[i] !== wanted[k])
            k = fail[k - 1];
        if (text[i] === wanted[k])
            k += 1;
        if (k === wanted.length) {
            hits.push(i - wanted.length + 1);
            if (hits.length >= limit)
                break;
            k = fail[k - 1];
        }
    }
    return hits;
}
