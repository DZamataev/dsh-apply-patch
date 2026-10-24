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
      chunks: [{ labels: [], oldLines: ['b', 'c'], newLines: ['b', 'C'], context: [[0, 0]], endOfFile: false, oldStart: 2, oldCount: 2, newStart: 2, newCount: 2, oldUnterminated: [1], newUnterminated: [1] }],
    }])
  })

  it('tolerates overstated counts, "@@ @@" headers, trailing blank lines and a fence with prose', () => {
    const parsed = parseUnifiedDiff(['Here is the fix:', '- a bullet, not a change', '```diff', '--- a/x', '+++ b/x', '@@ -1,5 +1,5 @@', ' keep', '-a', '+b', '', '@@ -9 +9 @@', '-e', '+f', '```', 'Then:', '--- y', '+++ y', '@@ @@', '-c', '+d', ''].join('\n'))
    expect(parsed.ops.map(op => op.kind === 'update' ? [op.path, op.chunks.map(chunk => chunk.oldLines)] : [])).toEqual([['x', [['keep', 'a'], ['e']]], ['y', [['c']]]])
    expect(detectFormat('```diff\n--- a/x\n+++ b/x\n')).toBe('unified')
  })

  it('keeps "--- x"/"+++ y" hunk lines in their hunk and later hunks in their file', () => {
    const parsed = parseUnifiedDiff([
      'diff --git a/f b/f', '--- a/f', '+++ b/f', '@@ -1,5 +1,5 @@', ' keep', '--- foo', '+++ bar', ' 1', ' 2', ' 3',
      '@@ -8,5 +8,5 @@ keep', ' 6', ' 7', ' 8', '-old2', '+new2', ' end', '',
    ].join('\n'))
    expect(parsed.ops).toHaveLength(1)
    expect(parsed.ops[0]).toMatchObject({ kind: 'update', path: 'f', chunks: [{ oldLines: ['keep', '-- foo', '1', '2', '3'], newLines: ['keep', '++ bar', '1', '2', '3'] }, { oldStart: 8 }] })
  })

  it('rejects a hunk whose counts do not match its lines when it swallowed a file header', () => {
    expect(() => parseUnifiedDiff(['--- a/f', '+++ b/f', '@@ -1,9 +1,9 @@', '-a', '+b', '--- a/g', '+++ b/g', '@@ -1 +1 @@', '-c', '+d'].join('\n')))
      .toThrow(/line 3: .*counts/)
  })

  it('carries the hunks of a deletion so they can be checked against the file', () => {
    const parsed = parseUnifiedDiff(['--- a/f', '+++ /dev/null', '@@ -1 +0,0 @@', '-first'].join('\n'))
    expect(parsed.ops).toMatchObject([{ kind: 'delete', path: 'f', chunks: [{ oldLines: ['first'], newLines: [] }] }])
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

  it.each([
    ['context lines', '--- /dev/null\n+++ b/f\n@@ -1,2 +1,3 @@\n a\n b\n+c\n'],
    ['a line removed and added again', '--- /dev/null\n+++ b/f\n@@ -1 +1 @@\n-a\n+a\n'],
    ['context lines after "new file mode"', 'diff --git a/f b/f\nnew file mode 100644\n--- /dev/null\n+++ b/f\n@@ -1 +1,2 @@\n a\n+b\n'],
  ])('rejects a new file whose hunk has %s, as git does', (_name, diff) => {
    expect(() => parseUnifiedDiff(diff)).toThrow('every line of a new file starts with "+"')
  })

  it('patches the "+++" file of a bare diff with differing names instead of renaming', () => {
    const parsed = parseUnifiedDiff(['--- foo.c.orig\t2024-01-01 10:00:00', '+++ foo.c\t2024-01-02 10:00:00', '@@ -1 +1 @@', '-a', '+b'].join('\n'))
    expect(parsed.ops).toMatchObject([{ kind: 'update', path: 'foo.c' }])
    expect(parsed.ops[0]).not.toHaveProperty('moveTo')
  })

  it('decodes quoted paths with octal UTF-8 escapes', () => {
    expect(unquote('"a/caf\\303\\251 x.txt"')).toBe('a/café x.txt')
    expect(unquote('"a/\u{1F4A5}\\t.txt"')).toBe('a/\u{1F4A5}\t.txt')
    const parsed = parseUnifiedDiff(['--- "a/caf\\303\\251"', '+++ "b/caf\\303\\251"', '@@ -1 +1 @@', '-a', '+b'].join('\n'))
    expect(parsed.ops[0].path).toBe('café')
  })

  it('ties a newline marker to the line it follows', () => {
    const parsed = parseUnifiedDiff(['--- a/f', '+++ b/f', '@@ -1,2 +1,3 @@', ' a', '\\ No newline at end of file', '-b', '+x', '\\ No newline at end of file', '+y'].join('\n'))
    expect(parsed.ops[0]).toMatchObject({ chunks: [{ oldUnterminated: [0], newUnterminated: [0, 1] }] })
  })

  // Real `git diff` output: git ends a header path with a TAB when the path ends with a space.
  it.each([
    ['a trailing space', 'diff --git a/f  b/f \nindex 3367afd..3e75765 100644\n--- a/f \t\n+++ b/f \t\n@@ -1 +1 @@\n-old\n+new\n', 'f '],
    ['two trailing spaces', 'diff --git a/f   b/f  \nindex 3367afd..3e75765 100644\n--- a/f  \t\n+++ b/f  \t\n@@ -1 +1 @@\n-old\n+new\n', 'f  '],
    ['a leading space', 'diff --git a/ f b/ f\nindex 3367afd..3e75765 100644\n--- a/ f\t\n+++ b/ f\t\n@@ -1 +1 @@\n-old\n+new\n', ' f'],
    ['a quoted tab', 'diff --git "a/f\\t" "b/f\\t"\nindex 3367afd..3e75765 100644\n--- "a/f\\t"\n+++ "b/f\\t"\n@@ -1 +1 @@\n-old\n+new\n', 'f\t'],
  ])('keeps the exact header path with %s', (_name, diff, path) => {
    expect(parseUnifiedDiff(diff).ops).toMatchObject([{ kind: 'update', path }])
  })

  it.each([
    ['a leading space and a trailing space', 'diff --git a/ f b/g \nsimilarity index 100%\nrename from  f\nrename to g \n', ' f', 'g '],
    ['a trailing space in the source', 'diff --git a/f  b/g\nsimilarity index 100%\nrename from f \nrename to g\n', 'f ', 'g'],
    ['a space in a directory', 'diff --git a/y/b z b/q \nsimilarity index 100%\nrename from y/b z\nrename to q \n', 'y/b z', 'q '],
  ])('keeps the exact rename paths with %s', (_name, diff, path, moveTo) => {
    expect(parseUnifiedDiff(diff).ops).toEqual([{ kind: 'update', path, moveTo, chunks: [] }])
  })

  it('splits a "diff --git" line at the space where both names agree', () => {
    const parsed = parseUnifiedDiff('diff --git a/p b/x b b/p b/x b\nnew file mode 100644\nindex 0000000..e69de29\n')
    expect(parsed.ops).toEqual([{ kind: 'add', path: 'p b/x b', content: '' }])
  })

  it.each([
    ['copy headers', 'diff --git a/a b/b\ncopy from a\ncopy to b', 'copy headers are not supported'],
    ['binary patches', 'diff --git a/a b/a\nBinary files a/a and b/a differ', 'binary patches'],
    ['text without changes', 'just prose', 'no file changes'],
  ])('rejects %s', (_name, text, message) => {
    expect(() => parseUnifiedDiff(text)).toThrow(message)
  })
})

describe('detectFormat', () => {
  it('reads a unified diff whose context contains "*** Begin Patch" as a unified diff', () => {
    const diff = ['diff --git a/f b/f', '--- a/f', '+++ b/f', '@@ -1,3 +1,3 @@', ' *** Begin Patch', '-old', '+new', ' *** End Patch', ''].join('\n')
    expect(detectFormat(diff)).toBe('unified')
    expect(parseUnifiedDiff(diff).ops).toMatchObject([{ kind: 'update', path: 'f' }])
  })
})
