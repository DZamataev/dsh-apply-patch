/**
 * Applying the chunks of one update to the file's text. Chunks are applied in
 * file order: each is searched at or after the end of the previous one.
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
 * Unified diffs give the bytes of `git apply`: the file is split at LF only, a
 * CR before it belongs to the line, and lines compare exactly together with
 * their LF, so `\ No newline at end of file` must agree with the file. Among
 * the exact matches, git's anchoring applies (a hunk without trailing context
 * ends at the end of the file, one starting at line 1 with context at its
 * start) and then the match nearest to the header's new start, the later one
 * on a tie; when no match satisfies the anchoring, the nearest match is taken.
 * @module dsh-apply-patch/apply/content
 */
import type { Chunk } from '../parse/types.js';
/**
 * Compute the new text of a file.
 * @param path - the path as written in the patch, for messages.
 * @param before - the current file text.
 * @param chunks - the chunks in file order.
 * @param format - the patch format.
 * @returns the new file text.
 * @throws {@link PatchError} `PATCH_CONFLICT` when a chunk cannot be located unambiguously.
 */
export declare function applyChunks(path: string, before: string, chunks: readonly Chunk[], format: 'unified' | 'codex'): string;
