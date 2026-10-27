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

import type { TextEdit } from '../diff.js'
import { PatchError, quote } from '../errors.js'
import type { Chunk } from '../parse/types.js'
import { AMBIGUOUS_SHOWN, LineSearch, seek } from './seek.js'
import type { SeekResult } from './seek.js'

/**
 * A chunk that cannot be placed in the file. `referenceRejects` tells whether
 * codex-rs or `git apply` would refuse it too; it is false for an ambiguous
 * tolerant Codex match (codex-rs takes the first) and for a context-free
 * unified hunk away from where git puts it.
 */
export class PlacementError extends PatchError {
  constructor(message: string, readonly referenceRejects: boolean) {
    super('PATCH_CONFLICT', message)
  }
}

/** A file line and its terminator (`''` for an unterminated last line). */
interface Line { text: string; eol: string }
interface Replacement { index: number; oldLength: number; newLines: Line[] }

/** A new file text and the edits that turned the old text into it, in order and disjoint. */
export interface Patched { text: string; edits: TextEdit[] }

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
export function editChunks(path: string, before: string, chunks: readonly Chunk[], format: 'unified' | 'codex'): Patched {
  return format === 'codex' ? applyCodex(path, before, chunks) : applyUnified(path, before, chunks)
}

/**
 * Compute the new text of a file ({@link editChunks} without the edits).
 * @param path - the path as written in the patch, for messages.
 * @param before - the current file text.
 * @param chunks - the chunks in file order.
 * @param format - the patch format.
 * @returns the new file text.
 * @throws {@link PatchError} `PATCH_CONFLICT` when a chunk cannot be located unambiguously.
 */
export function applyChunks(path: string, before: string, chunks: readonly Chunk[], format: 'unified' | 'codex'): string {
  return editChunks(path, before, chunks, format).text
}

const BOM = '\uFEFF'

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
export function applyToFile(path: string, text: string, chunks: readonly Chunk[], format: 'unified' | 'codex'): string {
  return editFile(path, text, chunks, format).text
}

/**
 * {@link applyToFile} with the edits that made the new text, in offsets of the whole texts.
 * @param path - the path as written in the patch, for messages.
 * @param text - the whole file text.
 * @param chunks - the chunks in file order.
 * @param format - the patch format.
 * @returns the new file text and its edits.
 * @throws {@link PatchError} `PATCH_CONFLICT` as {@link applyToFile}.
 */
export function editFile(path: string, text: string, chunks: readonly Chunk[], format: 'unified' | 'codex'): Patched {
  try {
    return editChunks(path, text, chunks, format)
  } catch (error: unknown) {
    if (!text.startsWith(BOM) || !(error instanceof PlacementError) || !error.referenceRejects) throw error
    const patched = editChunks(path, text.slice(1), chunks, format)
    const shift = (edit: TextEdit): TextEdit => ({ oldFrom: edit.oldFrom + 1, oldTo: edit.oldTo + 1, newFrom: edit.newFrom + 1, newTo: edit.newTo + 1 })
    return { text: BOM + patched.text, edits: patched.edits.map(shift) }
  }
}

