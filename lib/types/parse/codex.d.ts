/**
 * Codex `apply_patch` parser, following codex-rs `apply-patch` in its lenient mode:
 *
 * ```
 * *** Begin Patch
 * *** Add File: path          (+ lines follow)
 * *** Delete File: path
 * *** Update File: path
 * *** Move to: new-path       (optional)
 * @@ optional label           (zero or more; the first chunk may omit it)
 *  context / -removed / +added
 * *** End of File             (optional, pins the chunk to the end of the file)
 * *** End Patch
 * ```
 *
 * Text around the markers (a heredoc, a code fence, prose) is ignored: the
 * patch runs from the first `*** Begin Patch` to the last `*** End Patch`.
 * Those two are compared after trimming surrounding whitespace; operation
 * headers must be unindented and their path is the rest of the line without
 * trailing whitespace (whitespace after the marker's space belongs to the path,
 * as in codex-rs); `@@` and `*** End of File` inside an update are compared
 * after trimming trailing whitespace, so an indented one is a context line.
 * Whitespace is Rust's (see {@link rustTrim}). Two or more `@@`
 * lines in a row stack labels and a first chunk may omit `@@` (codex-rs rejects
 * stacked labels).
 * @module dsh-apply-patch/parse/codex
 */
import type { ParsedPatch } from './types.js';
/**
 * Parse a Codex patch.
 * @param text - the patch text.
 * @returns the parsed patch.
 * @throws {@link PatchError} `PATCH_PARSE` with the failing line.
 */
export declare function parseCodexPatch(text: string): ParsedPatch;
