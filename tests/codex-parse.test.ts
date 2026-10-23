import { describe, expect, it } from 'vitest'
import { parseCodexPatch } from '../src/parse/codex.js'
import { detectFormat } from '../src/detect.js'

const wrap = (...body: string[]) => ['*** Begin Patch', ...body, '*** End Patch'].join('\n')

describe('parseCodexPatch', () => {
  it('parses add, delete, update with move, labels and end-of-file', () => {
    const parsed = parseCodexPatch(wrap(
      '*** Add File: a.txt', '+one', '+two',
      '*** Delete File: gone.txt',
      '*** Update File: src/x.py', '*** Move to: src/y.py',
      '@@ class A', '@@ def f():', '-    pass', '+    return 1',
      '@@', ' tail', '+more', '*** End of File',
    ))
    expect(parsed.ops).toEqual([
      { kind: 'add', path: 'a.txt', content: 'one\ntwo\n' },
      { kind: 'delete', path: 'gone.txt' },
      {
        kind: 'update', path: 'src/x.py', moveTo: 'src/y.py', chunks: [
          { labels: ['class A', 'def f():'], oldLines: ['    pass'], newLines: ['    return 1'], endOfFile: false },
          { labels: [], oldLines: ['tail'], newLines: ['tail', 'more'], endOfFile: true },
        ],
      },
    ])
  })

  it('accepts a first change without "@@", as GPT models emit it', () => {
    const parsed = parseCodexPatch(wrap('*** Update File: x', ' import foo', '+bar'))
    expect(parsed.ops[0]).toMatchObject({ chunks: [{ labels: [], oldLines: ['import foo'], newLines: ['import foo', 'bar'] }] })
  })

  it('treats blank lines before the next operation or the end as separators', () => {
    const parsed = parseCodexPatch(wrap('*** Update File: x', '@@', '-a', '+b', '', '*** Update File: y', '@@', '-c', '+d', ''))
    expect(parsed.ops.map(op => op.kind === 'update' ? op.chunks[0].oldLines : [])).toEqual([['a'], ['c']])
  })

  it('ignores a heredoc or fence around the markers and padded marker lines', () => {
    const text = `apply_patch <<'EOF'\n*** Begin Patch \n*** Add File: n.txt\n+x\n  *** End Patch\nEOF`
    expect(parseCodexPatch(text).ops).toEqual([{ kind: 'add', path: 'n.txt', content: 'x\n' }])
    expect(detectFormat(text)).toBe('codex')
  })

  it('keeps an added file empty when it has no lines', () => {
    expect(parseCodexPatch(wrap('*** Add File: empty.txt')).ops).toEqual([{ kind: 'add', path: 'empty.txt', content: '' }])
  })

  it.each([
    ['no end marker', '*** Begin Patch\n*** Add File: a\n+x', 'must end with "*** End Patch"'],
    ['an update without changes', wrap('*** Update File: x'), 'has no changes'],
    ['a context-only change', wrap('*** Update File: x', '@@', ' same'), 'has no "-" or "+" lines'],
    ['a bad change line', wrap('*** Update File: x', '@@', '-a', '*b'), 'must start with " ", "-" or "+"'],
    ['an add line without "+"', wrap('*** Add File: a', '+x', 'y'), 'must start with "+"'],
    ['an unknown header', wrap('*** Rename File: a'), 'expected "*** Add File: "'],
    ['a second change without "@@"', wrap('*** Update File: x', '@@', '-a', '+b', '*** End of File', '-c', '+d'), 'expected an "@@" line'],
  ])('rejects %s', (_name, text, message) => {
    expect(() => parseCodexPatch(text)).toThrow(message)
  })
})
