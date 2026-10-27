/**
 * Display diffs (`meta.diffs`): one entry per hunk with three context lines around the edits the
 * patch made, fragments as LF-terminated lines (without the LF a file's last line lacks), byte caps per entry and per call, and resolved
 * absolute paths for real patches.
 */

import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { editChunks, editFile } from '../src/apply/content.js'
import { displayDiffs, hunkTexts } from '../src/diff.js'
import type { TextEdit } from '../src/diff.js'
import { parseCodexPatch } from '../src/parse/codex.js'
import { parseUnifiedDiff } from '../src/parse/unified.js'
import { harness } from './harness.js'
import type { Harness } from './harness.js'

const numbered = (n: number, from = 1) => Array.from({ length: n }, (_, i) => `line ${i + from}`)
const text = (lines: readonly string[], eol = '\n') => lines.map(line => line + eol).join('')
/** Lines as a terminated fragment. */
const shown = (...lines: string[]) => lines.map(line => `${line}\n`).join('')
/** Lines ending at a last line without a line ending, as a fragment. */
const unterminated = (...lines: string[]) => lines.join('\n')

const chunksOf = (patch: string, format: 'codex' | 'unified') => {
  const op = (format === 'codex' ? parseCodexPatch(patch) : parseUnifiedDiff(patch)).ops[0]
  if (op.kind !== 'update') throw new Error('not an update')
  return op.chunks
}
const codexPatch = (...body: string[]) => ['*** Begin Patch', '*** Update File: f', ...body, '*** End Patch'].join('\n')
const unifiedPatch = (...body: string[]) => ['--- a/f', '+++ b/f', ...body, ''].join('\n')

/** Apply `edits` to `before`; they must be in order, disjoint, and give `after`. */
const replay = (before: string, after: string, edits: readonly TextEdit[]) => {
  let out = ''
  let at = 0
  for (const edit of edits) {
    expect(edit.oldFrom).toBeGreaterThanOrEqual(at)
    expect(edit.oldTo).toBeGreaterThanOrEqual(edit.oldFrom)
    out += before.slice(at, edit.oldFrom)
    expect(out.length).toBe(edit.newFrom)
    out += after.slice(edit.newFrom, edit.newTo)
    at = edit.oldTo
  }
  return out + before.slice(at)
}

describe('edits the patch made', () => {
  it('turns the old text into the new one for Codex chunks and unified hunks', () => {
    let seed = 7
    const random = (k: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % k
    }
    for (let round = 0; round < 400; round += 1) {
      const eol = ['\n', '\r\n', '\r'][random(3)]
      const lines = Array.from({ length: 5 + random(30) }, (_, i) => random(4) === 0 ? '' : `r${i}`)
      lines.push('end')
      const before = lines.map(line => line + eol).join('').slice(0, random(3) === 0 ? -eol.length : undefined)
      const body: string[] = []
      for (let at = 1 + random(3); at + 2 < lines.length; at += 3 + random(5)) {
        body.push('@@', ` ${lines[at - 1]}`)
        const removed = random(3)
        body.push(...lines.slice(at, at + removed).map(line => `-${line}`))
        for (let j = removed === 0 ? 1 + random(2) : random(3); j > 0; j -= 1) body.push(`+n${round}_${j}`)
        at += removed
        body.push(` ${lines[at]}`)
      }
      if (random(3) === 0) body.push('@@', `+tail${round}`)
      if (body.length === 0) continue
      const patched = editChunks('f', before, chunksOf(codexPatch(...body), 'codex'), 'codex')
      expect(replay(before, patched.text, patched.edits)).toBe(patched.text)
    }
    for (let round = 0; round < 200; round += 1) {
      const lines = Array.from({ length: 12 + random(20) }, (_, i) => `u${i}${random(5) === 0 ? '\r' : ''}`)
      const before = text(lines)
      const hunks: string[] = []
      for (let at = 1 + random(3); at + 3 < lines.length; at += 4 + random(4)) {
        const added = Array.from({ length: random(3) }, (_, j) => `+m${round}_${at}_${j}`)
        const removed = 1 + random(2)
        hunks.push(`@@ -${at},${removed + 2} +${at},${added.length + 2} @@`, ` ${lines[at - 1]}`, ...lines.slice(at, at + removed).map(line => `-${line}`), ...added, ` ${lines[at + removed]}`)
        at += removed
      }
      const patched = editChunks('f', before, chunksOf(unifiedPatch(...hunks), 'unified'), 'unified')
      expect(replay(before, patched.text, patched.edits)).toBe(patched.text)
    }
  })

  it('reports a Codex end of file that gains its line ending and appended lines', () => {
    const patched = editChunks('f', 'a\nb', chunksOf(codexPatch('@@', '+c'), 'codex'), 'codex')
    expect(patched.text).toBe('a\nb\nc\n')
    expect(replay('a\nb', patched.text, patched.edits)).toBe(patched.text)
    expect(hunkTexts('a\nb', patched.text, patched.edits)).toEqual([{ oldText: unterminated('a', 'b'), newText: shown('a', 'b', 'c') }])
  })

  it('keeps the byte order mark out of the edits retried without it', () => {
    const before = '\uFEFFa\nb\n'
    const patched = editFile('f', before, chunksOf(unifiedPatch('@@ -1,2 +1,2 @@', '-a', '+A', ' b'), 'unified'), 'unified')
    expect(patched.text).toBe('\uFEFFA\nb\n')
    expect(replay(before, patched.text, patched.edits)).toBe(patched.text)
    expect(hunkTexts(before, patched.text, patched.edits)).toEqual([{ oldText: shown('a', 'b'), newText: shown('A', 'b') }])
  })

  it('shows an unchanged hunk of a unified diff as nothing', () => {
    const patched = editChunks('f', 'a\nb\nc\n', chunksOf(unifiedPatch('@@ -1,3 +1,3 @@', ' a', ' b', ' c'), 'unified'), 'unified')
    expect(patched.text).toBe('a\nb\nc\n')
    expect(hunkTexts('a\nb\nc\n', patched.text, patched.edits)).toEqual([])
  })
})

