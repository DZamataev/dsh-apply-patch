/**
 * Display diffs (`meta.diffs`): one entry per hunk with three context lines, texts joined
 * without a final line ending as the native `write`/`edit` report them, byte caps per entry
 * and per call, and resolved absolute paths for real patches.
 */

import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { diffLines, displayDiffs, hunkTexts } from '../src/diff.js'
import type { LineChange } from '../src/diff.js'
import { harness } from './harness.js'
import type { Harness } from './harness.js'

const numbered = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `line ${i + from}`)
const text = (lines: readonly string[], eol = '\n') => lines.map(line => line + eol).join('')

/** Apply `changes` to `a`; they must turn it into `b`. */
const replay = (a: readonly string[], b: readonly string[], changes: readonly LineChange[]) => {
  const out: string[] = []
  let at = 0
  for (const change of changes) {
    expect(change.oldStart).toBeGreaterThanOrEqual(at)
    expect(a.slice(at, change.oldStart)).toEqual(b.slice(out.length, out.length + change.oldStart - at))
    out.push(...a.slice(at, change.oldStart), ...b.slice(change.newStart, change.newEnd))
    expect(out.length).toBe(change.newEnd)
    at = change.oldEnd
  }
  out.push(...a.slice(at))
  return out
}

const edits = (changes: readonly LineChange[]) =>
  changes.reduce((sum, c) => sum + c.oldEnd - c.oldStart + c.newEnd - c.newStart, 0)

const shortest = (a: readonly string[], b: readonly string[]) => {
  const row = new Array<number>(b.length + 1).fill(0)
  for (let i = a.length - 1; i >= 0; i -= 1) {
    let diagonal = 0
    for (let j = b.length - 1; j >= 0; j -= 1) {
      const keep = row[j]
      row[j] = a[i] === b[j] ? diagonal + 1 : Math.max(row[j], row[j + 1])
      diagonal = keep
    }
  }
  return a.length + b.length - 2 * row[0]
}

describe('hunks of a text change', () => {
  it('shows edits far apart in a large file as separate hunks with three context lines', () => {
    const lines = numbered(10000)
    const after = lines.map(line => line === 'line 10' || line === 'line 9000' ? line.toUpperCase() : line)
    const hunks = hunkTexts(text(lines), text(after))
    expect(hunks).toEqual([
      { oldText: numbered(7, 7).join('\n'), newText: [...numbered(3, 7), 'LINE 10', ...numbered(3, 11)].join('\n') },
      { oldText: numbered(7, 8997).join('\n'), newText: [...numbered(3, 8997), 'LINE 9000', ...numbered(3, 9001)].join('\n') },
    ])
    const diffs = displayDiffs([{ path: '/w/big.txt', action: 'modified', before: text(lines), after: text(after) }], 16 * 1024, 128 * 1024)
    expect(diffs).toHaveLength(2)
    expect(diffs.every(diff => diff.truncated === undefined && diff.path === '/w/big.txt')).toBe(true)
  })

  it.each([
    ['top', 0, { oldText: 'line 1\nline 2\nline 3', newText: 'new\nline 1\nline 2\nline 3' }, undefined],
    ['middle', 5, { oldText: 'line 3\nline 4\nline 5\nline 6\nline 7\nline 8', newText: 'line 3\nline 4\nline 5\nnew\nline 6\nline 7\nline 8' }, undefined],
    // Without a final line ending the old last line gains one, so it is changed too, as in a unified diff.
    ['end', 10, { oldText: 'line 8\nline 9\nline 10', newText: 'line 8\nline 9\nline 10\nnew' }, { oldText: 'line 7\nline 8\nline 9\nline 10', newText: 'line 7\nline 8\nline 9\nline 10\nnew' }],
  ])('shows an insertion at the %s without a final line ending', (_where, at, hunk, unterminated) => {
    const lines = numbered(10)
    const after = [...lines.slice(0, at), 'new', ...lines.slice(at)]
    expect(hunkTexts(text(lines), text(after))).toEqual([hunk])
    expect(hunkTexts(text(lines).slice(0, -1), text(after).slice(0, -1))).toEqual([unterminated ?? hunk])
  })

  it('shows a change of only the final line ending as a hunk of equal-looking lines', () => {
    expect(hunkTexts('a\nb', 'a\nb\n')).toEqual([{ oldText: 'a\nb', newText: 'a\nb' }])
    expect(hunkTexts('x', 'y')).toEqual([{ oldText: 'x', newText: 'y' }])
  })

  it('keeps an empty last line as an empty line', () => {
    expect(hunkTexts('a\n\n', 'b\n\n')).toEqual([{ oldText: 'a\n', newText: 'b\n' }])
  })

  it('drops CRLF and LF from shown lines, keeps a lone CR, and compares line endings', () => {
    expect(hunkTexts('a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\n')).toEqual([{ oldText: 'a\nb\nc', newText: 'a\nB\nc' }])
    expect(hunkTexts('a\r\nb\r\n', 'a\r\nb\n')).toEqual([{ oldText: 'a\nb', newText: 'a\nb' }])
    expect(hunkTexts('a\rb\n', 'a\rc\n')).toEqual([{ oldText: 'a\rb', newText: 'a\rc' }])
  })

  it('does not show a leading byte order mark', () => {
    expect(hunkTexts('\uFEFFa\nb\n', '\uFEFFa\nB\n')).toEqual([{ oldText: 'a\nb', newText: 'a\nB' }])
  })

  it('merges changes up to six equal lines apart into one hunk and splits them at seven', () => {
    const lines = numbered(30)
    const change = (a: number, b: number) => lines.map((line, i) => i === a || i === b ? `${line}!` : line)
    expect(hunkTexts(text(lines), text(change(10, 17)))).toHaveLength(1)
    expect(hunkTexts(text(lines), text(change(10, 18)))).toHaveLength(2)
  })

  it('finds a shortest edit script that turns the old lines into the new ones', () => {
    let seed = 1
    const random = (k: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % k
    }
    for (let round = 0; round < 2000; round += 1) {
      const alphabet = 2 + random(5)
      const a = Array.from({ length: random(30) }, () => `l${random(alphabet)}`)
      const b = [...a]
      for (let e = random(6); e > 0; e -= 1) {
        const at = random(b.length + 1)
        if (random(2) === 0) b.splice(at, 0, `n${random(alphabet)}`)
        else b.splice(at, 1)
      }
      const changes = diffLines(a, b)
      expect(replay(a, b, changes)).toEqual(b)
      expect(edits(changes)).toBe(shortest(a, b))
    }
  })

  it('stays valid and fast when the shortest edit script is too costly to search', () => {
    const a = numbered(200_000)
    const b = a.map((line, i) => i % 5000 === 0 ? `${line} changed` : line)
    const started = performance.now()
    const changes = diffLines(a, b)
    expect(performance.now() - started).toBeLessThan(2000)
    expect(replay(a, b, changes)).toEqual(b)
    expect(changes).toHaveLength(40)
    // Without lines unique to both sides the costly part becomes one change.
    const same = Array.from({ length: 200_000 }, () => 'x')
    const other = [...same]
    for (let i = 0; i < 200_000; i += 5000) other[i] = 'y'
    const coarse = diffLines(same, other)
    expect(replay(same, other, coarse)).toEqual(other)
  })
})

