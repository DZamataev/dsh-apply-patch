import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { harness } from './harness.js'
import type { Harness } from './harness.js'

const patch = (...body: string[]) => ['*** Begin Patch', ...body, '*** End Patch'].join('\n')

/** Realistic GPT Codex patches and the exact bytes they must leave on disk. */
const cases: { name: string; files: Record<string, string>; input: string; expected: Record<string, string | null> }[] = [
  {
    name: 'stacked @@ labels pick the second of two equal methods',
    files: { 'm.py': 'class A:\n    def f(self):\n        return 1\nclass B:\n    def f(self):\n        return 1\n' },
    input: patch('*** Update File: m.py', '@@ class B:', '@@     def f(self):', '-        return 1', '+        return 2'),
    expected: { 'm.py': 'class A:\n    def f(self):\n        return 1\nclass B:\n    def f(self):\n        return 2\n' },
  },
  {
    name: '*** End of File pins the change to the last occurrence',
    files: { 'e.txt': 'b\nmid\nb\n' },
    input: patch('*** Update File: e.txt', '@@', '-b', '+c', '*** End of File'),
    expected: { 'e.txt': 'b\nmid\nc\n' },
  },
  {
    name: 'Move to with hunks writes the patched text at the destination',
    files: { 'old/x.ts': 'export const a = 1\nexport const b = 2\n' },
    input: patch('*** Update File: old/x.ts', '*** Move to: new/y.ts', '@@', ' export const a = 1', '-export const b = 2', '+export const b = 3'),
    expected: { 'old/x.ts': null, 'new/y.ts': 'export const a = 1\nexport const b = 3\n' },
  },
  {
    name: 'an empty Add File creates an empty file',
    files: {},
    input: patch('*** Add File: empty.txt', '*** Add File: one.txt', '+one'),
    expected: { 'empty.txt': '', 'one.txt': 'one\n' },
  },
  {
    name: 'blank context lines and trailing blank lines after the last change',
    files: { 'b.txt': 'a\n\nb\n' },
    input: `${patch('*** Update File: b.txt', '@@', ' a', '', '-b', '+B', '', '')}\n\n`,
    expected: { 'b.txt': 'a\n\nB\n' },
  },
  {
    name: 'a CRLF file keeps CRLF, also on added lines',
    files: { 'w.txt': 'one\r\ntwo\r\nthree\r\n' },
    input: patch('*** Update File: w.txt', '@@', ' one', '-two', '+TWO', '+two and a half', ' three'),
    expected: { 'w.txt': 'one\r\nTWO\r\ntwo and a half\r\nthree\r\n' },
  },
  {
    name: 'an updated file ends with a newline, as with codex-rs',
    files: { 'n.txt': 'a\nb' },
    input: patch('*** Update File: n.txt', '@@', ' a', '-b', '+B'),
    expected: { 'n.txt': 'a\nB\n' },
  },
  {
    name: 'unicode text, typographic quotes matched by ASCII ones, emoji in added lines',
    files: { 'u.md': '# Заголовок\nПривет, “мир” — тест\n' },
    input: patch('*** Update File: u.md', '@@ # Заголовок', '-Привет, "мир" - тест', '+Привет, мир 🌍'),
    expected: { 'u.md': '# Заголовок\nПривет, мир 🌍\n' },
  },
  {
    name: 'two changes in one file, in file order, with a CRLF patch text',
    files: { 't.txt': '1\n2\n3\n4\n5\n6\n7\n8\n' },
    input: patch('*** Update File: t.txt', '@@', ' 1', '-2', '+two', ' 3', '@@', ' 6', '-7', '+seven', ' 8').replaceAll('\n', '\r\n'),
    expected: { 't.txt': '1\ntwo\n3\n4\n5\n6\nseven\n8\n' },
  },
]

describe('Codex patches leave exact bytes', () => {
  let h: Harness
  beforeAll(async () => { h = await harness() })
  afterAll(async () => { await h.dispose() })

  it.each(cases.map((c, i) => ({ ...c, i })))('$name', async ({ files, input, expected, i }) => {
    const root = join(h.dir, String(i))
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), text)
      await h.observe(join(root, path))
    }
    mkdirSync(root, { recursive: true })
    const rooted = input.replace(/^(\*\*\* (?:Add|Update|Delete) File: |\*\*\* Move to: )(.+?)(\r?)$/gm, (_m, head: string, path: string, cr: string) => `${head}${join(root, path)}${cr}`)
    await h.run(rooted)
    for (const [path, text] of Object.entries(expected)) {
      if (text === null) expect(existsSync(join(root, path))).toBe(false)
      else expect(readFileSync(join(root, path))).toEqual(Buffer.from(text, 'utf8'))
    }
  })
})
