/**
 * Patch representation shared by the Codex and unified-diff parsers. Both
 * parsers produce {@link ParsedPatch}, so planning and application have one path.
 * @module dsh-apply-patch/parse/types
 */
/**
 * One change region of an update. `oldLines` must be found in the file and is
 * replaced by `newLines`; both include the region's context lines. Unified
 * diff lines keep a CR that precedes the LF in the diff text.
 */
export interface Chunk {
    /**
     * Codex `@@ <label>` lines in order. Each label is located as one line at or
     * after the cursor; the chunk is searched after the last label.
     */
    labels: string[];
    oldLines: string[];
    newLines: string[];
    /** `[old index, new index]` of every context line, ascending; the file keeps its own text for these lines. */
    context: [number, number][];
    /** Codex `*** End of File`: the chunk must end at the end of the file. */
    endOfFile: boolean;
    /**
     * Codex: how many of the last context lines were blank patch lines without
     * a prefix. They are dropped when the chunk matches nowhere with them.
     */
    blankTail?: number;
    /** Unified hunk header old start (1-based) and count. */
    oldStart?: number;
    oldCount?: number;
    /** Unified hunk header new start (1-based); git searches from this line. */
    newStart?: number;
    /** `\ No newline at end of file` after a removed or context line. */
    oldNoNewline?: boolean;
    /** `\ No newline at end of file` after an added or context line. */
    newNoNewline?: boolean;
}
/** One file operation. */
export type PatchOp = {
    kind: 'add';
    path: string;
    content: string;
}
/** `chunks` (unified diffs only) must remove the whole current file text. */
 | {
    kind: 'delete';
    path: string;
    chunks?: Chunk[];
} | {
    kind: 'update';
    path: string;
    moveTo?: string;
    chunks: Chunk[];
};
/** A parsed patch. */
export interface ParsedPatch {
    format: 'unified' | 'codex';
    ops: PatchOp[];
}
