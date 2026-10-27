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
import { PatchError, quote } from '../errors.js';
import { AMBIGUOUS_SHOWN, seek } from './seek.js';
/**
 * A chunk that cannot be placed in the file. `referenceRejects` tells whether
 * codex-rs or `git apply` would refuse it too; it is false for an ambiguous
 * tolerant Codex match (codex-rs takes the first) and for a context-free
 * unified hunk away from where git puts it.
 */
export class PlacementError extends PatchError {
    referenceRejects;
    constructor(message, referenceRejects) {
        super('PATCH_CONFLICT', message);
        this.referenceRejects = referenceRejects;
    }
}
/**
 * Compute the new text of a file.
 * @param path - the path as written in the patch, for messages.
 * @param before - the current file text.
 * @param chunks - the chunks in file order.
 * @param format - the patch format.
 * @returns the new file text.
 * @throws {@link PatchError} `PATCH_CONFLICT` when a chunk cannot be located unambiguously.
 */
export function applyChunks(path, before, chunks, format) {
    return format === 'codex' ? applyCodex(path, before, chunks) : applyUnified(path, before, chunks);
}
const BOM = '\uFEFF';
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
export function applyToFile(path, text, chunks, format) {
    try {
        return applyChunks(path, text, chunks, format);
    }
    catch (error) {
        if (!text.startsWith(BOM) || !(error instanceof PlacementError) || !error.referenceRejects)
            throw error;
        return BOM + applyChunks(path, text.slice(1), chunks, format);
    }
}
function applyCodex(path, before, chunks) {
    const lines = split(before, /\r\n|\r|\n/g);
    const eol = lines.find(line => line.eol !== '')?.eol ?? '\n';
    const texts = lines.map(line => line.text);
    const fresh = (text) => ({ text, eol });
    const replacements = [];
    let cursor = 0;
    chunks.forEach((chunk, k) => {
        const label = `change ${k + 1} of "${path}"`;
        for (const text of chunk.labels) {
            const found = seek(texts, [text], cursor);
            if (found.kind === 'none') {
                throw new PlacementError(`Could not find the "@@ ${text}" line of ${label} at or after line ${cursor + 1}. ${orderNote(k)}`.trimEnd(), true);
            }
            cursor = (found.kind === 'found' ? found.index : found.indices[0]) + 1;
        }
        if (chunk.oldLines.length === 0) {
            replacements.push({ index: texts.length, oldLength: 0, newLines: chunk.newLines.map(fresh) });
            return;
        }
        let found = { kind: 'none' };
        let variant = { old: chunk.oldLines, neu: chunk.newLines };
        for (const candidate of codexVariants(chunk)) {
            found = seek(texts, candidate.old, cursor, { endOfFile: chunk.endOfFile });
            if (found.kind !== 'none') {
                variant = candidate;
                break;
            }
        }
        if (found.kind === 'ambiguous') {
            throw new PlacementError(`The lines of ${label} match ${found.indices.length < AMBIGUOUS_SHOWN ? found.indices.length : `${AMBIGUOUS_SHOWN} or more`} places only after ignoring whitespace or punctuation (lines ${found.indices.map(i => i + 1).join(', ')}). Copy the lines exactly as they are in the file, or add more context lines.`, false);
        }
        if (found.kind === 'none')
            throw mismatch(label, texts, chunk, cursor, k, '');
        for (const r of splitAtContext(found.index, variant.old, variant.neu, chunk.context, fresh))
            replacements.push(r);
        cursor = found.index + variant.old.length;
    });
    return rebuild(lines, replacements).map(line => line.text + (line.eol === '' ? eol : line.eol)).join('');
}
/** The old/new line pairs a Codex chunk is searched with, in order. */
function* codexVariants(chunk) {
    const { oldLines: old, newLines: neu } = chunk;
    yield { old, neu };
    if (old.at(-1) !== '')
        return;
    // codex-rs: the last blank line may stand for the final newline of the file.
    yield { old: old.slice(0, -1), neu: neu.at(-1) === '' ? neu.slice(0, -1) : neu };
    const tail = chunk.blankTail ?? 0;
    if (tail > 1)
        yield { old: old.slice(0, -tail), neu: neu.slice(0, -tail) };
}
/**
 * The replacements of one matched chunk, leaving its context lines untouched
 * (codex-rs `context_line_indices`); context beyond a shortened variant is ignored.
 */
