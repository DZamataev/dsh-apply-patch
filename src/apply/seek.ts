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
 * Find `pattern` in `lines` at or after `from`.
 * @param lines - file lines without line terminators.
 * @param pattern - lines to find; an empty pattern matches at `from`, also with `endOfFile`, as in codex-rs.
 * @param from - first index a match may start at.
 * @param options - `endOfFile` pins the match to the end.
 * @returns the match, no match, or the first {@link AMBIGUOUS_SHOWN} (at least two) ambiguous tolerant candidates.
 */
export function seek(
  lines: readonly string[],
  pattern: readonly string[],
  from: number,
  options: { endOfFile?: boolean } = {},
): SeekResult {
  if (pattern.length === 0) return { kind: 'found', index: from }
  const last = lines.length - pattern.length
  if (last < from) return { kind: 'none' }
  const first = options.endOfFile === true ? last : from
  for (let level = 0; level < LEVELS.length; level += 1) {
    const norm = LEVELS[level]
    const wanted = pattern.map(norm)
    // Each file line is normalized once per level, not once per candidate it is compared in.
    const normalized = level === 0 ? lines : lines.slice(first, last + pattern.length).map(norm)
    const offset = level === 0 ? 0 : first
    const hits: number[] = []
    for (let i = first; i <= last && hits.length < AMBIGUOUS_SHOWN; i += 1) {
      let ok = true
      for (let j = 0; j < wanted.length && ok; j += 1) ok = normalized[i - offset + j] === wanted[j]
      if (!ok) continue
      if (level === 0) return { kind: 'found', index: i }
      hits.push(i)
    }
    if (hits.length === 0) continue
    if (hits.length > 1) return { kind: 'ambiguous', indices: hits }
    return { kind: 'found', index: hits[0] }
  }
  return { kind: 'none' }
}
