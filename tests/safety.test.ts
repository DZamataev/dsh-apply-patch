import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { harness } from './harness.js'
import type { Harness } from './harness.js'

const patch = (...body: string[]) => ['*** Begin Patch', ...body, '*** End Patch'].join('\n')
const opened: Harness[] = []
const locked: string[] = []
const open = async (...args: Parameters<typeof harness>) => {
  const h = await harness(...args)
  opened.push(h)
  return h
}
/** A directory whose entries cannot be created or removed until the test ends. */
const lock = (path: string) => {
  chmodSync(path, 0o500)
  locked.push(path)
}
const read = (h: Harness, path: string) => readFileSync(join(h.dir, path), 'utf8')
const exists = (h: Harness, path: string) => existsSync(join(h.dir, path))

afterEach(async () => {
  for (const path of locked.splice(0)) chmodSync(path, 0o700)
  for (const h of opened.splice(0)) await h.dispose()
})

describe('removals are guarded like writes', () => {
  it('refuses to delete a file the session has not read, also in a dry run', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'unread'), 'secret\n')
    await expect(h.run(patch('*** Delete File: unread'), { dry_run: true })).rejects.toMatchObject({ code: 'PATCH_NOT_OBSERVED' })
    await expect(h.run(patch('*** Delete File: unread'))).rejects.toMatchObject({ code: 'PATCH_NOT_OBSERVED' })
    expect(read(h, 'unread')).toBe('secret\n')
  })

  it('refuses to delete a file changed after it was read', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'stale'), 'old\n')
    await h.observe('stale')
    await new Promise(resolve => setTimeout(resolve, 20))
    writeFileSync(join(h.dir, 'stale'), 'changed after the read\n')
    await expect(h.run(patch('*** Delete File: stale'))).rejects.toMatchObject({ code: 'PATCH_STALE' })
    expect(read(h, 'stale')).toBe('changed after the read\n')
  })

  it('keeps a file to be deleted that changes between the check and the removal', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'victim'), 'old\n')
    await h.observe('victim')
    // stat #1 checks the file while preparing, #2 and #3 surround the read of its bytes.
    h.onFs('stat', 3, () => writeFileSync(join(h.dir, 'victim'), 'external\n'))
    await expect(h.run(patch('*** Delete File: victim'))).rejects.toMatchObject({
      code: 'PATCH_STALE',
      message: expect.stringContaining('No file had been changed.'),
    })
    expect(read(h, 'victim')).toBe('external\n')
  })

  it('keeps a move source that changes before it is moved and undoes the earlier steps', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'src'), 'old\n')
    writeFileSync(join(h.dir, 'a'), 'a\n')
    await h.observe('src')
    await h.observe('a')
    h.onFs('writeText', 1, () => writeFileSync(join(h.dir, 'src'), 'external\n'))
    await expect(h.run(patch('*** Update File: a', '@@', '-a', '+A', '*** Update File: src', '*** Move to: dest', '@@', '-old', '+patched'))).rejects.toMatchObject({
      code: 'PATCH_STALE',
      message: expect.stringContaining('The 1 earlier change(s) of this patch were undone.'),
    })
    expect(read(h, 'src')).toBe('external\n')
    expect(read(h, 'a')).toBe('a\n')
    expect(exists(h, 'dest')).toBe(false)
  })

  it('treats a removal the shell reports as failed as done when the file is gone', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'gone'), 'x\n')
    await h.observe('gone')
    // Shell command 1 stages the file, 2 removes the staging directory.
    h.mapShell((result, n) => n === 1 ? { ...result, aborted: true } : result)
    await h.run(patch('*** Delete File: gone'))
    expect(exists(h, 'gone')).toBe(false)
  })

  it('reports a failed removal as not done when the file is still there', async () => {
    const h = await open()
    mkdirSync(join(h.dir, 'locked'))
    writeFileSync(join(h.dir, 'locked/f'), 'f\n')
    await h.observe('locked/f')
    lock(join(h.dir, 'locked'))
    await expect(h.run(patch('*** Delete File: locked/f'))).rejects.toMatchObject({
      code: 'PATCH_IO',
      message: expect.stringContaining('No file had been changed.'),
    })
    expect(read(h, 'locked/f')).toBe('f\n')
  })

  it('names a file whose removal outcome is unknown', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'f'), 'f\n')
    await h.observe('f')
    h.mapShell(result => ({ ...result, aborted: true }))
    // stats #1 to #3 check the file while preparing, #4 checks it before staging, #5 after the shell.
    h.onFs('stat', 5, () => { throw new Error('stat failed') }, 'before')
    const error = await h.run(patch('*** Delete File: f')).catch((e: Error) => e)
    expect(String(error)).toContain('The state of "f" is unknown')
    expect(String(error)).not.toContain('No file had been changed')
  })
})

