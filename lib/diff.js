/**
 * Compact display diffs: only the changed region of a file plus a few context
 * lines, so a small edit in a large file still shows a diff card.
 * @module dsh-apply-patch/diff
 */
const CONTEXT = 3;
/**
 * Cut `before`/`after` down to the lines between their common prefix and suffix, plus context.
 * @param path - display path.
 * @param before - old text, or `null` for a new file.
 * @param after - new text, or `null` for a deleted file.
 * @param maxBytes - UTF-8 byte limit for the two texts together.
 * @returns the display diff.
 */
export function compactDiff(path, before, after, maxBytes) {
    const oldLines = before === null ? [] : before.split('\n');
    const newLines = after === null ? [] : after.split('\n');
    let head = 0;
    while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head])
        head += 1;
    let tail = 0;
    while (tail < oldLines.length - head && tail < newLines.length - head
        && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail])
        tail += 1;
    const from = Math.max(0, head - CONTEXT);
    const oldText = before === null ? null : oldLines.slice(from, Math.min(oldLines.length, oldLines.length - tail + CONTEXT)).join('\n');
    const newText = newLines.slice(from, Math.min(newLines.length, newLines.length - tail + CONTEXT)).join('\n');
    const size = Buffer.byteLength(oldText ?? '', 'utf8') + Buffer.byteLength(newText, 'utf8');
    if (size > maxBytes)
        return { path, oldText: before === null ? null : '', newText: '', truncated: true };
    return { path, oldText, newText };
}
