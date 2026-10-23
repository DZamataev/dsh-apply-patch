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
          { labels: ['class A', 'def f():'], oldLines: ['    pass'], newLines: ['    return 1'], context: [], endOfFile: false },
          { labels: [], oldLines: ['tail'], newLines: ['tail', 'more'], context: [[0, 0]], endOfFile: true },
        ],
      },
    ])
  })

  it('accepts a first change without "@@", as GPT models emit it', () => {
    const parsed = parseCodexPatch(wrap('*** Update File: x', ' import foo', '+bar'))
    expect(parsed.ops[0]).toMatchObject({ chunks: [{ labels: [], oldLines: ['import foo'], newLines: ['import foo', 'bar'] }] })
  })

  it('keeps unprefixed blank lines as blank context and counts the trailing ones', () => {
    const parsed = parseCodexPatch(wrap('*** Update File: x', '@@', '-a', '+b', '', '*** Update File: y', '@@', '-c', '+d', ' ', '', '', '*** Update File: z', '@@', '-e', '+f', '*** End of File', '', '@@', '-g', '+h'))
    expect(parsed.ops.map(op => op.kind === 'update' ? op.chunks.map(chunk => [chunk.oldLines, chunk.blankTail ?? 0]) : [])).toEqual([
      [[['a', ''], 1]], [[['c', '', '', ''], 2]], [[['e'], 0], [['g'], 0]],
    ])
  })

  it('takes "@@ " labels verbatim apart from trailing whitespace and recognizes only unindented markers', () => {
    const parsed = parseCodexPatch(wrap('*** Update File: x', '@@     def f \t', '-a', '+b', ' *** End of File', '*** End of File \t'))
    expect(parsed.ops[0]).toMatchObject({ chunks: [{ labels: ['    def f'], oldLines: ['a', '*** End of File'], endOfFile: true }] })
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
    ['"@@" glued to a label', wrap('*** Update File: x', '@@def f():', '-a', '+b'), 'write "@@ " and the line'],
  ])('rejects %s', (_name, text, message) => {
    expect(() => parseCodexPatch(text)).toThrow(message)
  })
})
