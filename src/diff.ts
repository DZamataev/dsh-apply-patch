/**
 * Display diffs for DSH diff cards: one entry per changed region of a file (a hunk with three
 * context lines around the edits the patch made), with byte caps per entry and per call.
 * @module dsh-apply-patch/diff
 */

/** One display diff entry, in the shape DSH diff cards read. */
export type DisplayDiff = {
  path: string
  /** Old lines of the hunk as a fragment (see {@link displayDiffs}); `null` when the hunk has no old lines (a created or empty file). */
  oldText: string | null
  /** New lines of the hunk as a fragment; `''` when it has none. */
  newText: string
  /** True when the entry did not fit a byte cap and its texts were dropped. */
  truncated?: boolean
}

/** A replaced range: `before[oldFrom, oldTo)` became `after[newFrom, newTo)` (UTF-16 offsets). */
export interface TextEdit {
  oldFrom: number
  oldTo: number
  newFrom: number
  newTo: number
}

/** A file as the patch changes it, for its display diff. */
export interface DisplayFile {
  /** Path stamped on every entry of the file. */
  path: string
  action: 'added' | 'modified' | 'deleted'
  /** Text before the patch; `null` for an added file or a deleted file without text (binary). */
  before: string | null
  /** Text after the patch; `null` for a deleted file. */
  after: string | null
  /**
   * For a modified file: the edits that turn `before` into `after`, in order and disjoint, as the
   * patch made them. When omitted, one edit spans from the first to the last changed character.
   */
  edits?: readonly TextEdit[]
}

/** Context lines on each side of a hunk; changes at most twice this far apart share a hunk. */
export const DIFF_CONTEXT = 3

/**
 * The display diffs of a patch, file by file and hunk by hunk.
 *
 * A fragment (`oldText`, `newText`) is its lines, each followed by LF (`lines.join('\n') + '\n'`),
 * the form of a whole file text, so a reader that drops one final LF as the file's terminator
 * gets the exact lines; CRLF and LF are not shown, a lone CR stays in its line, and a leading
 * byte order mark is not shown. When the fragment ends with the file's last line and that line
 * has no line ending, the fragment ends without LF (`lines.join('\n')`), so such a reader again
 * gets the exact lines; a change of only that line ending then shows as equal sides.
 *
 * A hunk covers the lines the edits touch, merged when at most `2 * DIFF_CONTEXT` unchanged lines
 * lie between them, with up to {@link DIFF_CONTEXT} unchanged lines on each side; the common
 * characters at both ends of an edit are not counted as changed. An added file has one entry with
 * `oldText: null`; a deleted file one entry with `newText: ''` (none when its text is unknown or
 * empty); a modified or moved file one entry per hunk (none when its text is unchanged).
 *
 * An entry whose UTF-8 size (path, `oldText` and `newText`) exceeds `maxBytes` keeps its path with
 * empty texts and `truncated: true`; entries are kept in order until the next one would bring the
 * call over `maxTotalBytes`, and every later entry is truncated too, without computing its texts.
 * Consecutive truncated entries of one file are merged into one. The work is proportional to the
 * edits and the shown lines, not to the size of the files.
 * @param files - the files in patch order.
 * @param maxBytes - UTF-8 byte cap of one entry.
 * @param maxTotalBytes - UTF-8 byte cap of all kept entries together.
 * @returns the entries.
 */
