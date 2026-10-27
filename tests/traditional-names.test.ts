import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyToFile } from '../src/apply/content.js'
import { parseUnifiedDiff } from '../src/parse/unified.js'

/**
 * Names of bare `---`/`+++` pairs (no `diff --git` line), read as plain
 * `git apply` reads a traditional patch (`apply.c` `parse_traditional_patch`):
 * `-p1` removes any first path component, unless both names lack a directory
 * (`guess_p_value`), which makes git read this and every later section with
 * `-p0`; a timestamp after the name is dropped (`diff_timestamp_len`); an
 * epoch timestamp after a TAB creates or deletes the file
 * (`has_epoch_timestamp`); of two differing names the `+++` one wins unless
 * the `---` one is a shorter prefix of it. Every expectation is checked
 * against the installed git.
 */

type Outcome = Record<string, string> | 'error'

const ab = 'a\nb\n'
const start: Record<string, string> = { f: ab, 'x/f': ab, 'a/f': ab, 'b/f': ab, g: ab, 'f.orig': ab, 'my f': ab }
const update = '@@ -1,2 +1,2 @@\n-a\n+A\n b\n'
const add = '@@ -0,0 +1 @@\n+x\n'
const remove = '@@ -1,2 +0,0 @@\n-a\n-b\n'
const updated = (path: string) => ({ ...start, [path]: 'A\nb\n' })
const pair = (first: string, second: string, hunk = update) => `--- ${first}\n+++ ${second}\n${hunk}`

/** Apply `patch` to `files` in memory as the tool would. */
function ours(patch: string, files: Record<string, string> = start): Outcome {
  const out: Record<string, string> = { ...files }
  try {
    for (const op of parseUnifiedDiff(patch).ops) {
      if (op.kind === 'add') {
        if (op.path in out) return 'error'
        out[op.path] = op.content
      } else if (op.kind === 'delete') {
        if (!(op.path in out)) return 'error'
        if (op.chunks !== undefined && op.chunks.length > 0 && applyToFile(op.path, out[op.path], op.chunks, 'unified') !== '') return 'error'
        delete out[op.path]
      } else {
        if (!(op.path in out)) return 'error'
        const text = applyToFile(op.path, out[op.path], op.chunks, 'unified')
        delete out[op.path]
        const target = op.moveTo ?? op.path
        if (target in out) return 'error'
        out[target] = text
      }
    }
  } catch (error: unknown) {
    expect(error).toMatchObject({ code: expect.stringMatching(/^PATCH_/) })
    return 'error'
  }
  return out
}

/** The tool's error message for `patch`, or `''` when it parses. */
function parseMessage(patch: string): string {
  try {
    parseUnifiedDiff(patch)
    return ''
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** Apply `patch` with `git apply` in a fresh repository holding `files`. */
function real(patch: string, files: Record<string, string> = start): Outcome {
  const dir = mkdtempSync(join(tmpdir(), 'ap-traditional-'))
  try {
    spawnSync('git', ['init', '-q'], { cwd: dir })
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, name)), { recursive: true })
      writeFileSync(join(dir, name), text)
    }
    writeFileSync(join(dir, '.patch'), patch)
    if (spawnSync('git', ['apply', '.patch'], { cwd: dir }).status !== 0) return 'error'
    const out: Record<string, string> = {}
    const walk = (rel: string): void => {
      for (const name of readdirSync(join(dir, rel))) {
        const path = rel === '' ? name : `${rel}/${name}`
        if (path === '.git' || path === '.patch') continue
        if (statSync(join(dir, path)).isDirectory()) walk(path)
        else out[path] = readFileSync(join(dir, path), 'utf8')
      }
    }
    walk('')
    return out
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const hasGit = spawnSync('git', ['--version']).status === 0

interface Case {
  name: string
  patch: string
  files?: Record<string, string>
  git: Outcome
  /** Where this tool deliberately refuses what git applies; the refusal message must match. */
  refusal?: RegExp
}

