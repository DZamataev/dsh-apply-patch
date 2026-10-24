/**
 * Git and unified diff parser.
 *
 * A hunk body is read by its header counts: while the hunk still expects old
 * or new lines, every ` `, `-` or `+` line is payload, also one that looks like
 * a `---`/`+++` file header, and a blank line is an empty context line.
 * `\ No newline at end of file` may follow any hunk line and removes the LF of
 * that line only, as in git. A CR before the LF belongs to the line, as in git.
 * File headers are recognized only between hunks. Git header lines (`index`,
 * modes, `new file mode`, `deleted file mode`, renames, `---`/`+++`) are read
 * only right after a `diff --git` line, up to the first line that is not one,
 * as `apply.c` `parse_git_diff_header` reads them; anywhere else (after a hunk,
 * before a bare `---`/`+++` pair) they are text git skips. A `diff --git` line
 * without header lines is such text too. A `diff --git` section without a hunk
 * right after its header lines must be a new file, a deletion, a rename or a
 * mode change. Between a bare `+++` header and the first hunk nothing may
 * stand. The parser is lenient where models are sloppy, but never so that lines
 * are silently dropped:
 *
 * - text before the first header and between files (prose, a ```diff fence, `Index:` lines) is skipped;
 * - a hunk may end before its counts are reached at the end of the text, at the next hunk header or at `diff --git`; its trailing unprefixed blank lines are then separators. Such a hunk is rejected when its body contains a `---`/`+++` pair, which may have been the next file's header;
 * - an unprefixed line inside a counted hunk, and a `-` or `+` line right after a hunk whose counts are reached, are rejected with their line number;
 * - a line starting with `\` is a newline marker only as git reads one ({@link isMarker}); inside a hunk any other such line is rejected, after a hunk it is skipped like other text there;
 * - `@@ @@` and `@@` without line numbers are accepted; such a hunk ends at the first line that is not ` `, `-`, `+` or `\`, or at a `---`/`+++` pair;
 * - the last line of the text may lack its LF (git rejects such a diff as corrupt);
 * - a path ends at a TAB (git writes one after a path ending in a space; `diff -u` puts a timestamp after it) or at the end of the line; spaces around it are part of the path. Quoted C-style paths are decoded. A CR at the end of a header line is dropped.
 *
 * In a `diff --git` section the file moves when its old and new names differ
 * (`rename from`/`rename to`, or differing `---`/`+++` names), as with git;
 * `---`/`+++ /dev/null` there needs the `new file mode`/`deleted file mode`
 * line. Two differing names of a bare `---`/`+++` pair (`foo.c.orig` and
 * `foo.c`) patch the `+++` file.
 * @module dsh-apply-patch/parse/unified
 */

import { parseError } from '../errors.js'
import type { Chunk, ParsedPatch, PatchOp } from './types.js'

interface Section {
  start: number
  /** A `diff --git` section: its names and flags come from its header lines. */
  git: boolean
  /** Old and new names; `null` is `/dev/null` (bare sections) or a side git leaves unnamed. */
  oldPath?: string | null
  newPath?: string | null
  newFile: boolean
  deletedFile: boolean
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

  /** Line number of the first text after a bare `+++` header that is not an `@@` hunk header. */
  let stray: number | undefined
  let i = 0
  while (i < lines.length) {
    const line = withoutCr(lines[i])
    if (line.startsWith('diff --git ')) {
      const header = parseGitHeader(lines, i)
      stray = undefined
      const next = header.next < lines.length ? withoutCr(lines[header.next]) : undefined
      if (next !== undefined && (next.startsWith('Binary files ') || next === 'GIT binary patch')) throw parseError(header.next + 1, 'binary patches are not supported')
      if (header.next === i + 1) {
        // Without header lines git reads the "diff --git" line as text; a hunk right after it has no file header.
        current = undefined
        i += 1
        continue
      }
      sections.push(current = header.section)
      i = header.next
      if (next !== undefined && HUNK.test(next)) continue
      if (!header.metadata) {
        throw header.section.newPath !== null
          ? parseError(i + 1, 'text between the "+++" header and the first "@@" hunk header; git apply rejects it. Put the "@@" line right after the "+++" line')
          : parseError(i < lines.length ? i + 1 : header.section.start, `the "diff --git" section at line ${header.section.start} has no "@@" hunk right after its header lines and no new file, deleted file or rename line; git apply rejects it`)
      }
      // A section without hunks (a rename, a new or deleted empty file) ends with its header lines.
      current = undefined
      continue
    }
    if (isFileHeader(lines, i)) {
      current = { start: i + 1, git: false, oldPath: headerPath(line.slice(4)), newPath: headerPath(withoutCr(lines[i + 1]).slice(4)), newFile: false, deletedFile: false, chunks: [] }
      sections.push(current)
      stray = i + 2 < lines.length && HUNK.test(withoutCr(lines[i + 2])) ? undefined : i + 3
      i += 2
      continue
    }
    const hunk = HUNK.exec(line)
    if (hunk !== null) {
      if (stray !== undefined) throw parseError(stray, 'text between the "+++" header and the first "@@" hunk header; git apply rejects it. Put the "@@" line right after the "+++" line')
      if (current === undefined) throw parseError(i + 1, 'the "@@" hunk has no file header; put "--- a/<path>" and "+++ b/<path>" lines (or "diff --git" header lines) right before it')
      const parsed = parseHunk(lines, i, hunk)
      current.chunks.push(parsed.chunk)
      i = parsed.next
      continue
    }
    // Anything else outside a git header (prose, fences, blank separators, git header lines after a hunk) is skipped, as git skips it.
    i += 1
  }