function splitAtContext(index, old, neu, context, fresh) {
    const out = [];
    let oldFrom = 0;
    let newFrom = 0;
    const push = (oldTo, newTo) => {
        if (oldFrom !== oldTo || newFrom !== newTo)
            out.push({ index: index + oldFrom, oldLength: oldTo - oldFrom, newLines: neu.slice(newFrom, newTo).map(fresh) });
    };
    for (const [o, n] of context) {
        if (o >= old.length || n >= neu.length)
            break;
        push(o, n);
        oldFrom = o + 1;
        newFrom = n + 1;
    }
    push(old.length, neu.length);
    return out;
}
/**
 * Apply the hunks to one mutable line array. Each hunk replaces its lines in
 * place, and image lines are hashed only when a placement compares them, so a
 * hunk costs its own size plus the places tried, not the size of the file.
 */
function applyUnified(path, before, chunks) {
    const image = split(before, /\n/g).map(line => ({ ...line, patched: false }));
    let cursor = 0;
    chunks.forEach((chunk, k) => {
        const old = side(chunk.oldLines, chunk.oldUnterminated);
        const neu = side(chunk.newLines, chunk.newUnterminated);
        const at = chunk.oldStart === undefined ? placeUnnumbered(path, image, chunk, old, cursor, k) : place(path, image, chunk, old, k);
        replace(image, at, old.length, neu.map(line => ({ ...line, patched: true })));
        cursor = at + neu.length;
    });
    return image.map(line => line.text + line.eol).join('');
}
/** Largest number of items passed to `splice` as arguments; argument spreads overflow the stack for very large hunks. */
const SPLICE_ITEMS = 4096;
/** Replace `count` lines of `image` at `at` by `items`. */
function replace(image, at, count, items) {
    if (items.length <= SPLICE_ITEMS) {
        image.splice(at, count, ...items);
        return;
    }
    const tail = image.slice(at + count);
    image.length = at;
    for (const line of items)
        image.push(line);
    for (const line of tail)
        image.push(line);
}
/** Lines of one side of a hunk; a line followed by `\ No newline at end of file` has no LF. */
function side(texts, unterminated) {
    return texts.map((text, i) => ({ text, eol: unterminated?.includes(i) === true ? '' : '\n' }));
}
const key = (line) => line.text + line.eol;
/** Whether `old` matches the unpatched image lines starting at `at`. */
function fits(image, old, at) {
    return at + old.length <= image.length && old.every((line, j) => !image[at + j].patched && key(image[at + j]) === key(line));
}
/**
 * git's line hash (`apply.c` `hash_line`): over the UTF-8 bytes, skipping
 * git's `isspace` bytes (TAB, LF, CR, space).
 */
function gitHash(text) {
    let hash = 0;
    for (const byte of Buffer.from(text, 'utf8'))
        if (byte !== 0x09 && byte !== 0x0A && byte !== 0x0D && byte !== 0x20)
            hash = (hash * 3 + byte) >>> 0;
    return hash;
}
function imageHash(line) {
    return line.hash ??= gitHash(key(line));
}
/**
 * The old lines of a hunk as plain `git apply` matches them (`match_fragment`):
 * each old line must hash like the unpatched image line at its index, and the
 * old lines' bytes, joined, must be a prefix of the image bytes from the first
 * one on (with `atEnd`, reach exactly to the end). A line followed by `\ No
 * newline at end of file` has no LF, so git also matches it against a line
 * that has one and joins the next line onto the new text; without such lines
 * this is exactly {@link fits}.
 */
function gitMatcher(old) {
    const hashes = old.map(line => gitHash(key(line)));
    const bytes = old.map(key).join('');
    return (image, at, atEnd) => {
        if (at + old.length > image.length)
            return false;
        for (let j = 0; j < old.length; j += 1)
            if (image[at + j].patched || imageHash(image[at + j]) !== hashes[j])
                return false;
        let pos = 0;
        let i = at;
        for (; pos < bytes.length; i += 1) {
            if (i === image.length)
                return false;
            const { text, eol } = image[i];
            if (text.length + eol.length > bytes.length - pos)
                return !atEnd && key(image[i]).startsWith(bytes.slice(pos));
            if (!bytes.startsWith(text, pos) || !bytes.startsWith(eol, pos + text.length))
                return false;
            pos += text.length + eol.length;
        }
        if (!atEnd)
            return true;
        for (; i < image.length; i += 1)
            if (image[i].text.length + image[i].eol.length > 0)
                return false;
        return true;
    };
}
/**
 * Where plain `git apply` (`apply_one_fragment`, `find_pos`) puts a hunk with
 * line numbers. A hunk whose header starts at line 0 or 1 must start at the
 * beginning of the file; a hunk without context after its last change must end
 * at its end; there is no fallback when that fails. The search starts at the
 * header's new start and alternates forward and backward, so of two equally
 * distant places the later one wins; places are compared as git compares them
 * ({@link gitMatcher}). A hunk is applied only where its lines also match exactly:
 * where git would match a line marked `\ No newline at end of file` against a
 * line with a newline (and join lines), the hunk is refused. A hunk without any
 * context (`git diff -U0`) is accepted only where its header points, since git
 * anchors it to the end of the file regardless, or when its old lines span the
 * whole current text (a new file's first hunk, a whole deletion), which leaves
 * git only one place.
 * @throws {@link PatchError} `PATCH_CONFLICT` when git would reject the hunk, would join lines, or would place a context-free hunk elsewhere.
 */