const crlfStart = { ...start, g: 'a\r\nb\r\n' }

const cases: Case[] = [
  { name: 'removes any first path component', patch: pair('x/f', 'x/f'), git: updated('f') },
  { name: 'reads both names without a directory with -p0', patch: pair('f', 'f'), git: updated('f') },
  { name: 'guesses -p0 when only the "+++" name lacks a directory', patch: pair('x/f', 'f'), git: updated('f') },
  { name: 'takes the "+++" name after -p1 when only the "---" name lacks a directory', patch: pair('f', 'x/f'), git: updated('f') },
  { name: 'takes the "+++" name of a backup "---" name', patch: pair('x/f.orig', 'x/f'), git: updated('f') },
  { name: 'takes the "---" name when it is a shorter prefix of the "+++" name', patch: pair('a/f', 'b/f.orig'), git: updated('f') },
  { name: 'takes the "---" name when the "+++" name is empty after -p1', patch: pair('x/f', 'y/'), git: updated('f') },
  { name: 'removes "a/" and "b/" as any first component', patch: pair('a/x/f', 'b/x/f'), git: updated('x/f') },
  { name: 'removes the leading "/" of an absolute name as its first component', patch: pair('/x/f', '/x/f'), git: updated('x/f') },
  { name: 'reads a quoted name with -p1', patch: pair('"x/f"', '"x/f"'), git: updated('f') },
  { name: 'reads a quoted name without a directory with -p0', patch: pair('"f"', '"f"'), git: updated('f') },
  { name: 'ignores a timestamp after a quoted name', patch: pair('"a/f"\t2010-07-05 19:41:17', '"b/f"\t2010-07-05 19:41:18'), git: updated('f') },
  { name: 'drops a timestamp after a space', patch: pair('a/f 2010-07-05 19:41:17', 'b/f 2010-07-05 19:41:18'), git: updated('f') },
  { name: 'drops a timestamp after several spaces and a TAB', patch: pair('a/f   2010-07-05 19:41:17', 'b/f \t 2010-07-05 19:41:18'), git: updated('f') },
  { name: 'drops a GNU timestamp with fraction and zone after a TAB', patch: pair('a/f\t2010-07-05 19:41:17.620000023 -0500', 'b/f\t2010-07-05 19:41:18.1 +0100'), git: updated('f') },
  { name: 'drops a timestamp with a two-digit year and a zone with a colon', patch: pair('a/f 10-07-05 19:41:17 +08:00', 'b/f 10-07-05 19:41:18 +08:00'), git: updated('f') },
  { name: 'drops a date without a time', patch: pair('a/f 2010-07-05', 'b/f 2010-07-05'), git: updated('f') },
  { name: 'keeps spaces inside a name before a timestamp', patch: pair('a/my f 2010-07-05 19:41:17', 'b/my f 2010-07-05 19:41:18'), git: updated('my f') },
  { name: 'ends a name at a TAB without a timestamp', patch: pair('a/f\tjunk', 'b/f\tjunk'), git: updated('f') },
  { name: 'creates a file after "--- /dev/null" with a timestamp', patch: pair('/dev/null\t1970-01-01 00:00:00 +0000', 'b/h\t2010-07-05 19:41:18 +0100', add), git: { ...start, h: 'x\n' } },
  { name: 'creates a file without a directory after "--- /dev/null"', patch: pair('/dev/null', 'h', add), git: { ...start, h: 'x\n' } },
  { name: 'deletes a file before "+++ /dev/null" with a timestamp', patch: pair('a/g\t2010-07-05 19:41:18 +0100', '/dev/null\t1970-01-01 00:00:00 +0000', remove), git: (({ g: _, ...rest }) => rest)(start) },
  { name: 'creates a file whose "---" timestamp is the epoch', patch: pair('a/h\t1970-01-01 00:00:00 +0000', 'b/h\t2010-07-05 19:41:18 +0100', add), git: { ...start, h: 'x\n' } },
  // An epoch "---" timestamp makes the file new, and a new file cannot have old lines.
  { name: 'reads an epoch "---" timestamp east of GMT', patch: pair('a/g\t1970-01-01 01:30:00.000 +0130', 'b/g\t2010-07-05 19:41:18 +0100'), git: 'error' },
  { name: 'reads an epoch "---" timestamp with a zone written with a colon', patch: pair('a/g\t1969-12-31 22:30:00 -01:30', 'b/g\t2010-07-05 19:41:18 +0100'), git: 'error' },
  { name: 'updates a file whose timestamp is the epoch in another zone', patch: pair('a/g\t1970-01-01 01:30:00 +0100', 'b/g\t2010-07-05 19:41:18 +0100'), git: updated('g') },
  { name: 'rejects an epoch "---" timestamp for an existing file', patch: pair('a/g\t1970-01-01 00:00:00 +0000', 'b/g\t2010-07-05 19:41:18 +0100', add), git: 'error' },
  { name: 'deletes a file whose "+++" timestamp is the epoch west of GMT', patch: pair('a/g\t2010-07-05 19:41:18 +0100', 'b/g\t1969-12-31 16:00:00 -0800', remove), git: (({ g: _, ...rest }) => rest)(start) },
  { name: 'updates a file whose timestamp is a minute after the epoch', patch: pair('a/g\t1970-01-01 00:01:00 +0000', 'b/g\t2010-07-05 19:41:18 +0100'), git: updated('g') },
  { name: 'updates a file whose epoch timestamp follows a space, not a TAB', patch: pair('a/g 1970-01-01 00:00:00 +0000', 'b/g 2010-07-05 19:41:18 +0100'), git: updated('g') },
  { name: 'updates a CRLF file through CRLF headers with timestamps', files: crlfStart, patch: '--- a/g\t2010-07-05 19:41:17\r\n+++ b/g\t2010-07-05 19:41:18\r\n@@ -1,2 +1,2 @@\n-a\r\n+A\r\n b\r\n', git: { ...crlfStart, g: 'A\r\nb\r\n' } },
  { name: 'updates a CRLF file through CRLF headers without directories', files: crlfStart, patch: '--- g\r\n+++ g\r\n@@ -1,2 +1,2 @@\n-a\r\n+A\r\n b\r\n', git: { ...crlfStart, g: 'A\r\nb\r\n' } },
  { name: 'keeps a timestamp after a space in a CRLF header line', patch: pair('a/f 2010-07-05 19:41:17\r', 'b/f 2010-07-05 19:41:18\r'), git: 'error' },
  { name: 'rejects a deletion whose name lacks a directory', patch: pair('f', '/dev/null', remove), git: 'error' },
  { name: 'rejects names that are empty after -p1', patch: pair('x/', 'y/'), git: 'error' },
  { name: 'reads a "diff --git" section before a guessed -p0 with -p1', patch: `diff --git a/g b/g\n--- a/g\n+++ b/g\n${update}${pair('f', 'f')}`, git: { ...updated('f'), g: 'A\nb\n' } },
  { name: 'guesses -p0 at a later pair after a failed guess', patch: pair('x/f', 'x/f') + pair('g', 'g'), git: { ...updated('f'), g: 'A\nb\n' } },
  { name: 'reads a later pair without directories after a guessed -p0', patch: pair('f', 'f') + pair('g', 'g'), git: { ...updated('f'), g: 'A\nb\n' } },
  { name: 'reads a pair with -p1 after a pair without hunks', patch: '--- f\n+++ f\n' + pair('x/g', 'x/g'), git: updated('g') },
  // git patches b/f: the guessed -p0 also applies to the later pair.
  { name: 'refuses a later pair with a directory after a guessed -p0', patch: pair('g', 'g') + pair('a/f', 'b/f'), git: { ...updated('b/f'), g: 'A\nb\n' }, refusal: /-p0/ },
  // git reads the names a/f and b/f with the guessed -p0 and moves a/f over b/f.
  { name: 'refuses a later "diff --git" section after a guessed -p0', patch: `${pair('g', 'g')}diff --git a/f b/f\n--- a/f\n+++ b/f\n${update}`, git: (({ 'a/f': _, ...rest }) => ({ ...rest, 'b/f': 'A\nb\n', g: 'A\nb\n' }))(start), refusal: /-p0/ },
  // git creates the file dev/null.
  { name: 'refuses "/dev/null" on both sides', patch: pair('/dev/null', '/dev/null', add), git: { ...start, 'dev/null': 'x\n' }, refusal: /\/dev\/null/ },
]

