/**
 * Applying the chunks of one update to the file's text.
 *
 * Chunks are applied in file order: each is searched at or after the end of the
 * previous one. Line endings follow the file's majority (CRLF or LF), and the
 * final newline is kept unless a unified `\ No newline at end of file` marker
 * at the end of the file says otherwise.
 * @module dsh-apply-patch/apply/content
 */
import type { Chunk } from '../parse/types.js';
/**
 * Compute the new text of a file.
 * @param path - the path as written in the patch, for messages.
 * @param before - the current file text.
 * @param chunks - the chunks in file order.
 * @param format - the patch format; only unified diffs carry newline markers and line hints.
 * @returns the new file text.
 * @throws {@link PatchError} `PATCH_CONFLICT` when a chunk cannot be located unambiguously.
 */
export declare function applyChunks(path: string, before: string, chunks: readonly Chunk[], format: 'unified' | 'codex'): string;