describe('hunks of a text change', () => {
  const codexHunks = (before: string, ...body: string[]) => {
    const patched = editChunks('f', before, chunksOf(codexPatch(...body), 'codex'), 'codex')
    return hunkTexts(before, patched.text, patched.edits)
  }

  it('shows edits far apart in a large file as separate hunks with three context lines', () => {
    const lines = numbered(10000)
    const before = text(lines)
    const patched = editChunks('f', before, chunksOf(codexPatch('@@', '-line 10', '+LINE 10', '@@', '-line 9000', '+LINE 9000'), 'codex'), 'codex')
    expect(hunkTexts(before, patched.text, patched.edits)).toEqual([
      { oldText: shown(...numbered(7, 7)), newText: shown(...numbered(3, 7), 'LINE 10', ...numbered(3, 11)) },
      { oldText: shown(...numbered(7, 8997)), newText: shown(...numbered(3, 8997), 'LINE 9000', ...numbered(3, 9001)) },
    ])
    const diffs = displayDiffs([{ path: '/w/big.txt', action: 'modified', before, after: patched.text, edits: patched.edits }], 16 * 1024, 128 * 1024)
    expect(diffs).toHaveLength(2)
    expect(diffs.every(diff => diff.truncated === undefined && diff.path === '/w/big.txt')).toBe(true)
  })

  it.each([
    ['top', 0, { oldText: shown('line 1', 'line 2', 'line 3'), newText: shown('new', 'line 1', 'line 2', 'line 3') }, undefined],
    ['middle', 5, { oldText: shown('line 3', 'line 4', 'line 5', 'line 6', 'line 7', 'line 8'), newText: shown('line 3', 'line 4', 'line 5', 'new', 'line 6', 'line 7', 'line 8') }, undefined],
    // Without a final line ending the old last line gains one, so it is changed too, as in a unified diff.
    ['end', 10, { oldText: shown('line 8', 'line 9', 'line 10'), newText: shown('line 8', 'line 9', 'line 10', 'new') }, { oldText: unterminated('line 10'), newText: unterminated('line 10', 'new') }],
  ])('shows an insertion at the %s as terminated lines, leaving out a missing final line ending', (_where, at, hunk, tail) => {
    const lines = numbered(10)
    const after = [...lines.slice(0, at), 'new', ...lines.slice(at)]
    expect(hunkTexts(text(lines), text(after))).toEqual([hunk])
    const old = text(lines).slice(0, -1)
    const neu = text(after).slice(0, -1)
    const expected = tail === undefined ? hunk : { oldText: shown('line 7', 'line 8', 'line 9') + tail.oldText, newText: shown('line 7', 'line 8', 'line 9') + tail.newText }
    expect(hunkTexts(old, neu)).toEqual([expected])
  })

  it('shows a blank line added or removed at the end of a hunk as a line', () => {
    expect(hunkTexts('a\n', 'a\n\n')).toEqual([{ oldText: 'a\n', newText: 'a\n\n' }])
    expect(hunkTexts('a\n\n', 'a\n')).toEqual([{ oldText: 'a\n\n', newText: 'a\n' }])
    expect(hunkTexts('', '\n')).toEqual([{ oldText: null, newText: '\n' }])
    expect(codexHunks('a\nb\n', '@@', ' a', '+', ' b')).toEqual([{ oldText: shown('a', 'b'), newText: shown('a', '', 'b') }])
    expect(codexHunks('a\n\nb\n', '@@', ' a', '-', ' b')).toEqual([{ oldText: shown('a', '', 'b'), newText: shown('a', 'b') }])
  })

  it('leaves out the line ending a last line lacks, on the old side, the new side or both', () => {
    // Old side only: the tail.txt case, `first\nlast` -> `first\nLAST\n`, is one line removed and one added.
    expect(hunkTexts('first\nlast', 'first\nLAST\n')).toEqual([{ oldText: unterminated('first', 'last'), newText: shown('first', 'LAST') }])
    expect(hunkTexts('a\nb\n', 'a\nB')).toEqual([{ oldText: shown('a', 'b'), newText: unterminated('a', 'B') }])
    expect(hunkTexts('x', 'y')).toEqual([{ oldText: 'x', newText: 'y' }])
    expect(hunkTexts('a\nb\nc', 'A\nb\nc')).toEqual([{ oldText: unterminated('a', 'b', 'c'), newText: unterminated('A', 'b', 'c') }])
    // A last line left unchanged inside the context keeps lacking its line ending on both sides.
    expect(hunkTexts('a\nb\nc\nd', 'a\nB\nc\nd')).toEqual([{ oldText: unterminated('a', 'b', 'c', 'd'), newText: unterminated('a', 'B', 'c', 'd') }])
  })

  it('still lists a change of only the final line ending, with sides that look equal', () => {
    expect(hunkTexts('a\nb', 'a\nb\n')).toEqual([{ oldText: unterminated('a', 'b'), newText: shown('a', 'b') }])
    expect(hunkTexts('a\nb\n', 'a\nb')).toEqual([{ oldText: shown('a', 'b'), newText: unterminated('a', 'b') }])
    expect(codexHunks('a\nb\nc\nd\ne\nf\ng\nh\ni\nj', '@@', '-a', '+A')).toEqual([
      { oldText: shown('a', 'b', 'c', 'd'), newText: shown('A', 'b', 'c', 'd') },
      { oldText: unterminated('g', 'h', 'i', 'j'), newText: shown('g', 'h', 'i', 'j') },
    ])
    expect(displayDiffs([{ path: '/w/f', action: 'modified', before: 'a', after: 'a\n' }], 16 * 1024, 128 * 1024)).toEqual([{ path: '/w/f', oldText: 'a', newText: 'a\n' }])
  })

  it('keeps an empty last line as an empty line', () => {
    expect(hunkTexts('a\n\n', 'b\n\n')).toEqual([{ oldText: 'a\n\n', newText: 'b\n\n' }])
  })

  it('drops CRLF and LF from shown lines, keeps a lone CR, and compares line endings', () => {
    expect(hunkTexts('a\r\nb\r\nc\r\n', 'a\r\nB\r\nc\r\n')).toEqual([{ oldText: shown('a', 'b', 'c'), newText: shown('a', 'B', 'c') }])
    expect(hunkTexts('a\r\nb\r\n', 'a\r\nb\n')).toEqual([{ oldText: shown('a', 'b'), newText: shown('a', 'b') }])
    expect(hunkTexts('a\rb\n', 'a\rc\n')).toEqual([{ oldText: shown('a\rb'), newText: shown('a\rc') }])
    expect(hunkTexts('a\r\nb', 'a\r\nB')).toEqual([{ oldText: unterminated('a', 'b'), newText: unterminated('a', 'B') }])
    expect(hunkTexts('a\r\nb', 'a\r\nb\r\nc\r\n')).toEqual([{ oldText: unterminated('a', 'b'), newText: shown('a', 'b', 'c') }])
    expect(codexHunks('a\r\nb\r\n', '@@', ' a', '+', ' b')).toEqual([{ oldText: shown('a', 'b'), newText: shown('a', '', 'b') }])
  })

  it('does not show a leading byte order mark', () => {
    expect(hunkTexts('\uFEFFa\nb\n', '\uFEFFa\nB\n')).toEqual([{ oldText: shown('a', 'b'), newText: shown('a', 'B') }])
  })

  it('merges changes up to six equal lines apart into one hunk and splits them at seven', () => {
    const lines = numbered(30)
    const change = (a: number, b: number) => codexHunks(text(lines), '@@', `-${lines[a]}`, `+${lines[a]}!`, '@@', `-${lines[b]}`, `+${lines[b]}!`)
    expect(change(10, 17)).toHaveLength(1)
    expect(change(10, 18)).toHaveLength(2)
  })

  it('shows the lines a change replaced, not the lines it left as they were', () => {
    expect(codexHunks(text(numbered(9)), '@@', '-line 4', '-line 5', '-line 6', '+line 4', '+LINE 5', '+line 6')).toEqual([
      { oldText: shown(...numbered(7, 2)), newText: shown('line 2', 'line 3', 'line 4', 'LINE 5', 'line 6', 'line 7', 'line 8') },
    ])
  })

  it('stays within the time it takes to read the hunks when many large files change in many places', () => {
    // A 365 KB Codex patch: 50 files of 1.2 million lines, one line replaced every 2,400 lines.
    const per = 500
    const stride = 2400
    const filler = 'x\n'.repeat(stride - 1)
    const before = Array.from({ length: per }, (_, i) => `a${i}\n${filler}`).join('')
    const body = Array.from({ length: per }, (_, i) => ['@@', `-a${i}`, `+b${i}`]).flat()
    const patched = editChunks('f', before, chunksOf(codexPatch(...body), 'codex'), 'codex')
    expect(patched.text).toBe(Array.from({ length: per }, (_, i) => `b${i}\n${filler}`).join(''))
    const files = Array.from({ length: 50 }, (_, i) => ({ path: `/w/f${i}`, action: 'modified' as const, before, after: patched.text, edits: patched.edits }))
    const started = performance.now()
    const diffs = displayDiffs(files, 16 * 1024, 128 * 1024)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(diffs.filter(diff => diff.truncated !== true).length).toBeGreaterThan(100)
    const truncated = diffs.filter(diff => diff.truncated === true)
    expect(truncated.length).toBeLessThanOrEqual(50)
    expect(truncated.slice(-40)).toEqual(files.slice(10).map(file => ({ path: file.path, oldText: '', newText: '', truncated: true })))
    // A file whose edits are not known is shown from its first to its last change, within the caps.
    const span = displayDiffs([{ path: '/w/g', action: 'modified', before, after: patched.text }], 16 * 1024, 128 * 1024)
    expect(span).toEqual([{ path: '/w/g', oldText: '', newText: '', truncated: true }])
  })
})