  const ops = sections.map(toOp).filter((op): op is PatchOp => op !== null)
  if (ops.length === 0) throw parseError(0, 'the diff contains no file changes')
  return { format: 'unified', ops }
}

/**
 * Read the header lines of a `diff --git` section as `apply.c`
 * `parse_git_diff_header` does: they end at `@@ -` or at the first line that is
 * not a git header line. `---`/`+++` names must agree with the names earlier
 * lines gave; a new or deleted file takes the `diff --git` name and needs
 * `/dev/null` on its other side; a rename needs both its names.
 * @returns the section without hunks, the index of the line after the header
 * lines, and whether the header changes more than file text (git accepts only
 * such a section without hunks).
 */
function parseGitHeader(lines: readonly string[], at: number): { section: Section; next: number; metadata: boolean } {
  const paths = splitGitPaths(withoutCr(lines[at]).slice('diff --git '.length))
  const defaultName = paths !== undefined && paths[0] === paths[1] ? paths[0] : undefined
  let oldName: string | undefined
  let newName: string | undefined
  let isNew = false
  let isDelete = false
  let isRename = false
  let oldMode: number | undefined
  let newMode: number | undefined
  let extensionLine: number | undefined
  let j = at + 1
  for (; j < lines.length; j += 1) {
    const line = withoutCr(lines[j])
    const lineNo = j + 1
    const after = (prefix: string): string | undefined => line.startsWith(prefix) ? line.slice(prefix.length) : undefined
    let rest: string | undefined
    if (line.startsWith('@@ -')) break
    else if ((rest = after('--- ')) !== undefined) oldName = verifyName(lineNo, rest, isNew, oldName, 'old')
    else if ((rest = after('+++ ')) !== undefined) newName = verifyName(lineNo, rest, isDelete, newName, 'new')
    else if ((rest = after('old mode ')) !== undefined) oldMode = parseMode(lineNo, rest)
    else if ((rest = after('new mode ')) !== undefined) newMode = parseMode(lineNo, rest)
    else if ((rest = after('deleted file mode ')) !== undefined) { isDelete = true; oldName = defaultName; oldMode = parseMode(lineNo, rest) }
    else if ((rest = after('new file mode ')) !== undefined) { isNew = true; newName = defaultName; newMode = parseMode(lineNo, rest) }
    else if (line.startsWith('copy from ') || line.startsWith('copy to ')) throw parseError(lineNo, 'git copy headers are not supported; write the new file with "+" lines instead')
    else if ((rest = after('rename old ') ?? after('rename from ')) !== undefined) { isRename = true; oldName = unquote(rest) }
    else if ((rest = after('rename new ') ?? after('rename to ')) !== undefined) { isRename = true; newName = unquote(rest) }
    else if (line.startsWith('similarity index ') || line.startsWith('dissimilarity index ')) { /* a score; git ignores a bad one */ }
    else if ((rest = after('index ')) !== undefined) { const mode = indexMode(rest); if (mode !== undefined) oldMode = parseMode(lineNo, mode) }
    else break
    if (Number(isNew) + Number(isDelete) + Number(isRename) > 1) throw parseError(lineNo, `inconsistent header lines ${extensionLine} and ${lineNo}: a "diff --git" section is only one of a new file, a deleted file or a rename`)
    if ((isNew || isDelete || isRename) && extensionLine === undefined) extensionLine = lineNo
  }
  if (oldName === undefined && newName === undefined) {
    if (defaultName === undefined) throw parseError(at + 1, 'the "diff --git" line names two different files and no "---"/"+++" or "rename from"/"rename to" lines name them; git apply rejects it')
    oldName = newName = defaultName
  }
  if ((newName === undefined && !isDelete) || (oldName === undefined && !isNew)) {
    throw parseError(at + 1, `the "diff --git" section lacks its ${newName === undefined ? 'new' : 'old'} file name; a rename needs both "rename from" and "rename to", as for git apply`)
  }
  const section: Section = { start: at + 1, git: true, oldPath: oldName ?? null, newPath: newName ?? null, newFile: isNew, deletedFile: isDelete, chunks: [] }
  const modeChange = oldMode !== undefined && newMode !== undefined && oldMode !== newMode
  return { section, next: j, metadata: isNew || isDelete || isRename || modeChange }
}

