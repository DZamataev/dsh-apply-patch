/**
 * Locating a sequence of lines in a file for Codex patches, after codex-rs
 * `seek_sequence`: exact match first, then ignoring trailing whitespace, then
 * surrounding whitespace, then typographic punctuation (dashes, quotes, odd
 * spaces). Whitespace is Rust's `char::is_whitespace` set (Unicode White_Space:
 * it includes U+0085 and excludes U+FEFF, unlike `String.prototype.trim`).
 *
 * An exact match takes the first candidate at or after the cursor, as
 * codex-rs does, and the search stops there. The tolerant levels accept only
 * a single candidate: where codex-rs edits the first of several tolerant
 * matches, two or more are reported as ambiguous instead, with at most
 * {@link AMBIGUOUS_SHOWN} of them.
 *
 * A {@link LineSearch} serves all searches in one file: each level normalizes
 * the file lines once, when a search first needs it, and from its second
 * search on indexes them by normalized text, so a search costs about its
 * candidates (the places of its rarest line), not the rest of the file. Where those candidates would cost
 * more than the remaining lines (a pattern of lines that are frequent in the
 * file), or few starts remain, the level is one Knuth-Morris-Pratt search over
 * the remaining normalized lines instead, which compares O(remaining lines +
 * pattern lines) lines also in a file of many near matches (codex-rs compares
 * every candidate with the whole pattern); so is the first search of a level,
 * which an index would not repay.
 * @module dsh-apply-patch/apply/seek
 */

import { rustTrim, rustTrimEnd } from '../parse/whitespace.js'

/** Result of a search. */
export type SeekResult =
  | { kind: 'found'; index: number }
  | { kind: 'none' }
  | { kind: 'ambiguous'; indices: number[] }

const PUNCTUATION: Record<string, string> = {
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2015': '-', '\u2212': '-',
  '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'",
  '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u201F': '"',
  '\u00A0': ' ', '\u2002': ' ', '\u2003': ' ', '\u2004': ' ', '\u2005': ' ', '\u2006': ' ', '\u2007': ' ',
  '\u2008': ' ', '\u2009': ' ', '\u200A': ' ', '\u202F': ' ', '\u205F': ' ', '\u3000': ' ',
}

/** Tolerant candidates collected before a match is reported as ambiguous; the scan stops at this many. */
export const AMBIGUOUS_SHOWN = 5

const LEVELS: ((line: string) => string)[] = [
  line => line,
  rustTrimEnd,
  rustTrim,
  line => Array.from(rustTrim(line), ch => PUNCTUATION[ch] ?? ch).join(''),
]

/**
 * Find `pattern` in `lines` at or after `from`; one search of {@link LineSearch}.
 * @param lines - file lines without line terminators.
 * @param pattern - lines to find; an empty pattern matches at `from`, also with `endOfFile`, as in codex-rs.
 * @param from - first index a match may start at.
 * @param options - `endOfFile` pins the match to the end.
 * @returns the match, no match, or the first {@link AMBIGUOUS_SHOWN} (at least two) ambiguous tolerant candidates.
 */
export function seek(lines: readonly string[], pattern: readonly string[], from: number, options: { endOfFile?: boolean } = {}): SeekResult {
  return new LineSearch(lines).seek(pattern, from, options)
}

/** Searches in the lines of one file, which must not change while the object is used. */
export class LineSearch {
  /** Per level: the normalized file lines, the ascending indices of each normalized text, and whether a search scanned them. */
  private readonly levels: Level[] = []

  /** @param lines - file lines without line terminators. */
  constructor(private readonly lines: readonly string[]) {}

  /**
   * Find `pattern` at or after `from`, as {@link seek}.
   * @param pattern - lines to find; an empty pattern matches at `from`, also with `endOfFile`, as in codex-rs.
   * @param from - first index a match may start at.
   * @param options - `endOfFile` pins the match to the end.
   * @returns the match, no match, or the first {@link AMBIGUOUS_SHOWN} (at least two) ambiguous tolerant candidates.
   */
  seek(pattern: readonly string[], from: number, options: { endOfFile?: boolean } = {}): SeekResult {
    if (pattern.length === 0) return { kind: 'found', index: from }
    const last = this.lines.length - pattern.length
    if (last < from) return { kind: 'none' }
    const first = options.endOfFile === true ? last : from
    for (let level = 0; level < LEVELS.length; level += 1) {
      const hits = this.find(level, pattern.map(LEVELS[level]), first, last, level === 0 ? 1 : AMBIGUOUS_SHOWN)
      if (hits.length > 1) return { kind: 'ambiguous', indices: hits }
      if (hits.length === 1) return { kind: 'found', index: hits[0] }
    }
    return { kind: 'none' }
  }

