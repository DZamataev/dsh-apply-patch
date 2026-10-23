/**
 * Git and unified diff parser. It is lenient where models are sloppy:
 *
 * - text before the first header (prose, a ```diff fence, `Index:` lines) is skipped;
 * - hunk header counts are hints only: a hunk ends at the next header, and blank
 *   lines between hunks or at the end are separators;
 * - `@@ @@` and `@@` without line numbers are accepted;
 * - a tab-separated timestamp after a path is dropped, and quoted C-style paths are decoded.
 *
 * A file is renamed only by git `rename from`/`rename to` headers. Two differing
 * `---`/`+++` names without them (`foo.c.orig` and `foo.c`) patch the `+++` file.
 * @module dsh-apply-patch/parse/unified
 */

import { parseError } from '../errors.js'
import type { Chunk, ParsedPatch, PatchOp } from './types.js'

interface Section {
  start: number
  gitOld?: string
  gitNew?: string
  oldPath?: string | null
  newPath?: string | null
  newFile: boolean
  deletedFile: boolean
  renameFrom?: string
  renameTo?: string
  chunks: Chunk[]
}

const HUNK = /^@@(?: -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?)? ?@@/

/**
 * Parse a git or unified diff.
 * @param text - the diff text.
 * @returns the parsed patch.
 * @throws {@link PatchError} `PATCH_PARSE` with the failing line.
 */
export function parseUnifiedDiff(text: string): ParsedPatch {
  const lines = text.replaceAll('\r\n', '\n').split('\n')
  const sections: Section[] = []
  let current: Section | undefined
  const open = (start: number): Section => {
    current = { start, newFile: false, deletedFile: false, chunks: [] }
    sections.push(current)
    return current
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.startsWith('diff --git ')) {
      const section = open(i + 1)
      const paths = splitGitPaths(line.slice('diff --git '.length))
      if (paths !== undefined) { section.gitOld = paths[0]; section.gitNew = paths[1] }
      i += 1
      continue
    }
    if (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      const section = current !== undefined && current.oldPath === undefined && current.chunks.length === 0 ? current : open(i + 1)
      section.oldPath = headerPath(line.slice(4))
      section.newPath = headerPath(lines[i + 1].slice(4))
      i += 2
      continue
    }
    const hunk = HUNK.exec(line)
    if (hunk !== null) {
      const section = current ?? open(i + 1)
      const parsed = parseHunk(lines, i, hunk)
      section.chunks.push(parsed.chunk)
      i = parsed.next
      continue
    }
    if (current !== undefined) {
      if (line.startsWith('new file mode')) current.newFile = true
      else if (line.startsWith('deleted file mode')) current.deletedFile = true
      else if (line.startsWith('rename from ')) current.renameFrom = unquote(line.slice('rename from '.length))
      else if (line.startsWith('rename to ')) current.renameTo = unquote(line.slice('rename to '.length))
      else if (line.startsWith('copy from ') || line.startsWith('copy to ')) throw parseError(i + 1, 'git copy headers are not supported; write the new file with "+" lines instead')
      else if (line.startsWith('Binary files ') || line === 'GIT binary patch') throw parseError(i + 1, 'binary patches are not supported')
    }
    // Anything else (prose, fences, index/mode lines, blank separators) is skipped.
    i += 1
  }

  const ops = sections.map(toOp).filter((op): op is PatchOp => op !== null)
  if (ops.length === 0) throw parseError(0, 'the diff contains no file changes')
  return { format: 'unified', ops }
}