/**
 * Check a `---`/`+++` name of a git header against what earlier header lines
 * said (`apply.c` `gitdiff_verify_name`).
 * @param absent - the file does not exist on this side (`new file mode` for `---`, `deleted file mode` for `+++`).
 * @returns the name of this side, `undefined` for `/dev/null`.
 */
function verifyName(lineNo: number, raw: string, absent: boolean, known: string | undefined, side: 'old' | 'new'): string | undefined {
  const name = headerPath(raw)
  const header = side === 'old' ? '---' : '+++'
  const kind = side === 'old' ? 'new file mode' : 'deleted file mode'
  if (known === undefined && !absent) {
    if (name === null) throw parseError(lineNo, `"${header} /dev/null" in a "diff --git" section needs a "${kind} 100644" line before it; without it git apply reads the file "dev/null"`)
    return name
  }
  if (known !== undefined) {
    if (absent) throw parseError(lineNo, `expected "${header} /dev/null" after "${kind}", got "${known}"`)
    if (name !== known) throw parseError(lineNo, `inconsistent ${side} file name: "${header}" names "${name ?? '/dev/null'}", but an earlier line of this "diff --git" section names "${known}"`)
    return known
  }
  if (name !== null) throw parseError(lineNo, `expected "${header} /dev/null" after "${kind}"`)
  return undefined
}

/** A git mode as `apply.c` `parse_mode_line` reads it: an octal number followed by whitespace or the end of the line. */
function parseMode(lineNo: number, text: string): number {
  const match = /^[\t\v\f\r ]*[+-]?([0-7]+)(?:[\t\v\f\r ]|$)/.exec(text)
  if (match === null) throw parseError(lineNo, `invalid mode "${text}"; a git mode is an octal number such as 100644`)
  return parseInt(match[1], 8)
}

/** The mode after the object names of an `index <old>..<new> <mode>` line, when git reads one (`apply.c` `gitdiff_index`). */
function indexMode(rest: string): string | undefined {
  const dots = rest.indexOf('.')
  if (dots < 0 || rest[dots + 1] !== '.' || dots > 40) return undefined
  const names = rest.slice(dots + 2)
  const space = names.indexOf(' ')
  if ((space < 0 ? names.length : space) > 40) return undefined
  return space < 0 ? undefined : names.slice(space + 1)
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
    chunk.newCount = newLeft = header[4] === undefined ? 1 : Number(header[4])
  }
  const declared = `"${header[0]}" at line ${at + 1}`
  let last: '-' | '+' | ' ' | undefined
  let blankTail = 0
  let swallowedHeader = false
  let i = at + 1
  for (; i < lines.length; i += 1) {
    const line = lines[i]
    const after = oldLeft === 0 && newLeft === 0
    if (line.startsWith('\\')) {
      if (!isMarker(lines, i, after)) {
        if (after) break
        throw parseError(i + 1, `${JSON.stringify(line.slice(0, 60))} is not a "\\ No newline at end of file" line; inside a hunk a line starting with "\\" must be that marker`)
      }
      if (last !== undefined && last !== '+') unterminated(chunk, 'oldUnterminated', chunk.oldLines.length - 1)
      if (last !== undefined && last !== '-') unterminated(chunk, 'newUnterminated', chunk.newLines.length - 1)
      if (after) { i += 1; break }
      continue
    }
    if (after) break
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
    chunk.oldUnterminated = chunk.oldUnterminated?.filter(index => index < chunk.oldLines.length)
    chunk.newUnterminated = chunk.newUnterminated?.filter(index => index < chunk.newLines.length)
    if (chunk.oldUnterminated?.length === 0) delete chunk.oldUnterminated
    if (chunk.newUnterminated?.length === 0) delete chunk.newUnterminated
  } else if (counted && i < lines.length && /^[-+]/.test(lines[i]) && !isFileHeader(lines, i)) {
    throw parseError(i + 1, `more change lines follow the hunk ${declared} than its header declares; make the "@@" counts match the lines`)
  }
  if (chunk.oldLines.length === 0 && chunk.newLines.length === 0) throw parseError(at + 1, 'the hunk has no lines')
  return { chunk, next: i }
}