  /** The first `limit` starts from `first` to `last` where the normalized `wanted` matches at `level`, ascending. */
  private find(level: number, wanted: readonly string[], first: number, last: number, limit: number): number[] {
    const starts = last - first + 1
    const text = this.normalized(level)
    if (starts <= SCAN_STARTS) return matches(text.lines, first, starts, wanted, limit)
    // The first search of a level scans, so that a patch of one change does not pay for the index.
    if (text.places === undefined && !text.scanned) {
      text.scanned = true
      return matches(text.lines, first, starts, wanted, limit)
    }
    const places = text.places ??= index(text.lines)
    // The rarest pattern line in the whole file: its places, shifted by its offset, are the candidate starts.
    let anchor = 0
    let anchored: number[] | undefined
    for (let j = 0; j < wanted.length; j += 1) {
      const at = places.get(wanted[j])
      if (at === undefined) return []
      if (anchored === undefined || at.length < anchored.length) { anchor = j; anchored = at }
    }
    const candidates = anchored!
    const from = lowerBound(candidates, first + anchor)
    const to = lowerBound(candidates, last + anchor + 1)
    if ((to - from) * wanted.length > starts + wanted.length) return matches(text.lines, first, starts, wanted, limit)
    const hits: number[] = []
    for (let c = from; c < to && hits.length < limit; c += 1) {
      const start = candidates[c] - anchor
      let j = 0
      while (j < wanted.length && text.lines[start + j] === wanted[j]) j += 1
      if (j === wanted.length) hits.push(start)
    }
    return hits
  }

  private normalized(level: number): Level {
    return this.levels[level] ??= { lines: level === 0 ? this.lines : this.lines.map(LEVELS[level]) }
  }
}

interface Level { lines: readonly string[]; places?: Map<string, number[]>; scanned?: boolean }

/** Searches with at most this many starts scan the lines instead of building an index. */
const SCAN_STARTS = 64

/** The ascending indices of each line text. */
function index(lines: readonly string[]): Map<string, number[]> {
  const places = new Map<string, number[]>()
  lines.forEach((line, i) => {
    const at = places.get(line)
    if (at === undefined) places.set(line, [i])
    else at.push(i)
  })
  return places
}

/** The first index of ascending `values` whose value is at least `value`. */
function lowerBound(values: readonly number[], value: number): number {
  let low = 0
  let high = values.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if (values[mid] < value) low = mid + 1
    else high = mid
  }
  return low
}

/**
 * Start indices of `wanted` in `text`, in order and overlapping ones included,
 * by Knuth-Morris-Pratt over whole lines: every text line is compared a
 * bounded number of times, so a search costs O(text lines + pattern lines)
 * line comparisons however many near matches the text has.
 * @param text - the lines to search.
 * @param from - first index a match may start at.
 * @param starts - number of start indices to try (`from` up to `from + starts - 1`).
 * @param wanted - the non-empty pattern.
 * @param limit - stop after this many matches.
 * @returns up to `limit` start indices.
 */
function matches(text: readonly string[], from: number, starts: number, wanted: readonly string[], limit: number): number[] {
  // fail[j]: length of the longest proper prefix of wanted[0..j] that is also its suffix.
  const fail = new Int32Array(wanted.length)
  for (let j = 1, k = 0; j < wanted.length; j += 1) {
    while (k > 0 && wanted[j] !== wanted[k]) k = fail[k - 1]
    if (wanted[j] === wanted[k]) k += 1
    fail[j] = k
  }
  const hits: number[] = []
  const end = from + starts - 1 + wanted.length
  for (let i = from, k = 0; i < end; i += 1) {
    while (k > 0 && text[i] !== wanted[k]) k = fail[k - 1]
    if (text[i] === wanted[k]) k += 1
    if (k === wanted.length) {
      hits.push(i - wanted.length + 1)
      if (hits.length >= limit) break
      k = fail[k - 1]
    }
  }
  return hits
}
