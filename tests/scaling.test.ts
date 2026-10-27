import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { applyChunks } from '../src/apply/content.js'
import { parseCodexPatch } from '../src/parse/codex.js'
import { parseUnifiedDiff } from '../src/parse/unified.js'

/**
 * Many small hunks in a large file cost about the size of the hunks, not the
 * size of the file times the number of hunks. The bounds are generous (the
 * measured times are tens of milliseconds); quadratic behaviour takes seconds.
 */

function chunksOf(patch: string, format: 'codex' | 'unified') {
  const op = (format === 'codex' ? parseCodexPatch(patch) : parseUnifiedDiff(patch)).ops[0]
  if (op.kind !== 'update') throw new Error(`expected an update, got ${op.kind}`)
  return op.chunks
}

/** Apply and return the text and the milliseconds the application took. */
function timed(before: string, patch: string, format: 'codex' | 'unified'): { text: string; ms: number } {
  const chunks = chunksOf(patch, format)
  const start = performance.now()
  const text = applyChunks('f', before, chunks, format)
  return { text, ms: performance.now() - start }
}

describe('large files with many hunks', () => {
  const n = 100_000
  const k = 200
  const lines = Array.from({ length: n }, (_, i) => `line_${String(i).padStart(7, '0')}_abcdefghijklmnopqrstuvwxyz`)
  const changed = [...lines]
  let unified = '--- a/f\n+++ b/f\n'
  let codex = '*** Begin Patch\n*** Update File: f\n'
  for (let j = 0; j < k; j += 1) {
    const at = 2 + Math.floor((n - 5) * j / k)
    changed[at] = `${lines[at]}_changed`
    const body = ` ${lines[at - 1]}\n-${lines[at]}\n+${changed[at]}\n ${lines[at + 1]}\n`
    unified += `@@ -${at},3 +${at},3 @@\n${body}`
    codex += `@@\n${body}`
  }
  codex += '*** End Patch\n'
  const before = `${lines.join('\n')}\n`
  const expected = `${changed.join('\n')}\n`

  it('applies 200 three-line unified hunks to a 4 MB file of 100,000 lines in under 2 s', () => {
    expect(Buffer.byteLength(before)).toBe(4_000_000)
    const { text, ms } = timed(before, unified, 'unified')
    expect(text === expected).toBe(true)
    expect(ms).toBeLessThan(2000)
  })

  it('applies the same 200 changes as a Codex patch in under 2 s', () => {
    const { text, ms } = timed(before, codex, 'codex')
    expect(text === expected).toBe(true)
    expect(ms).toBeLessThan(2000)
  })

  it('applies the hunks in reverse order with the same bytes', () => {
    const hunks = unified.slice('--- a/f\n+++ b/f\n'.length).split(/(?=^@@ )/m)
    const { text, ms } = timed(before, `--- a/f\n+++ b/f\n${hunks.reverse().join('')}`, 'unified')
    expect(text === expected).toBe(true)
    expect(ms).toBeLessThan(2000)
  })
})