function place(path, image, chunk, old, k) {
    const label = `change ${k + 1} of "${path}"`;
    const trailing = trailingContext(chunk);
    const atStart = (chunk.oldStart ?? 0) <= 1;
    const atEnd = trailing === 0;
    const matches = gitMatcher(old);
    const ok = (at) => (!atStart || at === 0) && (!atEnd || at + old.length === image.length) && matches(image, at, atEnd);
    const n = image.length;
    let line = atStart ? 0 : atEnd ? n - old.length : Math.max(0, (chunk.newStart ?? 1) - 1);
    if (line < 0 || line > n)
        line = n;
    let backward = line;
    let forward = line;
    let at = line;
    for (let i = 0; !ok(at); i += 1) {
        if (backward === 0 && forward === n) {
            at = -1;
            break;
        }
        at = (i % 2 === 1 && backward > 0) || forward === n ? (backward -= 1) : (forward += 1);
    }
    const advice = 'Include the unchanged lines around each change as context (as git diff does by default), or use the Codex patch format.';
    if (at >= 0 && !fits(image, old, at)) {
        throw new PlacementError(`A line of ${label} is followed by "\\ No newline at end of file", but git apply would match it at line ${at + 1} against a line that ends with a newline and join the next line onto the new text. Drop the marker if the file line has a newline, or add context lines so that the hunk matches only at the end of the file, or use the Codex patch format.`, false);
    }
    if (at >= 0 && chunk.context.length > 0)
        return at;
    if (at >= 0) {
        const expected = chunk.newCount === 0 ? chunk.newStart ?? 0 : (chunk.newStart ?? 1) - 1;
        if (at === expected || old.length === n)
            return at;
        throw new PlacementError(`The hunk of ${label} has no context lines (like "git diff -U0" output); git apply would place it at line ${at + 1}, not at line ${expected + 1} where its header points. ${advice}`, false);
    }
    const anywhere = firstFit(image, old, 0);
    if (anywhere < 0)
        throw unifiedMismatch(path, image, chunk, 0, k, false);
    const rule = atStart && atEnd ? 'cover the whole file' : atStart ? 'start at the beginning of the file' : 'end at the end of the file';
    const why = [atStart ? `its header starts at line ${chunk.oldStart ?? 0}` : '', atEnd ? 'it has no context lines after its last change' : ''].filter(Boolean).join(' and ');
    throw new PlacementError(`The lines of ${label} occur at line ${anywhere + 1}, but git apply requires this hunk to ${rule}, because ${why}. ${advice}`, true);
}
/** A hunk without line numbers (`@@ @@`, accepted beyond git): the first match after the previous hunk; a pure addition appends. */
function placeUnnumbered(path, image, chunk, old, cursor, k) {
    if (old.length === 0)
        return image.length;
    const at = firstFit(image, old, cursor);
    if (at < 0)
        throw unifiedMismatch(path, image, chunk, cursor, k, true);
    return at;
}
/**
 * The first index at or after `from` where {@link fits} holds, or -1: one
 * Knuth-Morris-Pratt pass over the image, so the time is linear in the image
 * and `old` however many near matches the image has. A patched image line
 * equals no line of `old`. An empty `old` fits at `from` when that is a line of the image.
 */