function applyCodex(path: string, before: string, chunks: readonly Chunk[]): Patched {
  const lines = split(before, /\r\n|\r|\n/g)
  const eol = lines.find(line => line.eol !== '')?.eol ?? '\n'
  const texts = lines.map(line => line.text)
  const search = new LineSearch(texts)
  const fresh = (text: string): Line => ({ text, eol })
  const replacements: Replacement[] = []
  let cursor = 0
  chunks.forEach((chunk, k) => {
    const label = `change ${k + 1} of "${path}"`
    for (const text of chunk.labels) {
      const found = search.seek([text], cursor)
      if (found.kind === 'none') {
        throw new PlacementError(`Could not find the "@@ ${text}" line of ${label} at or after line ${cursor + 1}. ${orderNote(k)}`.trimEnd(), true)
      }
      cursor = (found.kind === 'found' ? found.index : found.indices[0]) + 1
    }
    if (chunk.oldLines.length === 0) {
      replacements.push({ index: texts.length, oldLength: 0, newLines: chunk.newLines.map(fresh) })
      return
    }
    let found: SeekResult = { kind: 'none' }
    let variant = { old: chunk.oldLines, neu: chunk.newLines }
    for (const candidate of codexVariants(chunk)) {
      found = search.seek(candidate.old, cursor, { endOfFile: chunk.endOfFile })
      if (found.kind !== 'none') { variant = candidate; break }
    }
    if (found.kind === 'ambiguous') {
      throw new PlacementError(`The lines of ${label} match ${found.indices.length < AMBIGUOUS_SHOWN ? found.indices.length : `${AMBIGUOUS_SHOWN} or more`} places only after ignoring whitespace or punctuation (lines ${found.indices.map(i => i + 1).join(', ')}). Copy the lines exactly as they are in the file, or add more context lines.`, false)
    }
    if (found.kind === 'none') throw mismatch(label, texts, chunk, cursor, k, '')
    for (const r of splitAtContext(found.index, variant.old, variant.neu, chunk.context, fresh)) replacements.push(r)
    cursor = found.index + variant.old.length
  })
  const text = rebuild(lines, replacements).map(line => line.text + (line.eol === '' ? eol : line.eol)).join('')
  return { text, edits: codexEdits(lines, replacements, eol) }
}

/**
 * The edits of {@link rebuild} followed by the join of {@link applyCodex}: one per replacement,
 * and the line ending `eol` inserted after an untouched last line without one.
 */
function codexEdits(lines: readonly Line[], replacements: readonly Replacement[], eol: string): TextEdit[] {
  const edits: TextEdit[] = []
  let oldAt = 0
  let newAt = 0
  let at = 0
  const keep = (line: Line) => {
    const length = line.text.length + line.eol.length
    if (line.eol === '') edits.push({ oldFrom: oldAt + length, oldTo: oldAt + length, newFrom: newAt + length, newTo: newAt + length + eol.length })
    oldAt += length
    newAt += line.eol === '' ? length + eol.length : length
  }
  for (const r of [...replacements].sort((a, b) => a.index - b.index)) {
    for (; at < r.index; at++) keep(lines[at])
    let oldLength = 0
    for (; at < r.index + r.oldLength; at++) oldLength += lines[at].text.length + lines[at].eol.length
    let newLength = 0
    for (const line of r.newLines) newLength += line.text.length + (line.eol === '' ? eol : line.eol).length
    edits.push({ oldFrom: oldAt, oldTo: oldAt + oldLength, newFrom: newAt, newTo: newAt + newLength })
    oldAt += oldLength
    newAt += newLength
  }
  for (; at < lines.length; at++) keep(lines[at])
  return edits
}

/** The old/new line pairs a Codex chunk is searched with, in order. */
function* codexVariants(chunk: Chunk): Generator<{ old: string[]; neu: string[] }> {
  const { oldLines: old, newLines: neu } = chunk
  yield { old, neu }
  if (old.at(-1) !== '') return
  // codex-rs: the last blank line may stand for the final newline of the file.
  yield { old: old.slice(0, -1), neu: neu.at(-1) === '' ? neu.slice(0, -1) : neu }
  const tail = chunk.blankTail ?? 0
  if (tail > 1) yield { old: old.slice(0, -tail), neu: neu.slice(0, -tail) }
}

/**
 * The replacements of one matched chunk, leaving its context lines untouched
 * (codex-rs `context_line_indices`); context beyond a shortened variant is ignored.
 */
function splitAtContext(index: number, old: readonly string[], neu: readonly string[], context: readonly [number, number][], fresh: (text: string) => Line): Replacement[] {
  const out: Replacement[] = []
  let oldFrom = 0
  let newFrom = 0
  const push = (oldTo: number, newTo: number) => {
    if (oldFrom !== oldTo || newFrom !== newTo) out.push({ index: index + oldFrom, oldLength: oldTo - oldFrom, newLines: neu.slice(newFrom, newTo).map(fresh) })
  }
  for (const [o, n] of context) {
    if (o >= old.length || n >= neu.length) break
    push(o, n)
    oldFrom = o + 1
    newFrom = n + 1
  }
  push(old.length, neu.length)
  return out
}

/**
 * A line of the file image of a unified diff; `patched` lines come from an
 * applied hunk and are not matched again, the others keep their offset `from`
 * in the old text. `hash` caches {@link gitHash} of the line with its terminator.
 */
