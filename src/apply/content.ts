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

import { PatchError, quote } from '../errors.js'
import type { Chunk } from '../parse/types.js'
import { seek } from './seek.js'
import type { SeekResult } from './seek.js'

/** A file line and its terminator (`''` for an unterminated last line). */
interface Line { text: string; eol: string }
interface Replacement { index: number; oldLength: number; newLines: Line[] }

/**
 * Compute the new text of a file.
 * @param path - the path as written in the patch, for messages.
 * @param before - the current file text.
 * @param chunks - the chunks in file order.
 * @param format - the patch format.
 * @returns the new file text.
 * @throws {@link PatchError} `PATCH_CONFLICT` when a chunk cannot be located unambiguously.
 */
export function applyChunks(path: string, before: string, chunks: readonly Chunk[], format: 'unified' | 'codex'): string {
  return format === 'codex' ? applyCodex(path, before, chunks) : applyUnified(path, before, chunks)
}

function applyCodex(path: string, before: string, chunks: readonly Chunk[]): string {
  const lines = split(before, /\r\n|\r|\n/g)
  const eol = lines.find(line => line.eol !== '')?.eol ?? '\n'
  const texts = lines.map(line => line.text)
  const fresh = (text: string): Line => ({ text, eol })
  const replacements: Replacement[] = []
  let cursor = 0
  chunks.forEach((chunk, k) => {
    const label = `change ${k + 1} of "${path}"`
    for (const text of chunk.labels) {
      const found = seek(texts, [text], cursor)
      if (found.kind === 'none') {
        throw new PatchError('PATCH_CONFLICT', `Could not find the "@@ ${text}" line of ${label} at or after line ${cursor + 1}. ${orderNote(k)}`.trimEnd())
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
      found = seek(texts, candidate.old, cursor, { endOfFile: chunk.endOfFile })
      if (found.kind !== 'none') { variant = candidate; break }
    }
    if (found.kind === 'ambiguous') {
      throw new PatchError('PATCH_CONFLICT', `The lines of ${label} match ${found.indices.length} places only after ignoring whitespace or punctuation (lines ${found.indices.slice(0, 5).map(i => i + 1).join(', ')}). Copy the lines exactly as they are in the file, or add more context lines.`)
    }
    if (found.kind === 'none') throw mismatch(label, texts, chunk, cursor, k, '')
    replacements.push(...splitAtContext(found.index, variant.old, variant.neu, chunk.context, fresh))
    cursor = found.index + variant.old.length
  })
  return rebuild(lines, replacements).map(line => line.text + (line.eol === '' ? eol : line.eol)).join('')
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

function applyUnified(path: string, before: string, chunks: readonly Chunk[]): string {
  const lines = split(before, /\n/g)
  const keys = lines.map(line => line.text + line.eol)
  const replacements: Replacement[] = []
  let cursor = 0
  let growth = 0
  chunks.forEach((chunk, k) => {
    const old = side(chunk.oldLines, chunk.oldNoNewline)
    const neu = side(chunk.newLines, chunk.newNoNewline)
    const index = old.length === 0
      // `@@ -N,0 +M @@` inserts after old line N; a header without numbers appends.
      ? chunk.oldStart === undefined ? lines.length : Math.min(lines.length, Math.max(cursor, chunk.oldStart))
      : locate(path, lines, keys, chunk, old.map(line => line.text + line.eol), cursor, growth, k)
    replacements.push({ index, oldLength: old.length, newLines: neu })
    cursor = index + old.length
    growth += neu.length - old.length
  })
  const out = rebuild(lines, replacements)
  if (out.slice(0, -1).some(line => line.eol === '')) {
    throw new PatchError('PATCH_CONFLICT', `The diff for "${path}" leaves a line without a newline before other lines; "\\ No newline at end of file" belongs only to the last line of the file.`)
  }
  return out.map(line => line.text + line.eol).join('')
}

/** Lines of one side of a hunk; the last lacks its LF after a no-newline marker. */
function side(texts: readonly string[], noNewline: boolean | undefined): Line[] {
  return texts.map((text, i) => ({ text, eol: noNewline === true && i === texts.length - 1 ? '' : '\n' }))
}

/** Index of the exact match git would choose for a unified hunk. */
function locate(path: string, lines: readonly Line[], keys: readonly string[], chunk: Chunk, old: readonly string[], cursor: number, growth: number, k: number): number {
  const hits: number[] = []
  for (let i = cursor; i + old.length <= keys.length; i += 1) {
    if (old.every((key, j) => keys[i + j] === key)) hits.push(i)
  }
  if (hits.length === 0) throw unifiedMismatch(path, lines, chunk, cursor, k)
  const context = new Set(chunk.context.map(([o]) => o))
  let leading = 0
  while (leading < old.length && context.has(leading)) leading += 1
  let trailing = 0
  while (trailing < old.length && context.has(old.length - 1 - trailing)) trailing += 1
  // A hunk without any context is read as `-U0` output, which git does not anchor.
  const counted = chunk.oldStart !== undefined
  const zero = leading === 0 && trailing === 0
  const atStart = counted && (chunk.oldStart === 0 || (chunk.oldStart === 1 && !zero))
  const atEnd = counted && !zero && trailing === 0
  const anchored = hits.filter(i => (!atStart || i === 0) && (!atEnd || i + old.length === keys.length))
  const pool = anchored.length > 0 ? anchored : hits
  const hint = chunk.newStart !== undefined ? Math.max(0, chunk.newStart - 1 - growth) : cursor
  return pool.reduce((best, i) => Math.abs(i - hint) <= Math.abs(best - hint) ? i : best)
}

function unifiedMismatch(path: string, lines: readonly Line[], chunk: Chunk, cursor: number, k: number): PatchError {
  const bare = (text: string) => text.endsWith('\r') ? text.slice(0, -1) : text
  const loose = seek(lines.map(line => bare(line.text)), chunk.oldLines.map(bare), cursor)
  let advice = ''
  if (loose.kind !== 'none') {
    const at = loose.kind === 'found' ? loose.index : loose.indices[0]
    const crlf = chunk.oldLines.some((text, j) => !text.endsWith('\r') && lines[at + j].text.endsWith('\r'))
    advice = crlf
      ? 'The file has CRLF line endings, but these diff lines do not carry the CR; a unified diff compares line endings like git. Use the Codex patch format, which keeps each line\'s ending.'
      : 'The lines match only when ignoring whitespace, punctuation or a missing final newline; a unified diff must match the file exactly. Copy the lines exactly, add "\\ No newline at end of file" after a last line without a newline, or use the Codex patch format.'
  }
  return mismatch(`change ${k + 1} of "${path}"`, lines.map(line => line.text), chunk, cursor, k, advice)
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
  const out: Line[] = []
  let at = 0
  for (const r of [...replacements].sort((a, b) => a.index - b.index)) {
    out.push(...lines.slice(at, r.index), ...r.newLines)
    at = r.index + r.oldLength
  }
  out.push(...lines.slice(at))
  return out
}

function orderNote(k: number): string {
  return k > 0 ? 'Changes must be listed in file order.' : ''
}

/** Context-mismatch error: the expected lines and the file near the most likely place. */
function mismatch(label: string, lines: readonly string[], chunk: Chunk, cursor: number, k: number, advice: string): PatchError {
  const oldLines = chunk.oldLines
  const anchor = oldLines.find(line => line.trim() !== '')
  let near = chunk.oldStart === undefined ? cursor : Math.max(cursor, chunk.oldStart - 1)
  if (anchor !== undefined) {
    const at = lines.findIndex((line, i) => i >= cursor && line.trim() === anchor.trim())
    if (at >= 0) near = at
  }
  const from = Math.max(0, near - 2)
  const excerpt = lines.slice(from, from + Math.min(12, oldLines.length + 4)).map((line, i) => `${from + i + 1}: ${quote(line)}`)
  return new PatchError('PATCH_CONFLICT', [
    `Could not find the lines of ${label} at or after line ${cursor + 1}${chunk.endOfFile ? ' at the end of the file' : ''}. ${orderNote(k)}`.trimEnd(),
    'Expected (context and removed lines):',
    ...oldLines.slice(0, 12).map(quote),
    oldLines.length > 12 ? `… ${oldLines.length - 12} more` : '',
    excerpt.length > 0 ? `The file near line ${near + 1}:` : 'The file has no lines there.',
    ...excerpt,
    advice === '' ? 'Read the file again and rebuild the change from its current lines.' : advice,
  ].filter(line => line !== '').join('\n'))
}