export function displayDiffs(files: readonly DisplayFile[], maxBytes: number, maxTotalBytes: number): DisplayDiff[] {
  const out: DisplayDiff[] = []
  let total = 0
  let full = false
  for (const file of files) {
    const sides = fileSides(file)
    if (sides === undefined) continue
    const { before, after, edits } = sides
    const pathBytes = Buffer.byteLength(file.path, 'utf8')
    if (file.action === 'added' && after === '') {
      // An empty added file still has its entry; its size is the path alone.
      const fits = !full && pathBytes <= maxBytes && total + pathBytes <= maxTotalBytes
      if (fits) total += pathBytes
      else full ||= pathBytes <= maxBytes
      out.push(fits ? { path: file.path, oldText: null, newText: '' } : { path: file.path, oldText: null, newText: '', truncated: true })
      continue
    }
    const truncate = (region: Region) => {
      const last = out.at(-1)
      if (last?.truncated !== true || last.path !== file.path) out.push({ path: file.path, oldText: region.oldFrom === region.oldTo ? null : '', newText: '', truncated: true })
    }
    for (const region of regions(before, after, edits)) {
      if (full) {
        truncate(region)
        break
      }
      const hunk = render(before, after, region, maxBytes - pathBytes)
      if (hunk === undefined) {
        truncate(region)
        continue
      }
      const size = pathBytes + hunk.bytes
      if (total + size > maxTotalBytes) {
        full = true
        truncate(region)
        break
      }
      out.push({ path: file.path, oldText: hunk.oldText, newText: hunk.newText })
      total += size
    }
  }
  return out
}

/**
 * The hunks between two texts, as {@link displayDiffs} shows them, without byte caps.
 * @param before - old text.
 * @param after - new text.
 * @param edits - the edits that turn `before` into `after`, in order and disjoint; when omitted, one edit spans the whole texts.
 * @returns the hunks in file order; empty when the edits change nothing.
 */
export function hunkTexts(before: string, after: string, edits?: readonly TextEdit[]): { oldText: string | null; newText: string }[] {
  const all = edits ?? [{ oldFrom: 0, oldTo: before.length, newFrom: 0, newTo: after.length }]
  return [...regions(before, after, all)].map(region => {
    const hunk = render(before, after, region, Infinity)
    return { oldText: hunk?.oldText ?? null, newText: hunk?.newText ?? '' }
  })
}

/** Old and new text and edits of a file; undefined when it has no entry. */
function fileSides(file: DisplayFile): { before: string; after: string; edits: readonly TextEdit[] } | undefined {
  switch (file.action) {
    case 'added': {
      const after = file.after ?? ''
      return { before: '', after, edits: [{ oldFrom: 0, oldTo: 0, newFrom: 0, newTo: after.length }] }
    }
    case 'deleted':
      if (file.before === null || file.before === '') return undefined
      return { before: file.before, after: '', edits: [{ oldFrom: 0, oldTo: file.before.length, newFrom: 0, newTo: 0 }] }
    case 'modified': {
      if (file.before === null) return undefined
      const after = file.after ?? ''
      return { before: file.before, after, edits: file.edits ?? [{ oldFrom: 0, oldTo: file.before.length, newFrom: 0, newTo: after.length }] }
    }
  }
}

/** A hunk: whole lines `before[oldFrom, oldTo)` became whole lines `after[newFrom, newTo)`, context included. */
interface Region {
  oldFrom: number
  oldTo: number
  newFrom: number
  newTo: number
}

const LF = 10

/** Whether `p` starts a line of `text` or is its end. */
function atLineEdge(text: string, p: number): boolean {
  return p === 0 || p === text.length || text.charCodeAt(p - 1) === LF
}

/** Index of the first LF in `text[from, to)`, or -1. */
function lfBetween(text: string, from: number, to: number): number {
  for (let i = from; i < to; i += 1) if (text.charCodeAt(i) === LF) return i
  return -1
}

/** Whether `text[from, to)` holds more than `max` LFs. */
function linesOver(text: string, from: number, to: number, max: number): boolean {
  let count = 0
  for (let i = from; i < to; i += 1) if (text.charCodeAt(i) === LF && ++count > max) return true
  return false
}

/** `edit` without the characters both sides share at its start and end; undefined when nothing is left. */
function trim(before: string, after: string, edit: TextEdit): TextEdit | undefined {
  let { oldFrom, oldTo, newFrom, newTo } = edit
  while (oldFrom < oldTo && newFrom < newTo && before.charCodeAt(oldFrom) === after.charCodeAt(newFrom)) {
    oldFrom += 1
    newFrom += 1
  }
  while (oldTo > oldFrom && newTo > newFrom && before.charCodeAt(oldTo - 1) === after.charCodeAt(newTo - 1)) {
    oldTo -= 1
    newTo -= 1
  }
  return oldFrom === oldTo && newFrom === newTo ? undefined : { oldFrom, oldTo, newFrom, newTo }
}