interface ImageLine extends Line { patched: boolean; from?: number; hash?: number }

/**
 * Apply the hunks to one mutable line array. Each hunk replaces its lines in
 * place, and image lines are hashed only when a placement compares them, so a
 * hunk costs its own size plus the places tried, not the size of the file.
 */
function applyUnified(path: string, before: string, chunks: readonly Chunk[]): Patched {
  let offset = 0
  const image: ImageLine[] = split(before, /\n/g).map(line => {
    const from = offset
    offset += line.text.length + line.eol.length
    return { ...line, patched: false, from }
  })
  let cursor = 0
  chunks.forEach((chunk, k) => {
    const old = side(chunk.oldLines, chunk.oldUnterminated)
    const neu = side(chunk.newLines, chunk.newUnterminated)
    const at = chunk.oldStart === undefined ? placeUnnumbered(path, image, chunk, old, cursor, k) : place(path, image, chunk, old, k)
    replace(image, at, old.length, neu.map(line => ({ ...line, patched: true })))
    cursor = at + neu.length
  })
  return { text: image.map(line => line.text + line.eol).join(''), edits: unifiedEdits(image, before.length) }
}

/** The edits that turned the old text of length `length` into `image`: each run of patched lines and each gap in the old offsets. */
function unifiedEdits(image: readonly ImageLine[], length: number): TextEdit[] {
  const edits: TextEdit[] = []
  let oldAt = 0
  let newAt = 0
  let run = -1
  for (const line of image) {
    const size = line.text.length + line.eol.length
    if (line.from === undefined) {
      if (run < 0) run = newAt
    } else {
      if (run >= 0 || line.from !== oldAt) edits.push({ oldFrom: oldAt, oldTo: line.from, newFrom: run < 0 ? newAt : run, newTo: newAt })
      run = -1
      oldAt = line.from + size
    }
    newAt += size
  }
  if (run >= 0 || oldAt !== length) edits.push({ oldFrom: oldAt, oldTo: length, newFrom: run < 0 ? newAt : run, newTo: newAt })
  return edits
}

/** Largest number of items passed to `splice` as arguments; argument spreads overflow the stack for very large hunks. */
const SPLICE_ITEMS = 4096

/** Replace `count` lines of `image` at `at` by `items`. */
function replace(image: ImageLine[], at: number, count: number, items: readonly ImageLine[]): void {
  if (items.length <= SPLICE_ITEMS) {
    image.splice(at, count, ...items)
    return
  }
  const tail = image.slice(at + count)
  image.length = at
  for (const line of items) image.push(line)
  for (const line of tail) image.push(line)
}

/** Lines of one side of a hunk; a line followed by `\ No newline at end of file` has no LF. */
function side(texts: readonly string[], unterminated: readonly number[] | undefined): Line[] {
  return texts.map((text, i) => ({ text, eol: unterminated?.includes(i) === true ? '' : '\n' }))
}

const key = (line: Line) => line.text + line.eol

/** Whether `old` matches the unpatched image lines starting at `at`. */
function fits(image: readonly ImageLine[], old: readonly Line[], at: number): boolean {
  return at + old.length <= image.length && old.every((line, j) => !image[at + j].patched && key(image[at + j]) === key(line))
}

/**
 * git's line hash (`apply.c` `hash_line`): over the UTF-8 bytes, skipping
 * git's `isspace` bytes (TAB, LF, CR, space).
 */
function gitHash(text: string): number {
  let hash = 0
  for (const byte of Buffer.from(text, 'utf8')) if (byte !== 0x09 && byte !== 0x0A && byte !== 0x0D && byte !== 0x20) hash = (hash * 3 + byte) >>> 0
  return hash
}

function imageHash(line: ImageLine): number {
  return line.hash ??= gitHash(key(line))
}

/**
 * The old lines of a hunk as plain `git apply` matches them (`match_fragment`):
 * each old line must hash like the unpatched image line at its index, and the
 * old lines' bytes, joined, must be a prefix of the image bytes from the first
 * one on (with `atEnd`, reach exactly to the end). Only the last old line can
 * lack its LF (`\ No newline at end of file`); git then also matches it
 * against an image line that only starts with it (one that has an LF, or more
 * text that hashes to nothing, such as trailing spaces) and joins the next line
 * onto the new text. Without such a line this is exactly {@link fits}.
 * `work` counts the lines compared, for {@link nearestMatch}.
 */