describe('display diffs of a patch', () => {
  it('gives an added file one entry with oldText null, also when it is empty', () => {
    expect(displayDiffs([
      { path: '/w/n.txt', action: 'added', before: null, after: 'hello\nworld\n' },
      { path: '/w/e.txt', action: 'added', before: null, after: '' },
    ], 16 * 1024, 128 * 1024)).toEqual([
      { path: '/w/n.txt', oldText: null, newText: 'hello\nworld' },
      { path: '/w/e.txt', oldText: null, newText: '' },
    ])
  })

  it('gives a deleted file one entry with its text, and none when its text is unknown or empty', () => {
    expect(displayDiffs([
      { path: '/w/gone.txt', action: 'deleted', before: 'a\nb\n', after: null },
      { path: '/w/gone.bin', action: 'deleted', before: null, after: null },
      { path: '/w/empty', action: 'deleted', before: '', after: null },
    ], 16 * 1024, 128 * 1024)).toEqual([{ path: '/w/gone.txt', oldText: 'a\nb', newText: '' }])
  })

  it('gives an unchanged moved file no entry', () => {
    expect(displayDiffs([{ path: '/w/to.txt', action: 'modified', before: 'a\n', after: 'a\n' }], 16 * 1024, 128 * 1024)).toEqual([])
  })

  it('drops the texts of an entry over the per-entry cap and keeps the other hunks of the file', () => {
    const lines = numbered(1000)
    const after = lines.map((line, i) => i === 10 ? 'x'.repeat(2000) : i === 900 ? 'changed' : line)
    expect(displayDiffs([{ path: 'f', action: 'modified', before: text(lines), after: text(after) }], 1024, 128 * 1024)).toEqual([
      { path: 'f', oldText: '', newText: '', truncated: true },
      { path: 'f', oldText: 'line 898\nline 899\nline 900\nline 901\nline 902\nline 903\nline 904', newText: 'line 898\nline 899\nline 900\nchanged\nline 902\nline 903\nline 904' },
    ])
  })

  it('keeps entries in order until the call cap and merges the truncated rest of each file', () => {
    const lines = numbered(400)
    const after = lines.map((line, i) => i % 20 === 10 ? `${line}!` : line)
    const files = ['a', 'b', 'c'].map(path => ({ path, action: 'modified' as const, before: text(lines), after: text(after) }))
    const diffs = displayDiffs(files, 16 * 1024, 4096)
    const kept = diffs.filter(diff => diff.truncated !== true)
    const size = kept.reduce((sum, diff) => sum + Buffer.byteLength(diff.path + (diff.oldText ?? '') + diff.newText), 0)
    expect(size).toBeLessThanOrEqual(4096)
    expect(kept.length).toBeGreaterThan(0)
    expect(kept.length).toBeLessThan(60)
    expect(diffs.filter(diff => diff.truncated === true)).toEqual(
      [...new Set(diffs.filter(diff => diff.truncated === true).map(diff => diff.path))].map(path => ({ path, oldText: '', newText: '', truncated: true })),
    )
    expect(diffs.at(-1)).toEqual({ path: 'c', oldText: '', newText: '', truncated: true })
    // Every kept entry comes before every truncated one.
    expect(diffs.findIndex(diff => diff.truncated === true)).toBe(kept.length)
  })
})