describe('rollback', () => {
  it('requires a shell up front when a created file might have to be removed', async () => {
    const h = await open({ shell: false })
    mkdirSync(join(h.dir, 'locked'))
    await expect(h.run(patch('*** Add File: first', '+first', '*** Add File: locked/second', '+second'))).rejects.toMatchObject({ code: 'PATCH_UNSUPPORTED' })
    expect(exists(h, 'first')).toBe(false)
    await h.run(patch('*** Add File: only', '+only'))
    expect(read(h, 'only')).toBe('only\n')
  })

  it('leaves a created file in place when it was changed after the patch wrote it', async () => {
    const h = await open()
    mkdirSync(join(h.dir, 'locked'))
    lock(join(h.dir, 'locked'))
    h.onFs('writeText', 2, () => writeFileSync(join(h.dir, 'first'), 'external\n'), 'before')
    const error = await h.run(patch('*** Add File: first', '+created', '*** Add File: locked/second', '+second')).catch((e: Error) => e)
    expect(String(error)).toContain('"first" was changed after this patch wrote it; it was left as it is.')
    expect(read(h, 'first')).toBe('external\n')
  })

  it('removes created files even when the call was aborted', async () => {
    const h = await open()
    const abort = new AbortController()
    h.onFs('writeText', 2, () => abort.abort(), 'before')
    await expect(h.run(patch('*** Add File: first', '+created', '*** Add File: second', '+second'), {}, abort.signal))
      .rejects.toThrow('The 1 earlier change(s) of this patch were undone.')
    expect(exists(h, 'first')).toBe(false)
    expect(exists(h, 'second')).toBe(false)
  })

  it('keeps a move destination when the source name was taken again before the undo', async () => {
    const h = await open()
    mkdirSync(join(h.dir, 'locked'))
    writeFileSync(join(h.dir, 'locked/gone'), 'gone\n')
    writeFileSync(join(h.dir, 'source'), 'original\n')
    await h.observe('source')
    await h.observe('locked/gone')
    lock(join(h.dir, 'locked'))
    // Shell command 1 moves the source; then something creates a new file at the old name.
    h.mapShell((result, n) => {
      if (n === 1) writeFileSync(join(h.dir, 'source'), 'concurrent\n')
      return result
    })
    const error = await h.run(patch('*** Update File: source', '*** Move to: destination', '*** Delete File: locked/gone')).catch((e: Error) => e)
    expect(String(error)).toContain('"source" was created again by someone else, so the moved file is kept at "destination".')
    expect(read(h, 'destination')).toBe('original\n')
    expect(read(h, 'source')).toBe('concurrent\n')
  })

  it('restores a deleted file with its permission bits', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'tool.sh'), '#!/bin/sh\necho private\n', { mode: 0o700 })
    mkdirSync(join(h.dir, 'locked'))
    writeFileSync(join(h.dir, 'locked/f'), 'f\n')
    await h.observe('tool.sh')
    await h.observe('locked/f')
    lock(join(h.dir, 'locked'))
    await expect(h.run(patch('*** Delete File: tool.sh', '*** Delete File: locked/f'))).rejects.toThrow('The 1 earlier change(s) of this patch were undone.')
    expect(read(h, 'tool.sh')).toBe('#!/bin/sh\necho private\n')
    expect(statSync(join(h.dir, 'tool.sh')).mode & 0o777).toBe(0o700)
    // The restored file counts as read at its version after the permission change.
    await h.run(patch('*** Update File: tool.sh', '@@', '-echo private', '+echo public'))
    expect(read(h, 'tool.sh')).toBe('#!/bin/sh\necho public\n')
  })

  it.each([
    ['right after the move', 1, '"dest" changed right after "src" was moved there, or could not be checked; it was left as it is.'],
    ['before the undo', 2, '"dest" was changed after this patch moved "src" there; it was left as it is, and "src" was not put back.'],
  ])('leaves a move destination someone else rewrote %s (shell command %i), and names it', async (_when, n, message) => {
    const h = await open()
    writeFileSync(join(h.dir, 'src'), 'original\n', { mode: 0o700 })
    await h.observe('src')
    mkdirSync(join(h.dir, 'locked'))
    writeFileSync(join(h.dir, 'locked/f'), 'f\n')
    await h.observe('locked/f')
    lock(join(h.dir, 'locked'))
    // Shell command 1 moves the file, 2 tries to stage locked/f.
    h.mapShell((result, k) => {
      if (k === n) writeFileSync(join(h.dir, 'dest'), 'external work\n')
      return result
    })
    const error = await h.run(patch('*** Update File: src', '*** Move to: dest', '*** Delete File: locked/f')).catch((e: Error) => e)
    expect(String(error)).toContain(message)
    expect(read(h, 'dest')).toBe('external work\n')
    expect(exists(h, 'src')).toBe(false)
    expect(read(h, 'locked/f')).toBe('f\n')
  })

  it('records restored files as read, so the next patch need not re-read them', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'a.txt'), 'a\n')
    mkdirSync(join(h.dir, 'locked'))
    await h.observe('a.txt')
    lock(join(h.dir, 'locked'))
    await expect(h.run(patch('*** Update File: a.txt', '@@', '-a', '+A', '*** Add File: locked/n.txt', '+x'))).rejects.toThrow('were undone')
    await h.run(patch('*** Update File: a.txt', '@@', '-a', '+B'))
    expect(read(h, 'a.txt')).toBe('B\n')
  })
})