function firstFit(image, old, from) {
    if (old.length === 0)
        return from < image.length ? from : -1;
    const same = (a, b) => a.text === b.text && a.eol === b.eol;
    // fail[j]: length of the longest proper prefix of old[0..j] that is also its suffix.
    const fail = new Int32Array(old.length);
    for (let j = 1, q = 0; j < old.length; j += 1) {
        while (q > 0 && !same(old[j], old[q]))
            q = fail[q - 1];
        if (same(old[j], old[q]))
            q += 1;
        fail[j] = q;
    }
    const equal = (i, q) => !image[i].patched && same(image[i], old[q]);
    for (let i = from, q = 0; i < image.length; i += 1) {
        while (q > 0 && !equal(i, q))
            q = fail[q - 1];
        if (equal(i, q))
            q += 1;
        if (q === old.length)
            return i - old.length + 1;
    }
    return -1;
}
/** Context lines after the last change, as git counts them. */
function trailingContext(chunk) {
    const { context, oldLines, newLines } = chunk;
    let trailing = 0;
    while (trailing < context.length) {
        const [o, n] = context[context.length - 1 - trailing];
        if (o !== oldLines.length - 1 - trailing || n !== newLines.length - 1 - trailing)
            break;
        trailing += 1;
    }
    return trailing;
}
/** Mismatch error of a unified hunk; `ordered` hunks (without line numbers) are searched after the previous one. */
function unifiedMismatch(path, lines, chunk, cursor, k, ordered) {
    const bare = (text) => text.endsWith('\r') ? text.slice(0, -1) : text;
    const loose = seek(lines.map(line => bare(line.text)), chunk.oldLines.map(bare), cursor);
    let advice = '';
    if (loose.kind !== 'none') {
        const at = loose.kind === 'found' ? loose.index : loose.indices[0];
        const crlf = chunk.oldLines.some((text, j) => !text.endsWith('\r') && lines[at + j].text.endsWith('\r'));
        advice = crlf
            ? 'The file has CRLF line endings, but these diff lines do not carry the CR; a unified diff compares line endings like git. Use the Codex patch format, which keeps each line\'s ending.'
            : 'The lines match only when ignoring whitespace, punctuation, a line ending, or lines changed by an earlier hunk; a unified diff must match the file exactly. Copy the lines exactly, add "\\ No newline at end of file" after a last line without a newline, or use the Codex patch format.';
    }
    return mismatch(`change ${k + 1} of "${path}"`, lines.map(line => line.text), chunk, cursor, ordered ? k : 0, advice);
}
function split(text, terminator) {
    const lines = [];
    let start = 0;
    for (const match of text.matchAll(terminator)) {
        lines.push({ text: text.slice(start, match.index), eol: match[0] });
        start = match.index + match[0].length;
    }
    if (start < text.length)
        lines.push({ text: text.slice(start), eol: '' });
    return lines;
}
/** Apply non-overlapping replacements; a stable sort keeps appends at the end in chunk order. */
function rebuild(lines, replacements) {
    // Loops, not push(...lines): argument spreads overflow the stack for files with very many lines.
    const out = [];
    let at = 0;
    for (const r of [...replacements].sort((a, b) => a.index - b.index)) {
        for (; at < r.index; at++)
            out.push(lines[at]);
        for (const line of r.newLines)
            out.push(line);
        at = r.index + r.oldLength;
    }
    for (; at < lines.length; at++)
        out.push(lines[at]);
    return out;
}
function orderNote(k) {
    return k > 0 ? 'Changes must be listed in file order.' : '';
}
/** Context-mismatch error: the expected lines and the file near the most likely place. */
function mismatch(label, lines, chunk, cursor, k, advice) {
    const oldLines = chunk.oldLines;
    const anchor = oldLines.find(line => line.trim() !== '');
    let near = chunk.oldStart === undefined ? cursor : Math.max(cursor, chunk.oldStart - 1);
    if (anchor !== undefined) {
        const at = lines.findIndex((line, i) => i >= cursor && line.trim() === anchor.trim());
        if (at >= 0)
            near = at;
    }
    const from = Math.max(0, near - 2);
    const excerpt = lines.slice(from, from + Math.min(12, oldLines.length + 4)).map((line, i) => `${from + i + 1}: ${quote(line)}`);
    return new PlacementError([
        `Could not find the lines of ${label} at or after line ${cursor + 1}${chunk.endOfFile ? ' at the end of the file' : ''}. ${orderNote(k)}`.trimEnd(),
        'Expected (context and removed lines):',
        ...oldLines.slice(0, 12).map(quote),
        oldLines.length > 12 ? `… ${oldLines.length - 12} more` : '',
        excerpt.length > 0 ? `The file near line ${near + 1}:` : 'The file has no lines there.',
        ...excerpt,
        advice === '' ? 'Read the file again and rebuild the change from its current lines.' : advice,
    ].filter(line => line !== '').join('\n'), true);
}
