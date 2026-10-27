/**
 * Applying the chunks of one update to the file's text. Codex chunks, and
 * unified hunks without line numbers, are applied in file order: each is
 * searched at or after the end of the previous one.
 *
 * Codex patches give the bytes of codex-rs (`compute_replacements`,
 * `text_file`): the file is split at LF, CRLF and lone CR; a chunk is found
 * with the tolerant levels of {@link seek}; context lines keep the file's text
 * and every untouched line its own ending; new lines take the file's first
 * line ending (LF when it has none); every line of the result ends with a line
 * ending; a chunk without old lines is appended at the end of the file. A chunk
 * that matches nowhere is retried without its last blank context line, as in
 * codex-rs, and then without all its trailing unprefixed blank lines.
 *
 * Unified diffs give the bytes of plain `git apply` (without `--unidiff-zero`):
 * the file is split at LF only, a CR before it belongs to the line, and lines
 * compare exactly together with their LF, so `\ No newline at end of file`
 * must agree with the file. Hunks are applied one after another to the
 * current text, each placed as git places it (see {@link place}); lines an
 * earlier hunk produced are not matched again. Unlike Codex chunks, hunks need
 * not be in file order.
 * @module dsh-apply-patch/apply/content
 */
import type { TextEdit } from '../diff.js';
import { PatchError } from '../errors.js';
import type { Chunk } from '../parse/types.js';
/**
 * A chunk that cannot be placed in the file. `referenceRejects` tells whether
 * codex-rs or `git apply` would refuse it too; it is false for an ambiguous
 * tolerant Codex match (codex-rs takes the first) and for a context-free
 * unified hunk away from where git puts it.
 */
export declare class PlacementError extends PatchError {
    readonly referenceRejects: boolean;
    constructor(message: string, referenceRejects: boolean);
}
/** A new file text and the edits that turned the old text into it, in order and disjoint. */
export interface Patched {
    text: string;
    edits: TextEdit[];
}
/**
 * Compute the new text of a file and the edits that made it: the replaced lines of every
 * chunk, and the line ending a Codex patch adds to an untouched last line.
 * @param path - the path as written in the patch, for messages.
 * @param before - the current file text.
 * @param chunks - the chunks in file order.
 * @param format - the patch format.
 * @returns the new file text and its edits.
 * @throws {@link PatchError} `PATCH_CONFLICT` when a chunk cannot be located unambiguously.
 */
export declare function editChunks(path: string, before: string, chunks: readonly Chunk[], format: 'unified' | 'codex'): Patched;
/**
 * Compute the new text of a file ({@link editChunks} without the edits).
 * @param path - the path as written in the patch, for messages.
 * @param before - the current file text.
 * @param chunks - the chunks in file order.
 * @param format - the patch format.
 * @returns the new file text.
 * @throws {@link PatchError} `PATCH_CONFLICT` when a chunk cannot be located unambiguously.
 */
export declare function applyChunks(path: string, before: string, chunks: readonly Chunk[], format: 'unified' | 'codex'): string;
/**
 * {@link applyChunks} for a whole file text, which starts with U+FEFF when the
 * file starts with a UTF-8 byte order mark. The mark belongs to the first line,
 * as for codex-rs and git. When the reference would reject the patch because
 * of that (typically a change of the first line written without the mark, which
 * the read tool does not show), the chunks are applied to the text after the
 * mark and the mark is kept.
 * @param path - the path as written in the patch, for messages.
 * @param text - the whole file text.
 * @param chunks - the chunks in file order.
 * @param format - the patch format.
 * @returns the new file text.
 * @throws {@link PatchError} `PATCH_CONFLICT` as {@link applyChunks}; after a retry without the mark, the retry's error.
 */
export declare function applyToFile(path: string, text: string, chunks: readonly Chunk[], format: 'unified' | 'codex'): string;
/**
 * {@link applyToFile} with the edits that made the new text, in offsets of the whole texts.
 * @param path - the path as written in the patch, for messages.
 * @param text - the whole file text.
 * @param chunks - the chunks in file order.
 * @param format - the patch format.
 * @returns the new file text and its edits.
 * @throws {@link PatchError} `PATCH_CONFLICT` as {@link applyToFile}.
 */
export declare function editFile(path: string, text: string, chunks: readonly Chunk[], format: 'unified' | 'codex'): Patched;