/**
 * Whether the line at `i`, which starts with `\`, is a newline marker as git
 * reads it (`apply.c` `parse_fragment`): it starts with `\ ` (the rest is
 * localized) and, inside a hunk, is at least 12 bytes long with its LF; after
 * the hunk's counts are reached, more than 12 bytes of the diff remain from its
 * start. git takes one marker after a hunk and skips any other such line.
 */
function isMarker(lines: readonly string[], i: number, after: boolean): boolean {
  if (!lines[i].startsWith('\\ ')) return false
  if (!after) return Buffer.byteLength(lines[i]) + 1 >= 12
  let rest = -1
  for (let j = i; j < lines.length && rest <= 12; j += 1) rest += Buffer.byteLength(lines[j]) + 1
  return rest > 12
}

/** Record that the line at `index` of one side has no LF. */
function unterminated(chunk: Chunk, key: 'oldUnterminated' | 'newUnterminated', index: number): void {
  const indices = chunk[key] ?? (chunk[key] = [])
  if (indices.at(-1) !== index) indices.push(index)
}

/** Build the file operation of one section, or `null` for a section without changes (a mode change only). */
function toOp(section: Section): PatchOp | null {
  const { oldPath, newPath } = section
  if (section.newFile || (!section.git && oldPath === null && newPath != null)) {
    const path = requirePath(newPath, section)
    if (section.chunks.some(chunk => chunk.oldLines.length > 0)) {
      throw parseError(section.start, `the new file "${path}" has context or removed lines, and git apply rejects a new file that depends on old contents; every line of a new file starts with "+"`)
    }
    const content = section.chunks.flatMap(chunk => chunk.newLines.map((line, i) => chunk.newUnterminated?.includes(i) === true ? line : `${line}\n`)).join('')
    return { kind: 'add', path, content }
  }
  if (section.deletedFile || (!section.git && newPath === null && oldPath != null)) {
    return { kind: 'delete', path: requirePath(oldPath, section), chunks: section.chunks }
  }
  if (section.git && oldPath !== newPath) {
    return { kind: 'update', path: requirePath(oldPath, section), moveTo: requirePath(newPath, section), chunks: section.chunks }
  }
  if (section.chunks.length === 0) return null
  return { kind: 'update', path: requirePath(newPath ?? oldPath, section), chunks: section.chunks }
}

function requirePath(path: string | null | undefined, section: Section): string {
  if (path === undefined || path === null || path === '') throw parseError(section.start, 'a file section has no usable path')
  return path
}

/** Path of a `---`/`+++` header: the text up to a TAB, decoded when quoted, without `a/`/`b/`. */
function headerPath(raw: string): string | null {
  const token = raw.startsWith('"') ? unquote(raw.slice(0, closingQuote(raw) + 1)) : raw.split('\t')[0]
  if (token === '/dev/null') return null
  return stripPrefix(token)
}

function stripPrefix(path: string): string {
  return path.startsWith('a/') || path.startsWith('b/') ? path.slice(2) : path
}

/**
 * Split the names of a `diff --git` line into the two prefix-stripped paths.
 * Quoted names end at their closing quote. Two unquoted names are split at the
 * space where both sides name the same path, as git does; otherwise at the
 * first ` b/`.
 */
function splitGitPaths(rest: string): [string, string] | undefined {
  if (rest.startsWith('"')) {
    const close = closingQuote(rest)
    if (close < 0 || rest[close + 1] !== ' ') return undefined
    return [stripPrefix(unquote(rest.slice(0, close + 1))), stripPrefix(unquote(rest.slice(close + 2)))]
  }
  for (let at = rest.indexOf(' '); at >= 0; at = rest.indexOf(' ', at + 1)) {
    const first = stripPrefix(rest.slice(0, at))
    const second = rest.slice(at + 1)
    if (!second.startsWith('"') && first === stripPrefix(second)) return [first, first]
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

/**
 * Decode a git C-style quoted path, including octal UTF-8 escapes, by code point.
 * @param text - a whole quoted path (`"…"`), or an unquoted path.
 * @returns the decoded path; unquoted text is returned unchanged, spaces included.
 */
export function unquote(text: string): string {
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
