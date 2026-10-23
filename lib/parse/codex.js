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
 * Those two and the operation headers are compared after trimming surrounding
 * whitespace; `@@` and `*** End of File` inside an update only after trimming
 * trailing whitespace, so an indented one is a context line. Two or more `@@`
 * lines in a row stack labels and a first chunk may omit `@@` (codex-rs rejects
 * stacked labels).
 * @module dsh-apply-patch/parse/codex
 */
import { parseError } from '../errors.js';
const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const ADD = '*** Add File: ';
const DELETE = '*** Delete File: ';
const UPDATE = '*** Update File: ';
const MOVE = '*** Move to: ';
const EOF = '*** End of File';
/**
 * Parse a Codex patch.
 * @param text - the patch text.
 * @returns the parsed patch.
 * @throws {@link PatchError} `PATCH_PARSE` with the failing line.
 */
export function parseCodexPatch(text) {
    const all = text.replaceAll('\r\n', '\n').split('\n');
    const begin = all.findIndex(line => line.trim() === BEGIN);
    let end = -1;
    for (let i = all.length - 1; i > begin; i -= 1)
        if (all[i].trim() === END) {
            end = i;
            break;
        }
    if (begin < 0)
        throw parseError(0, `the patch must start with "${BEGIN}"`);
    if (end < 0)
        throw parseError(0, `the patch must end with "${END}"`);
    const ops = [];
    let i = begin + 1;
    const lineNo = (index) => index + 1;
    while (i < end) {
        const line = all[i];
        const marker = line.trim();
        if (marker === '') {
            i += 1;
            continue;
        }
        if (line.startsWith(ADD)) {
            const path = requirePath(line.slice(ADD.length), lineNo(i), ADD);
            const content = [];
            i += 1;
            while (i < end && all[i].startsWith('+')) {
                content.push(all[i].slice(1));
                i += 1;
            }
            if (i < end && !isOpHeader(all[i]) && all[i].trim() !== '') {
                throw parseError(lineNo(i), `every content line of "${path}" must start with "+"; got ${JSON.stringify(all[i].slice(0, 60))}`);
            }
            ops.push({ kind: 'add', path, content: content.length === 0 ? '' : `${content.join('\n')}\n` });
            continue;
        }
        if (line.startsWith(DELETE)) {
            ops.push({ kind: 'delete', path: requirePath(line.slice(DELETE.length), lineNo(i), DELETE) });
            i += 1;
            continue;
        }
        if (line.startsWith(UPDATE)) {
            const path = requirePath(line.slice(UPDATE.length), lineNo(i), UPDATE);
            const start = i;
            i += 1;
            let moveTo;
            if (i < end && all[i].startsWith(MOVE)) {
                moveTo = requirePath(all[i].slice(MOVE.length), lineNo(i), MOVE);
                i += 1;
            }
            const chunks = [];
            while (i < end && !isOpHeader(all[i])) {
                const parsed = parseChunk(all, i, end, path, chunks.length === 0);
                if (parsed.chunk !== null)
                    chunks.push(parsed.chunk);
                i = parsed.next;
            }
            if (chunks.length === 0 && moveTo === undefined)
                throw parseError(lineNo(start), `the update of "${path}" has no changes`);
            ops.push({ kind: 'update', path, ...moveTo === undefined ? {} : { moveTo }, chunks });
            continue;
        }
        throw parseError(lineNo(i), `expected "${ADD}", "${UPDATE}", "${DELETE}" or "${END}"; got ${JSON.stringify(line.slice(0, 60))}`);
    }
    if (ops.length === 0)
        throw parseError(lineNo(begin), 'the patch contains no file operations');
    return { format: 'codex', ops };
}
function requirePath(raw, lineNo, header) {
    const path = raw.trim();
    if (path === '')
        throw parseError(lineNo, `"${header.trim()}" needs a file path`);
    return path;
}
function isOpHeader(line) {
    return line.startsWith(ADD) || line.startsWith(DELETE) || line.startsWith(UPDATE);
}
/**
 * Parse one chunk: its `@@` labels, body lines and an optional `*** End of File`.
 * As in codex-rs, a label is the text after `@@ ` without trailing whitespace,
 * markers inside the body are recognized only unindented (trailing whitespace
 * ignored), and an unprefixed blank line is a blank context line. A chunk of
 * nothing but unprefixed blank lines separates operations and yields `null`.
 */
function parseChunk(all, start, end, path, first) {
    let i = start;
    const labels = [];
    for (; i < end && (all[i].trimEnd() === '@@' || all[i].startsWith('@@ ')); i += 1) {
        const label = all[i].trimEnd().slice(3);
        if (label !== '')
            labels.push(label);
    }
    if (i < end && all[i].startsWith('@@')) {
        throw parseError(i + 1, `an @@ line must be "@@" alone or "@@ " followed by a line of the file; write "@@ " and the line, got ${JSON.stringify(all[i].slice(0, 60))}`);
    }
    if (i === start && !first) {
        throw parseError(start + 1, `expected an "@@" line before the next change in "${path}"; got ${JSON.stringify(all[i].slice(0, 60))}`);
    }
    const chunk = { labels, oldLines: [], newLines: [], context: [], endOfFile: false };
    let changed = false;
    let blankTail = 0;
    for (; i < end; i += 1) {
        const line = all[i];
        if (line.trimEnd() === EOF) {
            chunk.endOfFile = true;
            // Blank lines after the marker separate it from the next "@@" or operation.
            for (i += 1; i < end && all[i].trimEnd() === ''; i += 1)
                ;
            break;
        }
        if (line.startsWith('@@') || isOpHeader(line))
            break;
        if (line.startsWith('*** '))
            throw parseError(i + 1, `unknown marker ${JSON.stringify(line.slice(0, 60))}`);
        const kind = line.charAt(0);
        const body = line.slice(1);
        if (kind === ' ' || line === '') {
            chunk.context.push([chunk.oldLines.length, chunk.newLines.length]);
            chunk.oldLines.push(body);
            chunk.newLines.push(body);
        }
        else if (kind === '-') {
            chunk.oldLines.push(body);
            changed = true;
        }
        else if (kind === '+') {
            chunk.newLines.push(body);
            changed = true;
        }
        else
            throw parseError(i + 1, `a change line in "${path}" must start with " ", "-" or "+"; got ${JSON.stringify(line.slice(0, 60))}`);
        blankTail = line === '' ? blankTail + 1 : 0;
    }
    if (!changed) {
        if (chunk.oldLines.length === blankTail && labels.length === 0 && !chunk.endOfFile)
            return { chunk: null, next: i };
        throw parseError(start + 1, `a change in "${path}" has no "-" or "+" lines`);
    }
    if (blankTail > 0)
        chunk.blankTail = blankTail;
    return { chunk, next: i };
}