interface GitMatcher { test(image: readonly ImageLine[], at: number, atEnd: boolean): boolean; work: number }

function gitMatcher(old: readonly Line[]): GitMatcher {
  const hashes = old.map(line => gitHash(key(line)))
  const bytes = old.map(key).join('')
  const matcher: GitMatcher = {
    work: 0,
    test(image, at, atEnd) {
      matcher.work += 1
      if (at + old.length > image.length) return false
      for (let j = 0; j < old.length; j += 1) {
        matcher.work += 1
        if (image[at + j].patched || imageHash(image[at + j]) !== hashes[j]) return false
      }
      matcher.work += old.length
      let pos = 0
      let i = at
      for (; pos < bytes.length; i += 1) {
        if (i === image.length) return false
        const { text, eol } = image[i]
        if (text.length + eol.length > bytes.length - pos) return !atEnd && key(image[i]).startsWith(bytes.slice(pos))
        if (!bytes.startsWith(text, pos) || !bytes.startsWith(eol, pos + text.length)) return false
        pos += text.length + eol.length
      }
      if (!atEnd) return true
      for (; i < image.length; i += 1) if (image[i].text.length + image[i].eol.length > 0) return false
      return true
    },
  }
  return matcher
}

/**
 * Every start where {@link gitMatcher} holds (without `atEnd`), ascending, in
 * one Knuth-Morris-Pratt pass over the image: the old lines with an LF must
 * equal unpatched image lines exactly, and a last old line without an LF must
 * hash like an unpatched image line that starts with it.
 */
function gitMatches(image: readonly ImageLine[], old: readonly Line[]): number[] {
  const last = old.at(-1)
  if (last === undefined) return Array.from({ length: image.length + 1 }, (_, i) => i)
  if (last.eol !== '') return occurrences(image, old, 0, Infinity)
  const hash = gitHash(last.text)
  const lastFits = (line: ImageLine) => !line.patched && imageHash(line) === hash && key(line).startsWith(last.text)
  const m = old.length
  const heads = m === 1 ? Array.from({ length: image.length }, (_, i) => i) : occurrences(image, old.slice(0, -1), 0, Infinity)
  return heads.filter(start => start + m <= image.length && lastFits(image[start + m - 1]))
}

/**
 * The place of a hunk nearest to `line` in git's search order (`find_pos`):
 * `line`, then one line forward, one backward, two forward and so on, so of
 * two equally distant places the later one wins. Places are tried one by one,
 * as git does, while that costs at most about the size of the image; then all
 * places are found in one pass ({@link gitMatches}), so that a large hunk far
 * from its header in a repetitive file costs O(image + hunk) lines, not their
 * product.
 * @returns the place, or -1.
 */
function nearestMatch(image: readonly ImageLine[], old: readonly Line[], line: number, matcher: GitMatcher): number {
  const n = image.length
  const budget = 2 * (n + old.length) + 64
  matcher.work = 0
  let backward = line
  let forward = line
  let at = line
  for (let i = 0; !matcher.test(image, at, false); i += 1) {
    if (backward === 0 && forward === n) return -1
    if (matcher.work > budget) return nearest(gitMatches(image, old), line)
    at = (i % 2 === 1 && backward > 0) || forward === n ? (backward -= 1) : (forward += 1)
  }
  return at
}