describe('display diffs of a patch', () => {
  it('gives an added file one entry with oldText null, also when it is empty', () => {
    expect(displayDiffs([
      { path: '/w/n.txt', action: 'added', before: null, after: 'hello\nworld\n' },
      { path: '/w/u.txt', action: 'added', before: null, after: 'hello\r\nworld' },
      { path: '/w/e.txt', action: 'added', before: null, after: '' },
    ], 16 * 1024, 128 * 1024)).toEqual([
      { path: '/w/n.txt', oldText: null, newText: 'hello\nworld\n' },
      { path: '/w/u.txt', oldText: null, newText: 'hello\nworld' },
      { path: '/w/e.txt', oldText: null, newText: '' },
    ])
  })

  it('gives a deleted file one entry with its text, and none when its text is unknown or empty', () => {
    expect(displayDiffs([
      { path: '/w/gone.txt', action: 'deleted', before: 'a\nb\n', after: null },
      { path: '/w/gone.bin', action: 'deleted', before: null, after: null },
      { path: '/w/empty', action: 'deleted', before: '', after: null },
      { path: '/w/tail.txt', action: 'deleted', before: 'a\nb', after: null },
    ], 16 * 1024, 128 * 1024)).toEqual([{ path: '/w/gone.txt', oldText: 'a\nb\n', newText: '' }, { path: '/w/tail.txt', oldText: 'a\nb', newText: '' }])
  })

  it('gives an unchanged moved file no entry', () => {
    expect(displayDiffs([{ path: '/w/to.txt', action: 'modified', before: 'a\n', after: 'a\n' }], 16 * 1024, 128 * 1024)).toEqual([])
  })

  it('drops the texts of an entry over the per-entry cap and keeps the other hunks of the file', () => {
    const before = text(numbered(1000))
    const patched = editChunks('f', before, chunksOf(codexPatch('@@', '-line 11', `+${'x'.repeat(2000)}`, '@@', '-line 901', '+changed'), 'codex'), 'codex')
    expect(displayDiffs([{ path: 'f', action: 'modified', before, after: patched.text, edits: patched.edits }], 1024, 128 * 1024)).toEqual([
      { path: 'f', oldText: '', newText: '', truncated: true },
      { path: 'f', oldText: shown(...numbered(7, 898)), newText: shown('line 898', 'line 899', 'line 900', 'changed', 'line 902', 'line 903', 'line 904') },
    ])
  })

  it('keeps entries in order until the call cap and merges the truncated rest of each file', () => {
    const lines = numbered(400)
    const before = text(lines)
    const patched = editChunks('f', before, chunksOf(codexPatch(...lines.filter((_, i) => i % 20 === 10).flatMap(line => ['@@', `-${line}`, `+${line}!`])), 'codex'), 'codex')
    const files = ['a', 'b', 'c'].map(path => ({ path, action: 'modified' as const, before, after: patched.text, edits: patched.edits }))
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
      { path: join(h.dir, 'sub/n.txt'), oldText: 'm\n', newText: 'M\n' },
      { path: join(h.dir, 'gone.txt'), oldText: 'g1\ng2\n', newText: '' },
      { path: join(h.dir, 'crlf.txt'), oldText: 'a\nb\nc\n', newText: 'a\nB\nc\n' },
      { path: join(h.dir, 'new.txt'), oldText: null, newText: 'x\ny\n' },
    ])
    expect(readFileSync(join(h.dir, 'crlf.txt'), 'utf8')).toBe('a\r\nB\r\nc\r\n')
  })

  it('shows a file without a final newline as its lines on both sides', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'tail.txt'), 'first\nlast')
    writeFileSync(join(h.dir, 'gone.txt'), 'g1\ng2')
    for (const name of ['tail.txt', 'gone.txt']) await h.observe(name)
    const result = await h.run(patch('*** Update File: tail.txt', '@@', '-last', '+LAST', '*** Delete File: gone.txt')) as Result
    expect(readFileSync(join(h.dir, 'tail.txt'), 'utf8')).toBe('first\nLAST\n')
    expect(result.diffs).toEqual([
      { path: join(h.dir, 'tail.txt'), oldText: 'first\nlast', newText: 'first\nLAST\n' },
      { path: join(h.dir, 'gone.txt'), oldText: 'g1\ng2', newText: '' },
    ])
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
    expect(real.diffs).toEqual([{ path: h.fs.processPath(await h.fs.resolve('link.txt', { cwd: h.dir })), oldText: 'one\ntwo\n', newText: 'one\nTWO\n' }])
    expect(existsSync(join(h.dir, 'link.txt'))).toBe(true)
  })

  it('carries the entries in the result metadata and shows the kept ones on the diff card', async () => {
    const h = await open({ config: { maxDiffBytes: 256 } })
    const result = await h.execute(patch('*** Add File: small.txt', '+hi'))
    expect(result.meta).toEqual({ diffs: [{ path: join(h.dir, 'small.txt'), oldText: null, newText: 'hi\n' }] })
    const definition = h.ctx.tools.get('apply_patch')
    expect(definition?.presentResult?.({ input: '' }, { content: [], isError: false, meta: result.meta })).toEqual({
      card: 'diff', title: 'Apply patch', diffs: [{ path: join(h.dir, 'small.txt'), oldText: null, newText: 'hi\n' }],
    })
    const large = await h.execute(patch('*** Add File: large.txt', ...Array.from({ length: 100 }, (_, i) => `+row ${i}`)))
    expect(large.meta).toEqual({ diffs: [{ path: join(h.dir, 'large.txt'), oldText: null, newText: '', truncated: true }] })
    expect(definition?.presentResult?.({ input: '' }, { content: [], isError: false, meta: large.meta })).toEqual({ card: 'generic', title: 'Apply patch' })
  })
})