/**
 * `@@ @@` hunks without line numbers: git does not read them as hunks and
 * skips them as text. The tool applies them only where git rejects the whole
 * patch; next to anything git applies (a numbered hunk, a new file, deletion
 * or rename section) they are refused, since git would apply the rest alone.
 */
interface UnnumberedCase {
  name: string
  patch: string
  git: Outcome
  /** The tool's result where git rejects the patch (a documented extra); without it the tool refuses. */
  extra?: Outcome
}

const unnumbered = '@@ @@\n-a\n+A\n b\n'
const refusedHint = /no line numbers.*Add line numbers to every "@@" header.*Codex format/
const unnumberedCases: UnnumberedCase[] = [
  { name: 'an unnumbered hunk after a numbered one in the same file', patch: pair('a/f', 'b/f') + '@@ @@\n-b\n+B\n', git: updated('f') },
  { name: 'an unnumbered file after a numbered one', patch: pair('a/f', 'b/f') + pair('a/g', 'b/g', unnumbered), git: updated('f') },
  { name: 'an unnumbered file before a numbered one', patch: pair('a/g', 'b/g', unnumbered) + pair('a/f', 'b/f'), git: updated('f') },
  { name: 'an unnumbered file without directories before a numbered one', patch: pair('g', 'g', unnumbered) + pair('x/f', 'x/f'), git: updated('f') },
  { name: 'an unnumbered hunk before a numbered one in the same file', patch: pair('a/f', 'b/f', unnumbered) + '@@ -2 +2 @@\n-b\n+B\n', git: 'error' },
  { name: 'an unnumbered file after a new file section', patch: `diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n${add}${pair('a/g', 'b/g', unnumbered)}`, git: { ...start, n: 'x\n' } },
  { name: 'an unnumbered file after an empty new file section', patch: `diff --git a/n b/n\nnew file mode 100644\n\n${pair('a/g', 'b/g', unnumbered)}`, git: { ...start, n: '' } },
  { name: 'an unnumbered hunk of a new file section', patch: 'diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n@@ @@\n+x\n', git: { ...start, n: '' } },
  { name: 'an unnumbered hunk of a rename section', patch: `diff --git a/f b/h\nrename from f\nrename to h\n${unnumbered}`, git: (({ f, ...rest }) => ({ ...rest, h: f }))(start) },
  { name: 'only unnumbered hunks', patch: pair('a/f', 'b/f', unnumbered), git: 'error', extra: updated('f') },
  { name: 'only unnumbered files', patch: pair('a/f', 'b/f', unnumbered) + pair('a/g', 'b/g', unnumbered), git: 'error', extra: { ...updated('f'), g: 'A\nb\n' } },
  { name: 'only unnumbered hunks in a "diff --git" section', patch: `diff --git a/f b/f\n--- a/f\n+++ b/f\n${unnumbered}`, git: 'error', extra: updated('f') },
]

