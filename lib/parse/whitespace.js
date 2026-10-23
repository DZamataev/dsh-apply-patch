/**
 * Whitespace as Rust's `str::trim` sees it, for Codex patches: Unicode
 * White_Space, which includes U+0085 and excludes U+FEFF, unlike
 * `String.prototype.trim`. Every trim of Codex patch text and of file lines a
 * Codex patch is matched against uses these, so markers, labels, paths and the
 * tolerant match levels agree with codex-rs.
 * @module dsh-apply-patch/parse/whitespace
 */
/** Unicode White_Space; all members are single UTF-16 units. */
const WHITE_SPACE = new Set('\t\n\v\f\r \u0085\u00A0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u2028\u2029\u202F\u205F\u3000');
/**
 * Rust `str::trim_end`.
 * @param text - the text.
 * @returns `text` without trailing Unicode White_Space.
 */
export function rustTrimEnd(text) {
    let end = text.length;
    while (end > 0 && WHITE_SPACE.has(text[end - 1]))
        end -= 1;
    return text.slice(0, end);
}
/**
 * Rust `str::trim`.
 * @param text - the text.
 * @returns `text` without leading and trailing Unicode White_Space.
 */
export function rustTrim(text) {
    const rest = rustTrimEnd(text);
    let start = 0;
    while (start < rest.length && WHITE_SPACE.has(rest[start]))
        start += 1;
    return rest.slice(start);
}