/**
 * The hunks of `edits`, in order. Every character is scanned a bounded number of times: a line
 * is searched for its end only up to the next edit, and gaps only up to the line count that
 * separates hunks.
 */
function* regions(before: string, after: string, edits: readonly TextEdit[]): Generator<Region> {
  let index = 0
  let pending: TextEdit | undefined
  const peek = () => {
    while (pending === undefined && index < edits.length) pending = trim(before, after, edits[index++])
    return pending
  }
  const take = () => {
    const edit = peek()
    pending = undefined
    return edit
  }
  for (let edit = take(); edit !== undefined; edit = take()) {
    // The changed lines: [start, end) in `before`, [newStart, newEnd) in `after`. The previous
    // hunk ends more than 2 * DIFF_CONTEXT lines earlier, so the search back stops in the gap.
    const start = edit.oldFrom === 0 ? 0 : before.lastIndexOf('\n', edit.oldFrom - 1) + 1
    const newStart = edit.newFrom - (edit.oldFrom - start)
    let end = edit.oldTo
    let newEnd = edit.newTo
    for (;;) {
      if (!atLineEdge(before, end) || !atLineEdge(after, newEnd)) {
        // The text after the edit is common to both sides: extend both to the end of its line.
        const next = peek()
        const lf = lfBetween(before, end, next?.oldFrom ?? before.length)
        if (lf >= 0) {
          newEnd += lf + 1 - end
          end = lf + 1
        } else if (next !== undefined) {
          take()
          end = next.oldTo
          newEnd = next.newTo
          continue
        } else {
          newEnd += before.length - end
          end = before.length
        }
      }
      const next = peek()
      if (next === undefined || linesOver(before, end, next.oldFrom, 2 * DIFF_CONTEXT)) break
      take()
      end = next.oldTo
      newEnd = next.newTo
    }
    let from = start
    for (let n = 0; n < DIFF_CONTEXT && from > 0; n += 1) from = from >= 2 ? before.lastIndexOf('\n', from - 2) + 1 : 0
    let to = end
    for (let n = 0; n < DIFF_CONTEXT && to < before.length; n += 1) {
      const lf = before.indexOf('\n', to)
      to = lf === -1 ? before.length : lf + 1
    }
    yield { oldFrom: from, oldTo: to, newFrom: newStart - (start - from), newTo: newEnd + (to - end) }
  }
}

/**
 * The fragments of a hunk and their UTF-8 size, or undefined when that size exceeds `budget`.
 * A side of n UTF-16 units shows at least n / 2 - 1 of them (CRLF becomes LF, a byte order
 * mark is dropped), each at least one UTF-8 byte, so a hunk that cannot fit is not sliced.
 */
function render(before: string, after: string, region: Region, budget: number): { oldText: string | null; newText: string; bytes: number } | undefined {
  const units = region.oldTo - region.oldFrom + region.newTo - region.newFrom
  if (units / 2 - 2 > budget) return undefined
  const oldText = region.oldFrom === region.oldTo ? null : fragment(before, region.oldFrom, region.oldTo)
  const newText = fragment(after, region.newFrom, region.newTo)
  const bytes = Buffer.byteLength(oldText ?? '', 'utf8') + Buffer.byteLength(newText, 'utf8')
  return bytes > budget ? undefined : { oldText, newText, bytes }
}

/** Whole lines `text[from, to)` as a fragment: CRLF shown as LF, no leading byte order mark, a missing final line ending kept missing. */
function fragment(text: string, from: number, to: number): string {
  const shown = text.slice(from, to)
  return (from === 0 && shown.charCodeAt(0) === 0xFEFF ? shown.slice(1) : shown).replaceAll('\r\n', '\n')
}
