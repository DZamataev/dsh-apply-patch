/**
 * Patch representation shared by the Codex and unified-diff parsers. Both
 * parsers produce {@link ParsedPatch}, so planning and application have one path.
 * @module dsh-apply-patch/parse/types
 */

/**
 * One change region of an update. `oldLines` must be found in the file and is
 * replaced by `newLines`; both include the region's context lines.
 */
export interface Chunk {
  /**
   * Codex `@@ <label>` lines in order. Each label is located as one line at or
   * after the cursor; the chunk is searched after the last label.
   */
  labels: string[]
  oldLines: string[]
  newLines: string[]
  /** Codex `*** End of File`: the chunk must end at the end of the file. */
  endOfFile: boolean
  /**
   * Unified hunk header old start (1-based) and count. A search hint only:
   * the match nearest to it wins, and a pure insertion (`oldCount` 0) goes
   * after line `oldStart`.
   */
  oldStart?: number
  oldCount?: number
  /** `\ No newline at end of file` after a removed or context line. */
  oldNoNewline?: boolean
  /** `\ No newline at end of file` after an added or context line. */
  newNoNewline?: boolean
}

/** One file operation. */
export type PatchOp =
  | { kind: 'add'; path: string; content: string }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo?: string; chunks: Chunk[] }

/** A parsed patch. */
export interface ParsedPatch {
  format: 'unified' | 'codex'
  ops: PatchOp[]
}