/** Of ascending `places`, the one nearest to `line`, the later one of two equally near; -1 when there is none. */
function nearest(places: readonly number[], line: number): number {
  let low = 0
  let high = places.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (places[mid] < line) low = mid + 1
    else high = mid
  }
  const after = low < places.length ? places[low] : undefined
  const before = low > 0 ? places[low - 1] : undefined
  if (after === undefined) return before ?? -1
  return before === undefined || after - line <= line - before ? after : before
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
function place(path: string, image: readonly ImageLine[], chunk: Chunk, old: readonly Line[], k: number): number {
  const label = `change ${k + 1} of "${path}"`
  const trailing = trailingContext(chunk)
  const atStart = (chunk.oldStart ?? 0) <= 1
  const atEnd = trailing === 0
  const matcher = gitMatcher(old)
  const n = image.length
  let at: number
  if (atStart || atEnd) {
    // The only place git accepts.
    const only = atStart ? 0 : n - old.length
    at = only >= 0 && (!atEnd || only + old.length === n) && matcher.test(image, only, atEnd) ? only : -1
  } else {
    at = nearestMatch(image, old, Math.min(n, Math.max(0, (chunk.newStart ?? 1) - 1)), matcher)
  }
  const advice = 'Include the unchanged lines around each change as context (as git diff does by default), or use the Codex patch format.'
  if (at >= 0 && !fits(image, old, at)) {
    throw new PlacementError(`A line of ${label} is followed by "\\ No newline at end of file", but git apply would match it at line ${at + 1} against a line that ends with a newline and join the next line onto the new text. Drop the marker if the file line has a newline, or add context lines so that the hunk matches only at the end of the file, or use the Codex patch format.`, false)
  }
  if (at >= 0 && chunk.context.length > 0) return at
  if (at >= 0) {
    const expected = chunk.newCount === 0 ? chunk.newStart ?? 0 : (chunk.newStart ?? 1) - 1
    if (at === expected || old.length === n) return at
    throw new PlacementError(`The hunk of ${label} has no context lines (like "git diff -U0" output); git apply would place it at line ${at + 1}, not at line ${expected + 1} where its header points. ${advice}`, false)
  }
  const anywhere = firstFit(image, old, 0)
  if (anywhere < 0) throw unifiedMismatch(path, image, chunk, 0, k, false)
  const rule = atStart && atEnd ? 'cover the whole file' : atStart ? 'start at the beginning of the file' : 'end at the end of the file'
  const why = [atStart ? `its header starts at line ${chunk.oldStart ?? 0}` : '', atEnd ? 'it has no context lines after its last change' : ''].filter(Boolean).join(' and ')
  throw new PlacementError(`The lines of ${label} occur at line ${anywhere + 1}, but git apply requires this hunk to ${rule}, because ${why}. ${advice}`, true)
}

/** A hunk without line numbers (`@@ @@`, accepted beyond git): the first match after the previous hunk; a pure addition appends. */
function placeUnnumbered(path: string, image: readonly ImageLine[], chunk: Chunk, old: readonly Line[], cursor: number, k: number): number {
  if (old.length === 0) return image.length
  const at = firstFit(image, old, cursor)
  if (at < 0) throw unifiedMismatch(path, image, chunk, cursor, k, true)
  return at
}

/**
 * The first index at or after `from` where {@link fits} holds, or -1. An
 * empty `old` fits at `from` when that is a line of the image.
 */
function firstFit(image: readonly ImageLine[], old: readonly Line[], from: number): number {
  if (old.length === 0) return from < image.length ? from : -1
  return occurrences(image, old, from, 1)[0] ?? -1
}

/**
 * The first `limit` indices at or after `from` where the non-empty `old`
 * {@link fits}, ascending, overlapping ones included: one Knuth-Morris-Pratt
 * pass over the image, so the time is linear in the image and `old` however
 * many near matches the image has. A patched image line equals no line of `old`.
 */
function occurrences(image: readonly ImageLine[], old: readonly Line[], from: number, limit: number): number[] {
  const same = (a: Line, b: Line) => a.text === b.text && a.eol === b.eol
  // fail[j]: length of the longest proper prefix of old[0..j] that is also its suffix.
  const fail = new Int32Array(old.length)
  for (let j = 1, q = 0; j < old.length; j += 1) {
    while (q > 0 && !same(old[j], old[q])) q = fail[q - 1]
    if (same(old[j], old[q])) q += 1
    fail[j] = q
  }
  const equal = (i: number, q: number) => !image[i].patched && same(image[i], old[q])
  const found: number[] = []
  for (let i = from, q = 0; i < image.length && found.length < limit; i += 1) {
    while (q > 0 && !equal(i, q)) q = fail[q - 1]
    if (equal(i, q)) q += 1
    if (q === old.length) {
      found.push(i - old.length + 1)
      q = fail[q - 1]
    }
  }
  return found
}

