import { describe, expect, it } from 'vitest'
import { parseUnifiedDiff, unquote } from '../src/parse/unified.js'
import { detectFormat } from '../src/detect.js'

describe('parseUnifiedDiff', () => {
  it('parses a git diff with hints and newline markers', () => {
    const parsed = parseUnifiedDiff([
      'diff --git a/f.txt b/f.txt', 'index 1..2 100644', '--- a/f.txt', '+++ b/f.txt',
      '@@ -2,2 +2,2 @@ ctx', ' b', '-c', '\\ No newline at end of file', '+C', '\\ No newline at end of file',
    ].join('\n'))
    expect(parsed.ops).toEqual([{
      kind: 'update', path: 'f.txt',
      chunks: [{ labels: [], oldLines: ['b', 'c'], newLines: ['b', 'C'], endOfFile: false, oldStart: 2, oldCount: 2, oldNoNewline: true, newNoNewline: true }],
    }])
  })

  it('tolerates wrong counts, "@@ @@" headers, trailing blank lines and a fence with prose', () => {
    const parsed = parseUnifiedDiff(['Here is the fix:', '```diff', '--- a/x', '+++ b/x', '@@ -1 +1 @@', ' keep', '-a', '+b', '', '```', '--- y', '+++ y', '@@ @@', '-c', '+d', ''].join('\n'))
    expect(parsed.ops.map(op => op.kind === 'update' ? [op.path, op.chunks[0].oldLines] : [])).toEqual([['x', ['keep', 'a']], ['y', ['c']]])
    expect(detectFormat('```diff\n--- a/x\n+++ b/x\n')).toBe('unified')
  })

  it('reads new, deleted and renamed files, including empty ones without hunks', () => {
    const parsed = parseUnifiedDiff([
      'diff --git a/new.txt b/new.txt', 'new file mode 100644', '--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1,2 @@', '+a', '+b',
      'diff --git a/e b/e', 'new file mode 100644', 'index 0000000..e69de29',
      'diff --git a/old.txt b/old.txt', 'deleted file mode 100644', '--- a/old.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-x',
      'diff --git a/m.txt b/n.txt', 'similarity index 90%', 'rename from m.txt', 'rename to n.txt', '--- a/m.txt', '+++ b/n.txt', '@@ -1 +1 @@', '-p', '+q',
    ].join('\n'))
    expect(parsed.ops.map(op => [op.kind, op.path, op.kind === 'update' ? op.moveTo : op.kind === 'add' ? op.content : undefined]))
      .toEqual([['add', 'new.txt', 'a\nb\n'], ['add', 'e', ''], ['delete', 'old.txt', undefined], ['update', 'm.txt', 'n.txt']])
  })

  it('patches the "+++" file of a bare diff with differing names instead of renaming', () => {
    const parsed = parseUnifiedDiff(['--- foo.c.orig\t2024-01-01 10:00:00', '+++ foo.c\t2024-01-02 10:00:00', '@@ -1 +1 @@', '-a', '+b'].join('\n'))
    expect(parsed.ops).toMatchObject([{ kind: 'update', path: 'foo.c' }])
    expect(parsed.ops[0]).not.toHaveProperty('moveTo')
  })

  it('decodes quoted paths with octal UTF-8 escapes', () => {
    expect(unquote('"a/caf\\303\\251 x.txt"')).toBe('a/café x.txt')
    const parsed = parseUnifiedDiff(['--- "a/caf\\303\\251"', '+++ "b/caf\\303\\251"', '@@ -1 +1 @@', '-a', '+b'].join('\n'))
    expect(parsed.ops[0].path).toBe('café')
  })

  it.each([
    ['copy headers', 'diff --git a/a b/b\ncopy from a\ncopy to b', 'copy headers are not supported'],
    ['binary patches', 'diff --git a/a b/a\nBinary files a/a and b/a differ', 'binary patches'],
    ['text without changes', 'just prose', 'no file changes'],
  ])('rejects %s', (_name, text, message) => {
    expect(() => parseUnifiedDiff(text)).toThrow(message)
  })
})