describe('unnumbered "@@ @@" hunks', () => {
  it.each(unnumberedCases)('$name', ({ patch, extra }) => {
    if (extra !== undefined) expect(ours(patch)).toEqual(extra)
    else {
      expect(ours(patch)).toBe('error')
      expect(parseMessage(patch)).toMatch(refusedHint)
    }
  })

  it.runIf(hasGit).each(unnumberedCases)('git apply agrees: $name', ({ patch, git: expected }) => {
    expect(real(patch)).toEqual(expected)
  })
})

describe('names of bare "---"/"+++" pairs', () => {
  it.each(cases)('$name', ({ patch, files, git: expected, refusal }) => {
    if (refusal === undefined) expect(ours(patch, files)).toEqual(expected)
    else {
      expect(ours(patch, files)).toBe('error')
      expect(parseMessage(patch)).toMatch(refusal)
    }
  })

  it.runIf(hasGit).each(cases)('git apply agrees: $name', ({ patch, files, git: expected }) => {
    expect(real(patch, files)).toEqual(expected)
  })

  it('names the file of an unnumbered hunk as git would name it with line numbers', () => {
    expect(ours('--- x/f\n+++ x/f\n@@ @@\n-a\n+A\n')).toEqual(updated('f'))
    expect(ours('--- f\n+++ f\n@@ @@\n-a\n+A\n')).toEqual(updated('f'))
    expect(ours('--- a/f 2010-07-05 19:41:17\n+++ b/f 2010-07-05 19:41:18\n@@ @@\n-a\n+A\n')).toEqual(updated('f'))
  })

  it('explains a name git cannot find', () => {
    expect(parseMessage(pair('f', '/dev/null', remove))).toMatch(/-p1/)
  })

  /** Name forms, each with and without timestamps, on both sides of a pair. */
  const names = ['f', 'x/f', 'a/f', 'b/f', 'x/f.orig', 'f.orig', '/dev/null', '"x/f"', '"f"', 'a/my f', 'x/', '/f']
  const stamps: [string, string][] = [['', ''], [' 2010-07-05 19:41:17', ' 2010-07-05 19:41:18'], ['\t2010-07-05 19:41:17.5 -0500', '\t2010-07-05 19:41:18 +0100'], ['\t1970-01-01 00:00:00 +0000', '\t2010-07-05 19:41:18 +0100'], ['\t2010-07-05 19:41:17 +0000', '\t1969-12-31 23:00:00 -0100'], ['\r', '\r']]
  const generated = names.flatMap(first => names.flatMap(second => stamps.map(([s1, s2]) => {
    const hunk = first === '/dev/null' || s1.includes('1970') ? add : second === '/dev/null' || s2.includes('1969') ? remove : update
    return pair(first + s1, second + s2, hunk)
  })))

  it.runIf(hasGit)('never applies a generated pair where git refuses it or differently from git', () => {
    let applied = 0
    for (const patch of generated) {
      const actual = ours(patch)
      if (actual === 'error') continue
      applied += 1
      expect({ patch, files: actual }).toEqual({ patch, files: real(patch) })
    }
    expect(applied).toBeGreaterThan(200)
  }, 120_000)

  /** Two sections in a row: the first may make git guess -p0 for the second. */
  const sections = [pair('f', 'f'), pair('x/f', 'x/f'), pair('a/g', 'b/g'), pair('g', 'g'), pair('/dev/null', 'h', add), pair('/dev/null', 'x/h', add), `diff --git a/g b/g\n--- a/g\n+++ b/g\n${update}`, '--- f\n+++ f\n']

  it.runIf(hasGit)('never applies two generated sections where git refuses them or differently from git', () => {
    let applied = 0
    for (const first of sections) {
      for (const second of sections) {
        const patch = first + second
        const actual = ours(patch)
        if (actual === 'error') continue
        applied += 1
        expect({ patch, files: actual }).toEqual({ patch, files: real(patch) })
      }
    }
    expect(applied).toBeGreaterThan(20)
  }, 60_000)
})
