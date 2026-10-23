/**
 * Git and unified diff parser.
 *
 * A hunk body is read by its header counts: while the hunk still expects old
 * or new lines, every ` `, `-` or `+` line is payload, also one that looks like
 * a `---`/`+++` file header, and a blank line is an empty context line.
 * `\ No newline at end of file` may follow any hunk line. A CR before the LF
 * belongs to the line, as in git. File headers and git metadata are recognized
 * only between hunks. The parser is lenient where models are sloppy, but never
 * so that lines are silently dropped:
 *
 * - text before the first header and between files (prose, a ```diff fence, `Index:` lines) is skipped;
 * - a hunk may end before its counts are reached at the end of the text, at the next hunk header or at `diff --git`; its trailing unprefixed blank lines are then separators. Such a hunk is rejected when its body contains a `---`/`+++` pair, which may have been the next file's header;
 * - an unprefixed line inside a counted hunk, and a `-` or `+` line right after a hunk whose counts are reached, are rejected with their line number;
 * - `@@ @@` and `@@` without line numbers are accepted; such a hunk ends at the first line that is not ` `, `-`, `+` or `\`, or at a `---`/`+++` pair;
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
  const lines = text.split('\n')
  const sections: Section[] = []
  let current: Section | undefined
  const open = (start: number): Section => {
    current = { start, newFile: false, deletedFile: false, chunks: [] }
    sections.push(current)
    return current
  }

  let i = 0
  while (i < lines.length) {
    const line = withoutCr(lines[i])
    if (line.startsWith('diff --git ')) {
      const section = open(i + 1)
      const paths = splitGitPaths(line.slice('diff --git '.length))
      if (paths !== undefined) { section.gitOld = paths[0]; section.gitNew = paths[1] }
      i += 1
      continue
    }
    if (isFileHeader(lines, i)) {
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
    // Anything else between hunks (prose, fences, index/mode lines, blank separators) is skipped.
    i += 1
  }

  const ops = sections.map(toOp).filter((op): op is PatchOp => op !== null)
  if (ops.length === 0) throw parseError(0, 'the diff contains no file changes')
  return { format: 'unified', ops }
}

function withoutCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

/** A `--- ` line directly followed by a `+++ ` line. */
function isFileHeader(lines: readonly string[], i: number): boolean {
  return lines[i].startsWith('--- ') && lines[i + 1]?.startsWith('+++ ') === true
}

/** Parse one hunk starting at its header; returns the chunk and the index of the first line after it. */
function parseHunk(lines: string[], at: number, header: RegExpExecArray): { chunk: Chunk; next: number } {
  const chunk: Chunk = { labels: [], oldLines: [], newLines: [], context: [], endOfFile: false }
  const counted = header[1] !== undefined
  let oldLeft = Infinity
  let newLeft = Infinity
  if (counted) {
    chunk.oldStart = Number(header[1])
    chunk.oldCount = oldLeft = header[2] === undefined ? 1 : Number(header[2])
    chunk.newStart = Number(header[3])
    newLeft = header[4] === undefined ? 1 : Number(header[4])
  }
  const declared = `"${header[0]}" at line ${at + 1}`
  let last: '-' | '+' | ' ' | undefined
  let blankTail = 0
  let swallowedHeader = false
  let i = at + 1
  for (; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.startsWith('\\')) {
      if (last === '-') chunk.oldNoNewline = true
      else if (last === '+') chunk.newNoNewline = true
      else if (last === ' ') { chunk.oldNoNewline = true; chunk.newNoNewline = true }
      continue
    }
    if (oldLeft === 0 && newLeft === 0) break
    if (!counted && isFileHeader(lines, i)) break
    const blank = line === '' || line === '\r'
    const kind = blank ? ' ' : line.charAt(0)
    if (kind === ' ' || kind === '-' || kind === '+') {
      if (blank && !counted) break
      if ((kind !== '+' && oldLeft === 0) || (kind !== '-' && newLeft === 0)) {
        if (blank) break
        throw parseError(i + 1, `the hunk ${declared} has more ${kind === '+' ? 'new' : 'old'} lines than its header declares; make the "@@" counts match the lines`)
      }
      if (counted && isFileHeader(lines, i)) swallowedHeader = true
      const body = blank ? line : line.slice(1)
      if (kind === ' ') chunk.context.push([chunk.oldLines.length, chunk.newLines.length])
      if (kind !== '+') { chunk.oldLines.push(body); oldLeft -= 1 }
      if (kind !== '-') { chunk.newLines.push(body); newLeft -= 1 }
      last = kind
      blankTail = blank ? blankTail + 1 : 0
      continue
    }
    if (!counted || HUNK.test(withoutCr(line)) || line.startsWith('diff --git ')) break
    throw parseError(i + 1, `${JSON.stringify(line.slice(0, 60))} is not a hunk line, but the hunk ${declared} still expects ${oldLeft} old and ${newLeft} new line(s). Start every hunk line with " ", "-" or "+", and make the "@@" counts match the lines.`)
  }
  if (counted && (oldLeft > 0 || newLeft > 0)) {
    if (swallowedHeader) throw parseError(at + 1, `the counts of the hunk ${declared} do not match its lines, and its lines contain a "---"/"+++" pair that may be the next file's header; make the "@@" counts match the lines`)
    // A hunk that ends early: its trailing blank lines are separators.
    chunk.oldLines.length -= blankTail
    chunk.newLines.length -= blankTail
    chunk.context.length -= blankTail
  } else if (counted && i < lines.length && /^[-+]/.test(lines[i]) && !isFileHeader(lines, i)) {
    throw parseError(i + 1, `more change lines follow the hunk ${declared} than its header declares; make the "@@" counts match the lines`)
  }
  if (chunk.oldLines.length === 0 && chunk.newLines.length === 0) throw parseError(at + 1, 'the hunk has no lines')
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
    return { kind: 'delete', path: requirePath(oldPath, section), chunks: section.chunks }
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

/** Decode a git C-style quoted path, including octal UTF-8 escapes, by code point; unquoted text is returned trimmed. */
export function unquote(raw: string): string {
  const text = raw.trim()
  if (!(text.length >= 2 && text.startsWith('"') && text.endsWith('"'))) return text
  const bytes: number[] = []
  const simple: Record<string, number> = { n: 10, t: 9, r: 13, '"': 34, '\\': 92, a: 7, b: 8, f: 12, v: 11 }
  const chars = Array.from(text.slice(1, -1))
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]
    if (ch !== '\\') { bytes.push(...Buffer.from(ch, 'utf8')); continue }
    const octal = /^[0-7]{1,3}/.exec(chars.slice(i + 1, i + 4).join(''))?.[0]
    const next = chars[i + 1]
    if (octal !== undefined) {
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
