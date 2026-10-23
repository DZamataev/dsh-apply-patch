/**
 * Whitespace as Rust's `str::trim` sees it, for Codex patches: Unicode
 * White_Space, which includes U+0085 and excludes U+FEFF, unlike
 * `String.prototype.trim`. Every trim of Codex patch text and of file lines a
 * Codex patch is matched against uses these, so markers, labels, paths and the
 * tolerant match levels agree with codex-rs.
 * @module dsh-apply-patch/parse/whitespace
 */
/**
 * Rust `str::trim_end`.
 * @param text - the text.
 * @returns `text` without trailing Unicode White_Space.
 */
export declare function rustTrimEnd(text: string): string;
/**
 * Rust `str::trim`.
 * @param text - the text.
 * @returns `text` without leading and trailing Unicode White_Space.
 */
export declare function rustTrim(text: string): string;
