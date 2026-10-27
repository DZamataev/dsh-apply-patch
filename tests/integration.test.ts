import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { harness } from './harness.js'
import type { Harness } from './harness.js'

const patch = (...body: string[]) => ['*** Begin Patch', ...body, '*** End Patch'].join('\n')
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

describe('apply_patch on real DSH services', () => {
  it('updates a read file, adds a file with new parent directories and reports one display hunk per change', async () => {
    const h = await open()
    const big = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n') + '\n'
    writeFileSync(join(h.dir, 'big.txt'), big)
    await h.observe('big.txt')
    const result = await h.run(patch(
      '*** Update File: big.txt', '@@', ' line 199', '-line 200', '+LINE 200', ' line 201',
      '*** Add File: deep/new/dir/n.txt', '+hello',
    )) as { summary: string; diffs: { path: string; oldText: string | null; newText: string }[] }
    expect(readFileSync(join(h.dir, 'big.txt'), 'utf8')).toBe(big.replace('line 200\n', 'LINE 200\n'))
    expect(readFileSync(join(h.dir, 'deep/new/dir/n.txt'), 'utf8')).toBe('hello\n')
    expect(result.summary).toBe('Applied patch: 1 added, 1 modified, 0 deleted.')
    expect(result.diffs[0].oldText).toBe('line 197\nline 198\nline 199\nline 200\nline 201\nline 202\nline 203')
    expect(result.diffs[0].path).toBe(join(h.dir, 'big.txt'))
    expect(result.diffs[1]).toEqual({ path: join(h.dir, 'deep/new/dir/n.txt'), oldText: null, newText: 'hello' })
  })

  it('refuses an unread file before writing anything, also in a dry run', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'a.txt'), 'a\n')
    const body = patch('*** Add File: b.txt', '+b', '*** Update File: a.txt', '@@', '-a', '+A')
    await expect(h.run(body, { dry_run: true })).rejects.toMatchObject({ code: 'PATCH_NOT_OBSERVED', message: expect.stringContaining('Read "a.txt" with the read tool') })
    await expect(h.run(body)).rejects.toMatchObject({ code: 'PATCH_NOT_OBSERVED' })
    expect(existsSync(join(h.dir, 'b.txt'))).toBe(false)
  })

  it('refuses a file changed after it was read', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'a.txt'), 'a\n')
    await h.observe('a.txt')
    await new Promise(resolve => setTimeout(resolve, 20))
    writeFileSync(join(h.dir, 'a.txt'), 'a\nformatted\n')
    await expect(h.run(patch('*** Update File: a.txt', '@@', '-a', '+A'))).rejects.toMatchObject({ code: 'PATCH_STALE' })
  })

  it('undoes earlier writes when a later write fails', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'a.txt'), 'a\n')
    mkdirSync(join(h.dir, 'locked'))
    await h.observe('a.txt')
    chmodSync(join(h.dir, 'locked'), 0o500)
    try {
      await expect(h.run(patch('*** Update File: a.txt', '@@', '-a', '+A', '*** Add File: locked/n.txt', '+x')))
        .rejects.toThrow('The 1 earlier change(s) of this patch were undone.')
    } finally {
      chmodSync(join(h.dir, 'locked'), 0o700)
    }
    expect(readFileSync(join(h.dir, 'a.txt'), 'utf8')).toBe('a\n')
  })

  it('moves and deletes files and records the new state for the read-before-write policy', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'm.txt'), 'm\n')
    writeFileSync(join(h.dir, 'gone.bin'), Buffer.from([0, 255, 0]))
    await h.observe('m.txt')
    await h.observe('gone.bin')
    await h.run(patch('*** Update File: m.txt', '*** Move to: sub/n.txt', '@@', '-m', '+M', '*** Delete File: gone.bin'))
    expect(readFileSync(join(h.dir, 'sub/n.txt'), 'utf8')).toBe('M\n')
    expect(existsSync(join(h.dir, 'm.txt'))).toBe(false)
    expect(existsSync(join(h.dir, 'gone.bin'))).toBe(false)
    // The patch's own writes count as observations: the moved file can be patched again, the old path re-added.
    await h.run(patch('*** Update File: sub/n.txt', '@@', '-M', '+MM', '*** Add File: m.txt', '+again'))
    expect(readFileSync(join(h.dir, 'sub/n.txt'), 'utf8')).toBe('MM\n')
    expect(readFileSync(join(h.dir, 'm.txt'), 'utf8')).toBe('again\n')
  })

  it('refuses a unified diff that changes a mode before writing anything, also in a dry run', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'f'), 'a\n')
    writeFileSync(join(h.dir, 'run.sh'), 'echo\n', { mode: 0o644 })
    await h.observe('f')
    await h.observe('run.sh')
    const body = ['diff --git a/f b/f', '--- a/f', '+++ b/f', '@@ -1 +1 @@', '-a', '+A', 'diff --git a/run.sh b/run.sh', 'old mode 100644', 'new mode 100755', ''].join('\n')
    for (const extra of [{ dry_run: true }, {}]) {
      await expect(h.run(body, extra)).rejects.toMatchObject({ code: 'PATCH_UNSUPPORTED', message: expect.stringContaining('Change the mode with the shell') })
    }
    expect(readFileSync(join(h.dir, 'f'), 'utf8')).toBe('a\n')
    expect(statSync(join(h.dir, 'run.sh')).mode & 0o777).toBe(0o644)
  })

  it('deletes a file with a unified diff only when its hunks remove the whole file', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'f'), 'first\nsecond\n')
    writeFileSync(join(h.dir, 'g'), 'not empty\n')
    await h.observe('f')
    await h.observe('g')
    await expect(h.run(['--- a/f', '+++ /dev/null', '@@ -1 +0,0 @@', '-first', ''].join('\n'))).rejects.toMatchObject({ code: 'PATCH_CONFLICT', message: expect.stringContaining('whole file') })
    await expect(h.run(['diff --git a/g b/g', 'deleted file mode 100644', 'index 1234567..0000000', ''].join('\n'))).rejects.toMatchObject({ code: 'PATCH_CONFLICT' })
    expect(readFileSync(join(h.dir, 'f'), 'utf8')).toBe('first\nsecond\n')
    await h.run(['--- a/f', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-first', '-second', ''].join('\n'))
    expect(existsSync(join(h.dir, 'f'))).toBe(false)
  })

  it('patches files with hundreds of thousands of lines in both formats', async () => {
    const h = await open()
    const rest = 'x\n'.repeat(250_000)
    writeFileSync(join(h.dir, 'f'), `old\n${rest}`)
    await h.observe('f')
    await h.run(patch('*** Update File: f', '@@', '-old', '+new'))
    expect(readFileSync(join(h.dir, 'f'), 'utf8')).toBe(`new\n${rest}`)
    const added = 'y\n'.repeat(170_000)
    const diff = `diff --git a/g b/g\nnew file mode 100644\n--- /dev/null\n+++ b/g\n@@ -0,0 +1,170000 @@\n${'+y\n'.repeat(170_000)}`
    expect(Buffer.byteLength(diff)).toBeLessThan(524_288)
    await h.run(diff)
    expect(readFileSync(join(h.dir, 'g'), 'utf8')).toBe(added)
  })

  it('moves a file without changes byte for byte and keeps its permission bits', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'mixed'), 'one\r\ntwo\nthree', { mode: 0o700 })
    writeFileSync(join(h.dir, 'script'), 'echo a\n', { mode: 0o750 })
    await h.observe('mixed')
    await h.observe('script')
    const result = await h.run(patch('*** Update File: mixed', '*** Move to: moved', '*** Update File: script', '*** Move to: bin/script', '@@', '-echo a', '+echo b')) as { summary: string }
    expect(readFileSync(join(h.dir, 'moved'), 'utf8')).toBe('one\r\ntwo\nthree')
    expect(statSync(join(h.dir, 'moved')).mode & 0o777).toBe(0o700)
    expect(statSync(join(h.dir, 'bin/script')).mode & 0o777).toBe(0o750)
    expect(result.summary).toBe('Applied patch: 0 added, 2 modified, 0 deleted.')
    // The moved file counts as read at its new place.
    await h.run(patch('*** Update File: bin/script', '@@', '-echo b', '+echo c'))
    expect(readFileSync(join(h.dir, 'bin/script'), 'utf8')).toBe('echo c\n')
  })

  it('rejects conflicts: existing add target, missing update target, existing move target, the same file twice', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'a.txt'), 'a\n')
    writeFileSync(join(h.dir, 'b.txt'), 'b\n')
    await h.observe('a.txt')
    await expect(h.run(patch('*** Add File: a.txt', '+x'))).rejects.toThrow('Cannot add "a.txt": it already exists')
    await expect(h.run(patch('*** Update File: nope.txt', '@@', '-x', '+y'))).rejects.toThrow('Cannot update "nope.txt": the file does not exist')
    await expect(h.run(patch('*** Update File: a.txt', '*** Move to: b.txt', '@@', '-a', '+A'))).rejects.toThrow('the destination already exists')
    await expect(h.run(patch('*** Update File: a.txt', '@@', '-a', '+A', '*** Update File: ./a.txt', '@@', '-a', '+B'))).rejects.toThrow('are the same file')
  })

  it('reports Delete File without a shell before writing anything', async () => {
    const h = await open({ shell: false })
    writeFileSync(join(h.dir, 'a.txt'), 'a\n')
    await expect(h.run(patch('*** Add File: n.txt', '+n', '*** Delete File: a.txt'))).rejects.toMatchObject({ code: 'PATCH_UNSUPPORTED' })
    expect(existsSync(join(h.dir, 'n.txt'))).toBe(false)
  })

  it('refuses every change in a read-only sandbox mode', async () => {
    const h = await open({
      extra: async ctx => {
        ctx.provide('sandboxPolicy')
        ctx.set('sandboxPolicy', { resolve: () => ({ mode: 'read-only', workspaceRoot: '/' }) })
      },
    })
    await expect(h.run(patch('*** Add File: n.txt', '+n'))).rejects.toMatchObject({ code: 'PATCH_SANDBOX', message: expect.stringContaining('[sandbox: file access denied under read-only mode]') })
  })

  it('puts the failure code on the tool result', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'a.txt'), 'a\n')
    const result = await h.execute(patch('*** Update File: a.txt', '@@', '-a', '+A'))
    expect(result).toMatchObject({ isError: true, error: { info: { name: 'PatchError', code: 'PATCH_NOT_OBSERVED' } } })
  })

  it('accepts a git diff when enabled and refuses it when disabled', async () => {
    const h = await open({ config: { allowUnifiedDiff: false } })
    await expect(h.run('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')).rejects.toMatchObject({ code: 'PATCH_UNSUPPORTED' })
    const g = await open()
    writeFileSync(join(g.dir, 'x'), 'a\n')
    await g.observe('x')
    await g.run('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n')
    expect(readFileSync(join(g.dir, 'x'), 'utf8')).toBe('b\n')
  })

  it('removes the tool when the plugin is disposed', async () => {
    const h = await open()
    expect(h.ctx.tools.get('apply_patch')?.parameters).toMatchObject({ properties: { input: { type: 'string' } } })
    await h.disposePlugin()
    expect(h.ctx.tools.get('apply_patch')).toBeUndefined()
  })
})
