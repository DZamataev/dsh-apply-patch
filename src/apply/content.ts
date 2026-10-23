/**
 * Applying the chunks of one update to the file's text.
 *
 * Chunks are applied in file order: each is searched at or after the end of the
 * previous one. Line endings follow the file's majority (CRLF or LF), and the
 * final newline is kept unless a unified `\ No newline at end of file` marker
 * at the end of the file says otherwise.
 * @module dsh-apply-patch/apply/content
 */

import { PatchError, quote } from '../errors.js'
import type { Chunk } from '../parse/types.js'
import { seek } from './seek.js'

interface Replacement { index: number; oldLength: number; newLines: string[]; chunk: Chunk }

/**
 * Compute the new text of a file.
 * @param path - the path as written in the patch, for messages.
 * @param before - the current file text.
 * @param chunks - the chunks in file order.
 * @param format - the patch format; only unified diffs carry newline markers and line hints.
 * @returns the new file text.
 * @throws {@link PatchError} `PATCH_CONFLICT` when a chunk cannot be located unambiguously.
 */
export function applyChunks(path: string, before: string, chunks: readonly Chunk[], format: 'unified' | 'codex'): string {
  const crlf = countOf(before, '\r\n') * 2 > countOf(before, '\n')
  const hadFinalNewline = before === '' || before.endsWith('\n')
  const lines = splitLines(before)
  const replacements: Replacement[] = []
  let cursor = 0

  chunks.forEach((chunk, k) => {
    const label = `change ${k + 1} of "${path}"`
    for (const text of chunk.labels) {
      const found = seek(lines, [text], cursor)
      if (found.kind === 'none') {
        throw new PatchError('PATCH_CONFLICT', `Could not find the "@@ ${text}" line of ${label} at or after line ${cursor + 1}. ${orderNote(k)}`)
      }
      cursor = (found.kind === 'found' ? found.index : found.indices[0]) + 1
    }
    let oldLines = chunk.oldLines
    let newLines = chunk.newLines
    let index: number
    if (oldLines.length === 0) {
      index = insertionPoint(chunk, cursor, lines.length, format)
    } else {
      const hint = chunk.oldStart === undefined ? undefined : Math.max(0, chunk.oldStart - 1)
      let found = seek(lines, oldLines, cursor, { endOfFile: chunk.endOfFile, hint })
      if (found.kind === 'none' && oldLines.at(-1) === '') {
        oldLines = oldLines.slice(0, -1)
        if (newLines.at(-1) === '') newLines = newLines.slice(0, -1)
        found = seek(lines, oldLines, cursor, { endOfFile: chunk.endOfFile, hint })
      }
      if (found.kind === 'ambiguous') {
        throw new PatchError('PATCH_CONFLICT', `The lines of ${label} match ${found.indices.length} places only after ignoring whitespace or punctuation (lines ${found.indices.slice(0, 5).map(i => i + 1).join(', ')}). Copy the lines exactly as they are in the file, or add more context lines.`)
      }
      if (found.kind === 'none') throw mismatch(label, lines, oldLines, cursor, chunk, k)
      index = found.index
    }
    replacements.push({ index, oldLength: oldLines.length, newLines, chunk })
    cursor = index + oldLines.length
  })

  const out = [...lines]
  for (const r of [...replacements].reverse()) out.splice(r.index, r.oldLength, ...r.newLines)
  if (out.length === 0) return ''

  let finalNewline = hadFinalNewline
  const last = replacements.at(-1)
  if (format === 'unified' && last !== undefined && last.index + last.oldLength === lines.length) {
    if (last.chunk.newNoNewline === true) finalNewline = false
    else if (last.chunk.oldNoNewline === true) finalNewline = true
  }
  const eol = crlf ? '\r\n' : '\n'
  return out.join(eol) + (finalNewline ? eol : '')
}

/** Where a chunk without old lines inserts its lines. */
function insertionPoint(chunk: Chunk, cursor: number, length: number, format: 'unified' | 'codex'): number {
  if (chunk.endOfFile) return length
  // Unified `@@ -N,0 +M @@` inserts after old line N.
  if (format === 'unified' && chunk.oldStart !== undefined) return Math.min(length, Math.max(cursor, chunk.oldStart))
  // Codex: after the last `@@` label line, else at the end of the file (codex-rs).
  return chunk.labels.length > 0 ? cursor : length
}

function splitLines(text: string): string[] {
  if (text === '') return []
  const body = text.endsWith('\n') ? text.slice(0, -1) : text
  return body.split('\n').map(line => line.endsWith('\r') ? line.slice(0, -1) : line)
}

function countOf(text: string, needle: string): number {
  let n = 0
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) n += 1
  return n
}

function orderNote(k: number): string {
  return k > 0 ? 'Changes must be listed in file order.' : ''
}

/** Context-mismatch error: the expected lines and the file near the most likely place. */
function mismatch(label: string, lines: readonly string[], oldLines: readonly string[], cursor: number, chunk: Chunk, k: number): PatchError {
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
    'Read the file again and rebuild the change from its current lines.',
  ].filter(line => line !== '').join('\n'))
}
