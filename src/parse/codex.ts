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
 * Marker lines are compared after trimming surrounding whitespace.
 * @module dsh-apply-patch/parse/codex
 */

import { parseError } from '../errors.js'
import type { Chunk, ParsedPatch, PatchOp } from './types.js'

const BEGIN = '*** Begin Patch'
const END = '*** End Patch'
const ADD = '*** Add File: '
const DELETE = '*** Delete File: '
const UPDATE = '*** Update File: '
const MOVE = '*** Move to: '
const EOF = '*** End of File'

/**
 * Parse a Codex patch.
 * @param text - the patch text.
 * @returns the parsed patch.
 * @throws {@link PatchError} `PATCH_PARSE` with the failing line.
 */
export function parseCodexPatch(text: string): ParsedPatch {
  const all = text.replaceAll('\r\n', '\n').split('\n')
  const begin = all.findIndex(line => line.trim() === BEGIN)
  let end = -1
  for (let i = all.length - 1; i > begin; i -= 1) if (all[i].trim() === END) { end = i; break }
  if (begin < 0) throw parseError(0, `the patch must start with "${BEGIN}"`)
  if (end < 0) throw parseError(0, `the patch must end with "${END}"`)

  const ops: PatchOp[] = []
  let i = begin + 1
  const lineNo = (index: number) => index + 1
  while (i < end) {
    const line = all[i]
    const marker = line.trim()
    if (marker === '') { i += 1; continue }
    if (line.startsWith(ADD)) {
      const path = requirePath(line.slice(ADD.length), lineNo(i), ADD)
      const content: string[] = []
      i += 1
      while (i < end && all[i].startsWith('+')) { content.push(all[i].slice(1)); i += 1 }
      if (i < end && !isOpHeader(all[i]) && all[i].trim() !== '') {
        throw parseError(lineNo(i), `every content line of "${path}" must start with "+"; got ${JSON.stringify(all[i].slice(0, 60))}`)
      }
      ops.push({ kind: 'add', path, content: content.length === 0 ? '' : `${content.join('\n')}\n` })
      continue
    }
    if (line.startsWith(DELETE)) {
      ops.push({ kind: 'delete', path: requirePath(line.slice(DELETE.length), lineNo(i), DELETE) })
      i += 1
      continue
    }
    if (line.startsWith(UPDATE)) {
      const path = requirePath(line.slice(UPDATE.length), lineNo(i), UPDATE)
      const start = i
      i += 1
      let moveTo: string | undefined
      if (i < end && all[i].startsWith(MOVE)) {
        moveTo = requirePath(all[i].slice(MOVE.length), lineNo(i), MOVE)
        i += 1
      }
      const chunks: Chunk[] = []
      while (i < end && !isOpHeader(all[i])) {
        const parsed = parseChunk(all, i, end, path, chunks.length === 0)
        if (parsed.chunk !== null) chunks.push(parsed.chunk)
        i = parsed.next
      }
      if (chunks.length === 0 && moveTo === undefined) throw parseError(lineNo(start), `the update of "${path}" has no changes`)
      ops.push({ kind: 'update', path, ...moveTo === undefined ? {} : { moveTo }, chunks })
      continue
    }
    throw parseError(lineNo(i), `expected "${ADD}", "${UPDATE}", "${DELETE}" or "${END}"; got ${JSON.stringify(line.slice(0, 60))}`)
  }
  if (ops.length === 0) throw parseError(lineNo(begin), 'the patch contains no file operations')
  return { format: 'codex', ops }
}

function requirePath(raw: string, lineNo: number, header: string): string {
  const path = raw.trim()
  if (path === '') throw parseError(lineNo, `"${header.trim()}" needs a file path`)
  return path
}

function isOpHeader(line: string): boolean {
  return line.startsWith(ADD) || line.startsWith(DELETE) || line.startsWith(UPDATE)
}

/** Parse one chunk: its `@@` labels, body lines and an optional `*** End of File`. */
function parseChunk(all: string[], start: number, end: number, path: string, first: boolean): { chunk: Chunk | null; next: number } {
  let i = start
  const labels: string[] = []
  while (i < end && all[i].startsWith('@@')) {
    const label = all[i].slice(2).trim()
    if (label !== '') labels.push(label)
    i += 1
  }
  if (i === start && !first) {
    throw parseError(start + 1, `expected an "@@" line before the next change in "${path}"; got ${JSON.stringify(all[i].slice(0, 60))}`)
  }
  const oldLines: string[] = []
  const newLines: string[] = []
  let changed = false
  let endOfFile = false
  while (i < end) {
    const line = all[i]
    if (line.trim() === EOF) { endOfFile = true; i += 1; break }
    if (line.startsWith('@@') || isOpHeader(line)) break
    if (line.startsWith('*** ')) throw parseError(i + 1, `unknown marker ${JSON.stringify(line.slice(0, 60))}`)
    const kind = line.charAt(0)
    const body = line.slice(1)
    if (kind === ' ' || line === '') { oldLines.push(body); newLines.push(body) }
    else if (kind === '-') { oldLines.push(body); changed = true }
    else if (kind === '+') { newLines.push(body); changed = true }
    else throw parseError(i + 1, `a change line in "${path}" must start with " ", "-" or "+"; got ${JSON.stringify(line.slice(0, 60))}`)
    i += 1
  }
  // Blank lines before the next operation or the end are separators, not context.
  while (oldLines.length > 0 && newLines.length > 0 && oldLines.at(-1) === '' && newLines.at(-1) === ''
    && blankRunEndsSection(all, i)) {
    oldLines.pop()
    newLines.pop()
  }
  if (!changed) {
    if (oldLines.length === 0 && newLines.length === 0 && labels.length === 0 && !endOfFile) return { chunk: null, next: i }
    throw parseError(start + 1, `a change in "${path}" has no "-" or "+" lines`)
  }
  return { chunk: { labels, oldLines, newLines, endOfFile }, next: i }
}

/** True when the chunk stopped at an operation header or the end, so trailing blank lines are separators. */
function blankRunEndsSection(all: string[], next: number): boolean {
  const line = all[next]
  return line === undefined || isOpHeader(line) || line.trim() === END
}
