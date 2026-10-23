/**
 * Patch format detection, run before parsing.
 * @module dsh-apply-patch/detect
 */
import { unrecognizedError } from './errors.js';
/**
 * Classify patch text: a `*** Begin Patch` line anywhere means Codex; a
 * `diff --git` line, a `---`/`+++` pair or a hunk header means unified diff.
 * @param text - the patch text.
 * @returns the format.
 * @throws {@link PatchError} `PATCH_PARSE` with a Codex example for anything else.
 */
export function detectFormat(text) {
    const lines = text.replaceAll('\r\n', '\n').split('\n');
    if (lines.some(line => line.trim() === '*** Begin Patch'))
        return 'codex';
    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (line.startsWith('diff --git ') || /^@@ -\d+/.test(line))
            return 'unified';
        if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ '))
            return 'unified';
    }
    throw unrecognizedError();
}