describe('repetitive files', () => {
  const row = '0,0,0,0,0,0,0,0'
  const n = 200_000
  const before = `${row}\n`.repeat(n)

  it('applies 200 Codex changes with 40 identical context lines each to a 3.2 MB file in under 2 s', () => {
    const context = 40
    const k = 200
    const patch = `*** Begin Patch\n*** Update File: f\n${`@@\n${` ${row}\n`.repeat(context)}+1,1,1,1,1,1,1,1\n`.repeat(k)}*** End Patch\n`
    const { text, ms } = timed(before, patch, 'codex')
    expect(text === `${`${row}\n`.repeat(context)}1,1,1,1,1,1,1,1\n`.repeat(k) + `${row}\n`.repeat(n - context * k)).toBe(true)
    expect(ms).toBeLessThan(2000)
  })

  it('applies one Codex change with 80,000 identical context lines in under 2 s', () => {
    const k = 80_000
    const { text, ms } = timed('x\n'.repeat(250_000), `*** Begin Patch\n*** Update File: f\n@@\n${' x\n'.repeat(k)}+z\n*** End Patch\n`, 'codex')
    expect(text === `${'x\n'.repeat(k)}z\n${'x\n'.repeat(250_000 - k)}`).toBe(true)
    expect(ms).toBeLessThan(2000)
  })

  it('finds a Codex change of 1,000 identical context lines and one unique line at the end of 200,000 identical lines in under 2 s', () => {
    const context = 1000
    const tag = '1,1,1,1,1,1,1,1'
    const file = `${row}\n`.repeat(n - 1) + `${tag}\n`
    const { text, ms } = timed(file, `*** Begin Patch\n*** Update File: f\n@@\n${` ${row}\n`.repeat(context)}-${tag}\n+changed\n*** End Patch\n`, 'codex')
    expect(text === `${row}\n`.repeat(n - 1) + 'changed\n').toBe(true)
    expect(ms).toBeLessThan(2000)
  })

  it('finds the same change tolerating trailing whitespace in under 2 s', () => {
    const context = 1000
    const tag = '1,1,1,1,1,1,1,1'
    const file = `${row} \n`.repeat(n - 1) + `${tag}\n`
    const { text, ms } = timed(file, `*** Begin Patch\n*** Update File: f\n@@\n${` ${row}\n`.repeat(context)}-${tag}\n+changed\n*** End Patch\n`, 'codex')
    expect(text === `${row} \n`.repeat(n - 1) + 'changed\n').toBe(true)
    expect(ms).toBeLessThan(2000)
  })

  it('refuses a stale Codex change of 3,000 identical context lines in a file of 200,000 identical lines in under 2 s', () => {
    const chunks = chunksOf(`*** Begin Patch\n*** Update File: f\n@@\n${` ${row}\n`.repeat(3000)}-1,1,1,1,1,1,1,1\n+2\n*** End Patch\n`, 'codex')
    const start = performance.now()
    expect(() => applyChunks('f', before, chunks, 'codex')).toThrow(/Could not find the lines of change 1/)
    expect(performance.now() - start).toBeLessThan(2000)
  })

  it('applies 200 unified hunks with 10 identical context lines each in under 2 s', () => {
    const half = ` ${row}\n`.repeat(5)
    const k = 200
    let patch = '--- a/f\n+++ b/f\n'
    for (let j = 0; j < k; j += 1) patch += `@@ -${j * 10 + 1},10 +${j * 11 + 1},11 @@\n${half}+1\n${half}`
    const { text, ms } = timed(before, patch, 'unified')
    const rows = `${row}\n`.repeat(5)
    expect(text === `${rows}1\n${rows}`.repeat(k) + `${row}\n`.repeat(n - 10 * k)).toBe(true)
    expect(ms).toBeLessThan(2000)
  })

  it('finds an unnumbered unified hunk of 1,000 identical context lines and one unique line at the end of 200,000 identical lines in under 2 s', () => {
    const tag = '1,1,1,1,1,1,1,1'
    const file = `${row}\n`.repeat(n - 1) + `${tag}\n`
    const { text, ms } = timed(file, `--- a/f\n+++ b/f\n@@ @@\n${` ${row}\n`.repeat(1000)}-${tag}\n+changed\n`, 'unified')
    expect(text === `${row}\n`.repeat(n - 1) + 'changed\n').toBe(true)
    expect(ms).toBeLessThan(2000)
  })

  it('refuses a stale unnumbered unified hunk of 3,000 identical context lines in a file of 200,000 identical lines in under 2 s', () => {
    const chunks = chunksOf(`--- a/f\n+++ b/f\n@@ @@\n${` ${row}\n`.repeat(3000)}-1,1,1,1,1,1,1,1\n+2\n`, 'unified')
    const start = performance.now()
    expect(() => applyChunks('f', before, chunks, 'unified')).toThrow(/Could not find the lines of change 1/)
    expect(performance.now() - start).toBeLessThan(2000)
  })
})

const hasGit = spawnSync('git', ['--version']).status === 0

/**
 * Multi-hunk diffs that `git diff` writes for random edits of a file with CRLF
 * lines and without its final newline, applied in their order, reversed and
 * shuffled: the bytes (or the refusal) agree with `git apply`.
 */
describe.runIf(hasGit)('multi-hunk diffs agree with git apply', () => {
  let seed = 7
  const random = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32 }
  const words = ['a', 'b', 'c', 'a\r', 'b\r', '', ' a', 'x y']
  const cases = Array.from({ length: 12 }, (_, c) => {
    const size = 50 + Math.floor(random() * 150)
    const lines = Array.from({ length: size }, () => words[Math.floor(random() * words.length)])
    const edited = [...lines]
    for (let e = 0; e < 12; e += 1) {
      const at = Math.floor(random() * edited.length)
      const kind = random()
      if (kind < 0.4) edited[at] = `${edited[at]}!`
      else if (kind < 0.7) edited.splice(at, 1)
      else edited.splice(at, 0, `new${e}`)
    }
    const end = (list: string[], terminated: boolean) => list.join('\n') + (terminated ? '\n' : '')
    return { c, before: end(lines, c % 3 !== 0), after: end(edited, c % 4 !== 0), order: (['as written', 'reversed', 'shuffled'] as const)[c % 3] }
  })

  it.each(cases)('case $c, hunks $order', ({ before, after, order }) => {
    const dir = mkdtempSync(join(tmpdir(), 'ap-scaling-'))
    try {
      writeFileSync(join(dir, 'f'), before)
      writeFileSync(join(dir, 'g'), after)
      const diff = spawnSync('git', ['diff', '--no-index', '--no-color', '--', 'f', 'g'], { cwd: dir, encoding: 'utf8' }).stdout
      const body = diff.slice(diff.indexOf('\n@@ ') + 1)
      const hunks = body.split(/(?=^@@ )/m)
      if (order === 'reversed') hunks.reverse()
      if (order === 'shuffled') hunks.sort(() => random() - 0.5)
      const patch = `--- a/f\n+++ b/f\n${hunks.join('')}`
      writeFileSync(join(dir, '.patch'), patch)
      const git = spawnSync('git', ['apply', '.patch'], { cwd: dir })
      const expected = git.status === 0 ? readFileSync(join(dir, 'f'), 'utf8') : 'error'
      let actual: string
      try {
        actual = applyChunks('f', before, chunksOf(patch, 'unified'), 'unified')
      } catch (error: unknown) {
        expect(error).toMatchObject({ code: expect.stringMatching(/^PATCH_(CONFLICT|PARSE)$/) })
        actual = 'error'
      }
      expect(JSON.stringify(actual)).toBe(JSON.stringify(expected))
      if (order === 'as written') expect(actual).toBe(after)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
