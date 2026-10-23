import { describe, expect, it } from 'vitest'
import { applyChunks } from '../src/apply/content.js'
import { parseCodexPatch } from '../src/parse/codex.js'
import { parseUnifiedDiff } from '../src/parse/unified.js'
import type { Chunk } from '../src/parse/types.js'

const codex = (before: string, ...body: string[]) => {
  const op = parseCodexPatch(['*** Begin Patch', '*** Update File: f', ...body, '*** End Patch'].join('\n')).ops[0]
  return applyChunks('f', before, op.kind === 'update' ? op.chunks : [], 'codex')
}
const unified = (before: string, ...body: string[]) => {
  const op = parseUnifiedDiff(['--- a/f', '+++ b/f', ...body].join('\n')).ops[0]
  return applyChunks('f', before, op.kind === 'update' ? op.chunks : [], 'unified')
}

describe('applyChunks', () => {
  it('replaces lines found after the "@@" labels', () => {
    const before = 'def a():\n    pass\ndef b():\n    pass\n'
    expect(codex(before, '@@ def b():', '-    pass', '+    return 2')).toBe('def a():\n    pass\ndef b():\n    return 2\n')
  })

  it('appends a pure Codex addition at the end of the file, also after a label, as codex-rs does', () => {
    expect(codex('a\nb\nc\n', '@@ a', '+x')).toBe('a\nb\nc\nx\n')
    expect(codex('a\nb\n', '@@', '+z')).toBe('a\nb\nz\n')
    expect(codex('a\nb\n', '@@', '+z', '*** End of File')).toBe('a\nb\nz\n')
  })

  it('pins an end-of-file change to the last occurrence', () => {
    expect(codex('x\nend\nx\nend\n', '@@', '-end', '+END', '*** End of File')).toBe('x\nend\nx\nEND\n')
  })

  it('refuses a git -U0 hunk that plain git apply would move to the end of the file', () => {
    expect(() => unified('1\n2\n3\n', '@@ -2,0 +3 @@', '+X')).toThrow(/no context lines.*line 4.*line 3[\s\S]*Codex patch format/)
    expect(() => unified('1\n2\n', '@@ -0,0 +1 @@', '+X')).toThrow('cover the whole file')
    expect(unified('', '@@ -0,0 +1 @@', '+X')).toBe('X\n')
    expect(unified('1\n2\n', '@@ -2,0 +3 @@', '+X')).toBe('1\n2\nX\n')
  })

  it('takes the exact match nearest to the hunk header, also before it', () => {
    const lines = Array.from({ length: 60 }, (_, i) => `l${i + 1}`)
    lines[9] = 'dup'; lines[49] = 'dup'
    const after = unified(`${lines.join('\n')}\n`, '@@ -12,3 +12,3 @@', ' l9', '-dup', '+DUP', ' l11').split('\n')
    expect([after[9], after[49]]).toEqual(['DUP', 'dup'])
  })

  it('applies a hunk without line numbers at the first match after the previous hunk', () => {
    expect(unified('x\na\nx\nb\n', '@@ @@', '-x', '+X', '@@ @@', '-x', '+Y')).toBe('X\na\nY\nb\n')
    expect(unified('a\nb\n', '@@ @@', '+z')).toBe('a\nb\nz\n')
  })

  it('rejects a whitespace-tolerant match that fits more than one place', () => {
    expect(() => codex('  a\n b\n  a\n b\n', '@@', '-a', '-b', '+c')).toThrow('match 2 places only after ignoring whitespace')
  })

  it('accepts a unique match that differs in trailing spaces or typographic punctuation', () => {
    expect(codex('say(\u201Chi\u201D)  \nend\n', '@@', '-say("hi")', '+say("hello")')).toBe('say("hello")\nend\n')
  })

  it('handles the final newline like git', () => {
    expect(unified('a\nb\nc', '@@ -2,2 +2 @@', ' b', '-c', '\\ No newline at end of file')).toBe('a\nb\n')
    expect(unified('a\nb\n', '@@ -2 +2 @@', '-b', '+B', '\\ No newline at end of file')).toBe('a\nB')
    expect(codex('a\nb', '@@', '-b', '+B')).toBe('a\nB\n')
  })

  it('keeps each untouched line ending and gives new lines the first one of the file', () => {
    expect(codex('a\r\nb\r\nc\n', '@@', '-b', '+B')).toBe('a\r\nB\r\nc\n')
    expect(codex('a\nb\nc\r\n', '@@', '-b', '+B')).toBe('a\nB\nc\r\n')
  })

  it('applies changes in file order and reports an out-of-order change with the file excerpt', () => {
    const chunks: Chunk[] = [
      { labels: [], oldLines: ['c'], newLines: ['C'], context: [], endOfFile: false },
      { labels: [], oldLines: ['a'], newLines: ['A'], context: [], endOfFile: false },
    ]
    expect(() => applyChunks('f', 'a\nb\nc\n', chunks, 'codex')).toThrow(/change 2 of "f".*file order[\s\S]*Expected[\s\S]*"a"/)
  })

  it('retries a change without its trailing blank line', () => {
    expect(codex('a\nb\n', '@@', '-b', '+B', ' ')).toBe('a\nB\n')
  })
})