/** Context lines after the last change, as git counts them. */
function trailingContext(chunk: Chunk): number {
  const { context, oldLines, newLines } = chunk
  let trailing = 0
  while (trailing < context.length) {
    const [o, n] = context[context.length - 1 - trailing]
    if (o !== oldLines.length - 1 - trailing || n !== newLines.length - 1 - trailing) break
    trailing += 1
  }
  return trailing
}

/** Mismatch error of a unified hunk; `ordered` hunks (without line numbers) are searched after the previous one. */
function unifiedMismatch(path: string, lines: readonly Line[], chunk: Chunk, cursor: number, k: number, ordered: boolean): PlacementError {
  const bare = (text: string) => text.endsWith('\r') ? text.slice(0, -1) : text
  const loose = seek(lines.map(line => bare(line.text)), chunk.oldLines.map(bare), cursor)
  let advice = ''
  if (loose.kind !== 'none') {
    const at = loose.kind === 'found' ? loose.index : loose.indices[0]
    const crlf = chunk.oldLines.some((text, j) => !text.endsWith('\r') && lines[at + j].text.endsWith('\r'))
    advice = crlf
      ? 'The file has CRLF line endings, but these diff lines do not carry the CR; a unified diff compares line endings like git. Use the Codex patch format, which keeps each line\'s ending.'
      : 'The lines match only when ignoring whitespace, punctuation, a line ending, or lines changed by an earlier hunk; a unified diff must match the file exactly. Copy the lines exactly, add "\\ No newline at end of file" after a last line without a newline, or use the Codex patch format.'
  }
  return mismatch(`change ${k + 1} of "${path}"`, lines.map(line => line.text), chunk, cursor, ordered ? k : 0, advice)
}

function split(text: string, terminator: RegExp): Line[] {
  const lines: Line[] = []
  let start = 0
  for (const match of text.matchAll(terminator)) {
    lines.push({ text: text.slice(start, match.index), eol: match[0] })
    start = match.index + match[0].length
  }
  if (start < text.length) lines.push({ text: text.slice(start), eol: '' })
  return lines
}

/** Apply non-overlapping replacements; a stable sort keeps appends at the end in chunk order. */
function rebuild(lines: readonly Line[], replacements: readonly Replacement[]): Line[] {
  // Loops, not push(...lines): argument spreads overflow the stack for files with very many lines.
  const out: Line[] = []
  let at = 0
  for (const r of [...replacements].sort((a, b) => a.index - b.index)) {
    for (; at < r.index; at++) out.push(lines[at])
    for (const line of r.newLines) out.push(line)
    at = r.index + r.oldLength
  }
  for (; at < lines.length; at++) out.push(lines[at])
  return out
}

function orderNote(k: number): string {
  return k > 0 ? 'Changes must be listed in file order.' : ''
}

/** Context-mismatch error: the expected lines and the file near the most likely place. */
function mismatch(label: string, lines: readonly string[], chunk: Chunk, cursor: number, k: number, advice: string): PlacementError {
  const oldLines = chunk.oldLines
  const anchor = oldLines.find(line => line.trim() !== '')
  let near = chunk.oldStart === undefined ? cursor : Math.max(cursor, chunk.oldStart - 1)
  if (anchor !== undefined) {
    const at = lines.findIndex((line, i) => i >= cursor && line.trim() === anchor.trim())
    if (at >= 0) near = at
  }
  const from = Math.max(0, near - 2)
  const excerpt = lines.slice(from, from + Math.min(12, oldLines.length + 4)).map((line, i) => `${from + i + 1}: ${quote(line)}`)
  return new PlacementError([
    `Could not find the lines of ${label} at or after line ${cursor + 1}${chunk.endOfFile ? ' at the end of the file' : ''}. ${orderNote(k)}`.trimEnd(),
    'Expected (context and removed lines):',
    ...oldLines.slice(0, 12).map(quote),
    oldLines.length > 12 ? `… ${oldLines.length - 12} more` : '',
    excerpt.length > 0 ? `The file near line ${near + 1}:` : 'The file has no lines there.',
    ...excerpt,
    advice === '' ? 'Read the file again and rebuild the change from its current lines.' : advice,
  ].filter(line => line !== '').join('\n'), true)
}
