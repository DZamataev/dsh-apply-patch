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
 * Marker lines are compared after trimming surrounding whitespace.
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