describe('symbolic links', () => {
  it('refuses to delete or move a symbolic link and keeps its target', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'actual'), 'valuable\n')
    symlinkSync('actual', join(h.dir, 'alias'))
    await h.observe('alias')
    await expect(h.run(patch('*** Delete File: alias'))).rejects.toMatchObject({ code: 'PATCH_UNSUPPORTED', message: expect.stringContaining('symbolic link') })
    await expect(h.run(patch('*** Update File: alias', '*** Move to: moved', '@@', '-valuable', '+v'))).rejects.toMatchObject({ code: 'PATCH_UNSUPPORTED' })
    expect(read(h, 'actual')).toBe('valuable\n')
    expect(lstatSync(join(h.dir, 'alias')).isSymbolicLink()).toBe(true)
    expect(exists(h, 'moved')).toBe(false)
  })

  it('deletes a file reached through a symlinked directory and keeps the link', async () => {
    const h = await open()
    mkdirSync(join(h.dir, 'real'))
    writeFileSync(join(h.dir, 'real/f'), 'f\n')
    symlinkSync('real', join(h.dir, 'linked'))
    await h.observe('linked/f')
    await h.run(patch('*** Delete File: linked/f'))
    expect(exists(h, 'real/f')).toBe(false)
    expect(lstatSync(join(h.dir, 'linked')).isSymbolicLink()).toBe(true)
  })

  it('updates the target of a symbolic link and keeps the link', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'actual'), 'a\n')
    symlinkSync('actual', join(h.dir, 'alias'))
    await h.observe('alias')
    await h.run(patch('*** Update File: alias', '@@', '-a', '+A'))
    expect(read(h, 'actual')).toBe('A\n')
    expect(lstatSync(join(h.dir, 'alias')).isSymbolicLink()).toBe(true)
  })

  it('refuses to add a file over a dangling symbolic link', async () => {
    const h = await open()
    symlinkSync('missing', join(h.dir, 'dangling'))
    await expect(h.run(patch('*** Add File: dangling', '+x'))).rejects.toThrow('already exists')
    expect(exists(h, 'missing')).toBe(false)
  })
})

