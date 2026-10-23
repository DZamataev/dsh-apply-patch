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
const PUNCTUATION = {
    '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2015': '-', '\u2212': '-',
    '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'",
    '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u201F': '"',
    '\u00A0': ' ', '\u2002': ' ', '\u2003': ' ', '\u2004': ' ', '\u2005': ' ', '\u2006': ' ', '\u2007': ' ',
    '\u2008': ' ', '\u2009': ' ', '\u200A': ' ', '\u202F': ' ', '\u205F': ' ', '\u3000': ' ',
};
/** Unicode White_Space, the characters Rust `str::trim` strips; all are single UTF-16 units. */
const WHITE_SPACE = new Set('\t\n\v\f\r \u0085\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000');
function trimEnd(line) {
    let end = line.length;
    while (end > 0 && WHITE_SPACE.has(line[end - 1]))
        end -= 1;
    return line.slice(0, end);
}
function trim(line) {
    const rest = trimEnd(line);
    let start = 0;
    while (start < rest.length && WHITE_SPACE.has(rest[start]))
        start += 1;
    return rest.slice(start);
}
const LEVELS = [
    line => line,
    trimEnd,
    trim,
    line => Array.from(trim(line), ch => PUNCTUATION[ch] ?? ch).join(''),
];
/**
 * Find `pattern` in `lines` at or after `from`.
 * @param lines - file lines without line terminators.
 * @param pattern - lines to find; an empty pattern matches at `from`, also with `endOfFile`, as in codex-rs.
 * @param from - first index a match may start at.
 * @param options - `endOfFile` pins the match to the end.
 * @returns the match, no match, or the ambiguous tolerant candidates.
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
        const wanted = pattern.map(norm);
        const hits = [];
        for (let i = first; i <= last; i += 1) {
            let ok = true;
            for (let j = 0; j < wanted.length && ok; j += 1)
                ok = norm(lines[i + j]) === wanted[j];
            if (ok)
                hits.push(i);
        }
        if (hits.length === 0)
            continue;
        if (level > 0 && hits.length > 1)
            return { kind: 'ambiguous', indices: hits };
        return { kind: 'found', index: hits[0] };
    }
    return { kind: 'none' };
}