/** Parse one hunk starting at its header; returns the chunk and the next line index. */
function parseHunk(lines: string[], headerIndex: number, header: RegExpExecArray): { chunk: Chunk; next: number } {
  const chunk: Chunk = { labels: [], oldLines: [], newLines: [], endOfFile: false }
  if (header[1] !== undefined) {
    chunk.oldStart = Number(header[1])
    chunk.oldCount = header[2] === undefined ? 1 : Number(header[2])
  }
  let oldLeft = chunk.oldCount ?? Infinity
  let newLeft = header[4] === undefined ? (header[3] === undefined ? Infinity : 1) : Number(header[4])
  let last: '-' | '+' | ' ' | undefined
  let i = headerIndex + 1
  for (; i < lines.length; i += 1) {
    const line = lines[i]
    if (HUNK.test(line) || line.startsWith('diff --git ') || (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ '))) break
    if (line.startsWith('\\')) {
      if (last === '-') chunk.oldNoNewline = true
      else if (last === '+') chunk.newNoNewline = true
      else if (last === ' ') { chunk.oldNoNewline = true; chunk.newNoNewline = true }
      continue
    }
    const kind = line.charAt(0)
    if (line === '') {
      // A blank line is context only while the header still expects lines on both sides.
      if (oldLeft > 0 && newLeft > 0 && oldLeft !== Infinity && newLeft !== Infinity) {
        chunk.oldLines.push(''); chunk.newLines.push(''); oldLeft -= 1; newLeft -= 1; last = ' '
        continue
      }
      break
    }
    if (kind === ' ') { chunk.oldLines.push(line.slice(1)); chunk.newLines.push(line.slice(1)); oldLeft -= 1; newLeft -= 1; last = ' ' }
    else if (kind === '-') { chunk.oldLines.push(line.slice(1)); oldLeft -= 1; last = '-' }
    else if (kind === '+') { chunk.newLines.push(line.slice(1)); newLeft -= 1; last = '+' }
    else break
  }
  if (chunk.oldLines.length === 0 && chunk.newLines.length === 0) throw parseError(headerIndex + 1, 'the hunk has no lines')
  return { chunk, next: i }
}

/** Build the file operation of one section, or `null` for a section without changes. */
function toOp(section: Section): PatchOp | null {
  const oldPath = section.oldPath === undefined ? section.gitOld : section.oldPath
  const newPath = section.newPath === undefined ? section.gitNew : section.newPath
  if (section.newFile || (section.oldPath === null && newPath != null)) {
    const path = requirePath(newPath, section)
    for (const chunk of section.chunks) {
      if (chunk.oldLines.some((line, index) => chunk.newLines[index] !== line)) {
        throw parseError(section.start, `the new file "${path}" has removed lines`)
      }
    }
    const added = section.chunks.flatMap(chunk => chunk.newLines)
    const noNewline = section.chunks.at(-1)?.newNoNewline === true
    return { kind: 'add', path, content: added.length === 0 ? '' : `${added.join('\n')}${noNewline ? '' : '\n'}` }
  }
  if (section.deletedFile || (section.newPath === null && oldPath != null)) {
    return { kind: 'delete', path: requirePath(oldPath, section) }
  }
  const renamed = section.renameFrom !== undefined && section.renameTo !== undefined && section.renameFrom !== section.renameTo
  if (renamed) {
    return { kind: 'update', path: section.renameFrom as string, moveTo: section.renameTo, chunks: section.chunks }
  }
  if (section.chunks.length === 0) return null
  return { kind: 'update', path: requirePath(newPath ?? oldPath, section), chunks: section.chunks }
}

function requirePath(path: string | null | undefined, section: Section): string {
  if (path === undefined || path === null || path === '') throw parseError(section.start, 'a file section has no usable path')
  return path
}

/** Path of a `---`/`+++` header: drops a tab-separated timestamp, decodes quotes, strips `a/`/`b/`. */
function headerPath(raw: string): string | null {
  const token = unquote(raw.split('\t')[0].trimEnd())
  if (token === '/dev/null') return null
  return stripPrefix(token)
}

function stripPrefix(path: string): string {
  return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path
}

/** Split `a/x b/y` (or quoted forms) into the two prefix-stripped paths. */
function splitGitPaths(rest: string): [string, string] | undefined {
  if (rest.startsWith('"')) {
    const close = closingQuote(rest)
    if (close < 0) return undefined
    const first = unquote(rest.slice(0, close + 1))
    return [stripPrefix(first), stripPrefix(unquote(rest.slice(close + 1).trim()))]
  }
  const half = rest.indexOf(' b/')
  if (half < 0) return undefined
  return [stripPrefix(rest.slice(0, half)), stripPrefix(unquote(rest.slice(half + 1)))]
}

function closingQuote(text: string): number {
  for (let i = 1; i < text.length; i += 1) {
    if (text[i] === '\\') { i += 1; continue }
    if (text[i] === '"') return i
  }
  return -1
}

/** Decode a git C-style quoted path, including octal UTF-8 escapes; unquoted text is returned as is. */
export function unquote(raw: string): string {
  const text = raw.trim()
  if (!(text.length >= 2 && text.startsWith('"') && text.endsWith('"'))) return text
  const bytes: number[] = []
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 }
  const body = text.slice(1, -1)
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (ch !== '\\') { bytes.push(...Buffer.from(ch, 'utf8')); continue }
    const next = body[i + 1]
    if (next !== undefined && /[0-7]/.test(next)) {
      const octal = /^[0-7]{1,3}/.exec(body.slice(i + 1))?.[0] ?? next
      bytes.push(parseInt(octal, 8))
      i += octal.length
    } else if (next !== undefined && next in simple) {
      bytes.push(simple[next])
      i += 1
    } else {
      bytes.push(92)
    }
  }
  return Buffer.from(bytes).toString('utf8')
}