describe('fs sandbox in workspace-write mode', () => {
  // Outside the temp directories, which workspace-write also allows.
  const outside = () => {
    const dir = mkdtempSync(join(import.meta.dirname, '.outside-'))
    opened.push({ dispose: async () => rmSync(dir, { recursive: true, force: true }) } as Harness)
    return dir
  }

  it('denies a write outside the workspace with the sandbox marker', async () => {
    const h = await open({ sandbox: 'workspace-write' })
    const dir = outside()
    await expect(h.run(patch(`*** Add File: ${join(dir, 'n.txt')}`, '+n'))).rejects.toMatchObject({
      code: 'PATCH_SANDBOX',
      message: expect.stringContaining('[sandbox: file access denied under workspace-write mode]'),
    })
    expect(existsSync(join(dir, 'n.txt'))).toBe(false)
  })

  it('refuses every write target outside the workspace up front, also in a dry run', async () => {
    const h = await open({ sandbox: 'workspace-write' })
    const dir = outside()
    writeFileSync(join(h.dir, 'a.txt'), 'a\n')
    await h.observe('a.txt')
    writeFileSync(join(dir, 'o.txt'), 'o\n')
    await h.observe(join(dir, 'o.txt'))
    const cases = [
      patch('*** Update File: a.txt', '@@', '-a', '+A', '*** Add File: inside.txt', '+i', `*** Add File: ${join(dir, 'n.txt')}`, '+n'),
      patch('*** Update File: a.txt', '@@', '-a', '+A', `*** Update File: ${join(dir, 'o.txt')}`, '@@', '-o', '+O'),
      patch(`*** Update File: a.txt`, `*** Move to: ${join(dir, 'moved.txt')}`, '@@', '-a', '+A'),
    ]
    for (const body of cases) {
      for (const extra of [{ dry_run: true }, {}]) {
        await expect(h.run(body, extra)).rejects.toMatchObject({
          code: 'PATCH_SANDBOX',
          message: expect.stringMatching(/^\[sandbox: file access denied under workspace-write mode\] Cannot [^\n]* outside the workspace /),
        })
      }
    }
    expect(read(h, 'a.txt')).toBe('a\n')
    expect(readFileSync(join(dir, 'o.txt'), 'utf8')).toBe('o\n')
    expect(exists(h, 'inside.txt')).toBe(false)
    expect(existsSync(join(dir, 'n.txt'))).toBe(false)
    expect(existsSync(join(dir, 'moved.txt'))).toBe(false)
  })

  it('allows writes in the temp directories under workspace-write', async () => {
    const h = await open({ sandbox: 'workspace-write' })
    const dir = mkdtempSync(join('/tmp', 'dsh-apply-patch-tmp-'))
    opened.push({ dispose: async () => rmSync(dir, { recursive: true, force: true }) } as Harness)
    await h.run(patch(`*** Add File: ${join(dir, 'n.txt')}`, '+n'), { dry_run: true })
    await h.run(patch(`*** Add File: ${join(dir, 'n.txt')}`, '+n'))
    expect(readFileSync(join(dir, 'n.txt'), 'utf8')).toBe('n\n')
  })

  it('denies removing a file outside the workspace before changing anything', async () => {
    const h = await open({ sandbox: 'workspace-write' })
    const dir = outside()
    writeFileSync(join(dir, 'keep'), 'keep\n')
    await h.observe(join(dir, 'keep'))
    await expect(h.run(patch('*** Add File: n.txt', '+n', `*** Delete File: ${join(dir, 'keep')}`), { dry_run: true })).rejects.toMatchObject({
      code: 'PATCH_SANDBOX',
      message: expect.stringContaining('[sandbox: file access denied under workspace-write mode]'),
    })
    await expect(h.run(patch('*** Add File: n.txt', '+n', `*** Delete File: ${join(dir, 'keep')}`))).rejects.toMatchObject({ code: 'PATCH_SANDBOX' })
    expect(readFileSync(join(dir, 'keep'), 'utf8')).toBe('keep\n')
    expect(exists(h, 'n.txt')).toBe(false)
  })

  it('applies a patch inside the workspace', async () => {
    const h = await open({ sandbox: 'workspace-write' })
    writeFileSync(join(h.dir, 'a.txt'), 'a\n')
    await h.observe('a.txt')
    await h.run(patch('*** Update File: a.txt', '*** Move to: b.txt', '@@', '-a', '+B', '*** Add File: c.txt', '+c'))
    expect(read(h, 'b.txt')).toBe('B\n')
    expect(exists(h, 'a.txt')).toBe(false)
    expect(read(h, 'c.txt')).toBe('c\n')
  })
})