describe('display diffs of real patches', () => {
  const opened: Harness[] = []
  const open = async (...args: Parameters<typeof harness>) => {
    const h = await harness(...args)
    opened.push(h)
    return h
  }
  afterEach(async () => {
    for (const h of opened.splice(0)) {
      chmodSync(h.dir, 0o700)
      await h.dispose()
    }
  })
  const patch = (...body: string[]) => ['*** Begin Patch', ...body, '*** End Patch'].join('\n')
  type Result = { files: { path: string }[]; diffs: { path: string; oldText: string | null; newText: string; truncated?: boolean }[] }

  it('stamps the resolved absolute path on every entry and keeps the written path in the files list', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'm.txt'), 'm\n')
    writeFileSync(join(h.dir, 'gone.txt'), 'g1\ng2\n')
    writeFileSync(join(h.dir, 'crlf.txt'), 'a\r\nb\r\nc\r\n')
    for (const name of ['m.txt', 'gone.txt', 'crlf.txt']) await h.observe(name)
    const result = await h.run(patch(
      '*** Update File: m.txt', '*** Move to: sub/n.txt', '@@', '-m', '+M',
      '*** Delete File: gone.txt',
      '*** Update File: crlf.txt', '@@', ' a', '-b', '+B', ' c',
      '*** Add File: new.txt', '+x', '+y',
    )) as Result
    expect(result.files.map(file => file.path)).toEqual(['sub/n.txt', 'gone.txt', 'crlf.txt', 'new.txt'])
    expect(result.diffs).toEqual([
      { path: join(h.dir, 'sub/n.txt'), oldText: 'm', newText: 'M' },
      { path: join(h.dir, 'gone.txt'), oldText: 'g1\ng2', newText: '' },
      { path: join(h.dir, 'crlf.txt'), oldText: 'a\nb\nc', newText: 'a\nB\nc' },
      { path: join(h.dir, 'new.txt'), oldText: null, newText: 'x\ny' },
    ])
    expect(readFileSync(join(h.dir, 'crlf.txt'), 'utf8')).toBe('a\r\nB\r\nc\r\n')
  })

  it('reports the same entries for a dry run, and the file a link points to', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'target.txt'), 'one\ntwo\n')
    symlinkSync(join(h.dir, 'target.txt'), join(h.dir, 'link.txt'))
    await h.observe('link.txt')
    const body = patch('*** Update File: link.txt', '@@', ' one', '-two', '+TWO')
    const dry = await h.run(body, { dry_run: true }) as Result
    expect(readFileSync(join(h.dir, 'target.txt'), 'utf8')).toBe('one\ntwo\n')
    const real = await h.run(body) as Result
    expect(dry.diffs).toEqual(real.diffs)
    expect(real.diffs).toEqual([{ path: h.fs.processPath(await h.fs.resolve('link.txt', { cwd: h.dir })), oldText: 'one\ntwo', newText: 'one\nTWO' }])
    expect(existsSync(join(h.dir, 'link.txt'))).toBe(true)
  })

  it('carries the entries in the result metadata and shows the kept ones on the diff card', async () => {
    const h = await open({ config: { maxDiffBytes: 256 } })
    const result = await h.execute(patch('*** Add File: small.txt', '+hi'))
    expect(result.meta).toEqual({ diffs: [{ path: join(h.dir, 'small.txt'), oldText: null, newText: 'hi' }] })
    const definition = h.ctx.tools.get('apply_patch')
    expect(definition?.presentResult?.({ input: '' }, { content: [], isError: false, meta: result.meta })).toEqual({
      card: 'diff', title: 'Apply patch', diffs: [{ path: join(h.dir, 'small.txt'), oldText: null, newText: 'hi' }],
    })
    const large = await h.execute(patch('*** Add File: large.txt', ...Array.from({ length: 100 }, (_, i) => `+row ${i}`)))
    expect(large.meta).toEqual({ diffs: [{ path: join(h.dir, 'large.txt'), oldText: null, newText: '', truncated: true }] })
    expect(definition?.presentResult?.({ input: '' }, { content: [], isError: false, meta: large.meta })).toEqual({ card: 'generic', title: 'Apply patch' })
  })
})
