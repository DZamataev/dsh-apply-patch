import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { harness } from './harness.js'
import type { Harness } from './harness.js'

const patch = (...body: string[]) => ['*** Begin Patch', ...body, '*** End Patch'].join('\n')
const BOM = '\uFEFF'
const opened: Harness[] = []
const locked: string[] = []
const open = async () => {
  const h = await harness()
  opened.push(h)
  return h
}
/** A directory whose entries cannot be created or removed until the test ends, so a step inside it fails. */
const failing = (h: Harness) => {
  const dir = join(h.dir, 'locked')
  mkdirSync(dir)
  chmodSync(dir, 0o500)
  locked.push(dir)
  return 'locked/f'
}
const bytes = (h: Harness, path: string) => readFileSync(join(h.dir, path))

afterEach(async () => {
  for (const path of locked.splice(0)) chmodSync(path, 0o700)
  for (const h of opened.splice(0)) await h.dispose()
})

describe('a UTF-8 byte order mark', () => {
  it('is kept by an update that does not touch the first line', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'f'), `${BOM}first\nold\n`)
    await h.observe('f')
    await h.run(patch('*** Update File: f', '@@', '-old', '+new'))
    expect(bytes(h, 'f')).toEqual(Buffer.from(`${BOM}first\nnew\n`))
  })

  it('is kept by an update of the first line written without it (codex-rs counts it as part of the line and would not match)', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'f'), `${BOM}first\nold\n`)
    await h.observe('f')
    await h.run(patch('*** Update File: f', '@@', '-first', '+changed'))
    expect(bytes(h, 'f')).toEqual(Buffer.from(`${BOM}changed\nold\n`))
  })

  it('belongs to the first line when matching, as in codex-rs', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'f'), `${BOM}first\nold\nfirst\nold\n`)
    await h.observe('f')
    await h.run(patch('*** Update File: f', '@@ first', '-old', '+new'))
    expect(bytes(h, 'f')).toEqual(Buffer.from(`${BOM}first\nold\nfirst\nnew\n`))
  })

  it('belongs to the first line of a git diff, as in git apply', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'f'), `${BOM}first\nold\n`)
    await h.observe('f')
    await h.run(`diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n-${BOM}first\n+${BOM}changed\n old\n`)
    expect(bytes(h, 'f')).toEqual(Buffer.from(`${BOM}changed\nold\n`))
  })

  it('is restored with the text when a later step fails', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'f'), `${BOM}first\nold\n`)
    await h.observe('f')
    await expect(h.run(patch('*** Update File: f', '@@', '-old', '+new', `*** Add File: ${failing(h)}`, '+x'))).rejects.toThrow('were undone')
    expect(bytes(h, 'f')).toEqual(Buffer.from(`${BOM}first\nold\n`))
  })
})

const mode = (h: Harness, path: string) => statSync(join(h.dir, path)).mode & 0o7777
const inode = (h: Harness, path: string) => statSync(join(h.dir, path)).ino
/** Entries of `dir` (relative to the harness root) left by staging. */
const staged = (h: Harness, dir = '.') => readdirSync(join(h.dir, dir)).filter(name => name.startsWith('.dsh-apply-patch-trash-'))
/** Replace the shell's `ln` with `script`, a POSIX sh body run before or instead of the real one. */
const fakeLn = (h: Harness, script: string) => {
  mkdirSync(join(h.dir, 'bin'))
  writeFileSync(join(h.dir, 'bin/ln'), `#!/bin/sh\n${script}\n`, { mode: 0o700 })
  const shell = h.ctx.get('shell') as { execute(spec: { env?: Record<string, string> }): Promise<unknown> }
  const execute = shell.execute.bind(shell)
  shell.execute = spec => execute({ ...spec, env: { ...spec.env, PATH: `${join(h.dir, 'bin')}:${process.env.PATH ?? ''}` } })
}
/** setuid, sticky, both; setgid is left out because a non-member of the directory's group cannot set it. */
const SPECIAL = ['4755', '1755', '5755']
/** Set an octal mode and check that the file system kept it. */
const setMode = (h: Harness, path: string, octal: string) => {
  chmodSync(join(h.dir, path), Number.parseInt(octal, 8))
  expect(mode(h, path).toString(8)).toBe(octal)
}

describe('Move to', () => {
  it.each(SPECIAL)('keeps the file itself: inode, bytes, mode %s', async bits => {
    const h = await open()
    writeFileSync(join(h.dir, 'src'), `${BOM}one\r\ntwo`)
    setMode(h, 'src', bits)
    const ino = inode(h, 'src')
    await h.observe('src')
    await h.run(patch('*** Update File: src', '*** Move to: deep/dest'))
    expect(existsSync(join(h.dir, 'src'))).toBe(false)
    expect(bytes(h, 'deep/dest')).toEqual(Buffer.from(`${BOM}one\r\ntwo`))
    expect(mode(h, 'deep/dest').toString(8)).toBe(bits)
    expect(inode(h, 'deep/dest')).toBe(ino)
  })

  it.each(SPECIAL)('is undone by moving the same file back, mode %s', async bits => {
    const h = await open()
    writeFileSync(join(h.dir, 'src'), `${BOM}text\n`)
    setMode(h, 'src', bits)
    const ino = inode(h, 'src')
    writeFileSync(join(h.dir, 'other'), 'other\n')
    await h.observe('src')
    await h.observe('other')
    mkdirSync(join(h.dir, 'locked'))
    writeFileSync(join(h.dir, 'locked/f'), 'f\n')
    await h.observe('locked/f')
    chmodSync(join(h.dir, 'locked'), 0o500)
    locked.push(join(h.dir, 'locked'))
    await expect(h.run(patch('*** Update File: src', '*** Move to: dest', '*** Delete File: other', '*** Delete File: locked/f'))).rejects.toThrow('The 2 earlier change(s) of this patch were undone.')
    expect(bytes(h, 'src')).toEqual(Buffer.from(`${BOM}text\n`))
    expect(mode(h, 'src').toString(8)).toBe(bits)
    expect(inode(h, 'src')).toBe(ino)
    expect(existsSync(join(h.dir, 'dest'))).toBe(false)
    expect(bytes(h, 'other')).toEqual(Buffer.from('other\n'))
    expect(staged(h)).toEqual([])
    // With changes the text is written, and undone, through ctx.fs, which keeps only the 0777 bits.
    await expect(h.run(patch('*** Update File: src', '*** Move to: dest', '@@', '-text', '+changed', '*** Delete File: locked/f'))).rejects.toThrow('were undone')
    expect(bytes(h, 'src')).toEqual(Buffer.from(`${BOM}text\n`))
    expect(mode(h, 'src')).toBe(0o755)
    expect(existsSync(join(h.dir, 'dest'))).toBe(false)
  })

  it('changes nothing when the old name cannot be removed', async () => {
    const h = await open()
    mkdirSync(join(h.dir, 'locked'))
    writeFileSync(join(h.dir, 'locked/src'), 'x\n')
    await h.observe('locked/src')
    chmodSync(join(h.dir, 'locked'), 0o500)
    locked.push(join(h.dir, 'locked'))
    await expect(h.run(patch('*** Update File: locked/src', '*** Move to: dest'))).rejects.toMatchObject({ code: 'PATCH_IO', message: expect.stringContaining('No file had been changed.') })
    expect(bytes(h, 'locked/src')).toEqual(Buffer.from('x\n'))
    expect(existsSync(join(h.dir, 'dest'))).toBe(false)
  })

  it('never replaces a destination created after the check', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'src'), 'mine\n')
    await h.observe('src')
    fakeLn(h, `printf 'theirs\\n' > "$3"; exec /bin/ln "$@"`)
    await expect(h.run(patch('*** Update File: src', '*** Move to: dest'))).rejects.toMatchObject({ code: 'PATCH_IO' })
    expect(bytes(h, 'dest')).toEqual(Buffer.from('theirs\n'))
    expect(bytes(h, 'src')).toEqual(Buffer.from('mine\n'))
  })
})

describe('Delete File', () => {
  it.each(SPECIAL)('is undone with the same file, also binary, mode %s', async bits => {
    const h = await open()
    const binary = Buffer.from([0xEF, 0xBB, 0xBF, 0, 255, 1, 2])
    writeFileSync(join(h.dir, 'bin.dat'), binary)
    writeFileSync(join(h.dir, 'text'), `${BOM}text\n`)
    setMode(h, 'bin.dat', bits)
    setMode(h, 'text', bits)
    const ino = inode(h, 'bin.dat')
    await h.observe('bin.dat')
    await h.observe('text')
    mkdirSync(join(h.dir, 'locked'))
    writeFileSync(join(h.dir, 'locked/f'), 'f\n')
    await h.observe('locked/f')
    chmodSync(join(h.dir, 'locked'), 0o500)
    locked.push(join(h.dir, 'locked'))
    await expect(h.run(patch('*** Delete File: bin.dat', '*** Delete File: text', '*** Delete File: locked/f'))).rejects.toThrow('The 2 earlier change(s) of this patch were undone.')
    expect(bytes(h, 'bin.dat')).toEqual(binary)
    expect(bytes(h, 'text')).toEqual(Buffer.from(`${BOM}text\n`))
    expect([mode(h, 'bin.dat').toString(8), mode(h, 'text').toString(8)]).toEqual([bits, bits])
    expect(inode(h, 'bin.dat')).toBe(ino)
    expect(staged(h)).toEqual([])
  })

  it('leaves no staging directory after success', async () => {
    const h = await open()
    mkdirSync(join(h.dir, 'sub'))
    writeFileSync(join(h.dir, 'a'), 'a\n')
    writeFileSync(join(h.dir, 'sub/b'), 'b\n')
    await h.observe('a')
    await h.observe('sub/b')
    await h.run(patch('*** Delete File: a', '*** Delete File: sub/b'))
    expect(readdirSync(h.dir)).toEqual(['sub'])
    expect(readdirSync(join(h.dir, 'sub'))).toEqual([])
  })

  it('keeps both versions when the file is replaced while it is being staged', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'f'), 'read version\n')
    await h.observe('f')
    fakeLn(h, `/bin/ln "$@" || exit 1; printf 'newer\\n' > "$2.new" && mv -f "$2.new" "$2"`)
    const error = await h.run(patch('*** Delete File: f')).catch((e: Error) => e)
    expect(error).toMatchObject({ code: 'PATCH_STALE' })
    expect(bytes(h, 'f')).toEqual(Buffer.from('newer\n'))
    const [dir] = staged(h)
    expect(String(error)).toContain(`the version this session read is kept at "${join(h.dir, dir, '0')}"`)
    expect(readFileSync(join(h.dir, dir, '0'), 'utf8')).toBe('read version\n')
    expect(String(error)).not.toContain('No file had been changed')
  })

  it('keeps the staged file and names it when the name was taken again before the undo', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'f'), 'deleted\n')
    await h.observe('f')
    mkdirSync(join(h.dir, 'locked'))
    writeFileSync(join(h.dir, 'locked/g'), 'g\n')
    await h.observe('locked/g')
    chmodSync(join(h.dir, 'locked'), 0o500)
    locked.push(join(h.dir, 'locked'))
    h.mapShell((result, n) => {
      if (n === 1) writeFileSync(join(h.dir, 'f'), 'recreated\n')
      return result
    })
    const error = await h.run(patch('*** Delete File: f', '*** Delete File: locked/g')).catch((e: Error) => e)
    const [dir] = staged(h)
    expect(String(error)).toContain(`"f" was created again by someone else; the deleted file is kept at "${join(h.dir, dir, '0')}".`)
    expect(bytes(h, 'f')).toEqual(Buffer.from('recreated\n'))
    expect(readFileSync(join(h.dir, dir, '0'), 'utf8')).toBe('deleted\n')
  })
})

describe('undoing an added file', () => {
  it('stages it and removes the staging directory', async () => {
    const h = await open()
    mkdirSync(join(h.dir, 'locked'))
    writeFileSync(join(h.dir, 'locked/f'), 'f\n')
    await h.observe('locked/f')
    chmodSync(join(h.dir, 'locked'), 0o500)
    locked.push(join(h.dir, 'locked'))
    await expect(h.run(patch('*** Add File: new', '+n', '*** Delete File: locked/f'))).rejects.toThrow('The 1 earlier change(s) of this patch were undone.')
    expect(readdirSync(h.dir).sort()).toEqual(['locked'])
  })

  it('leaves an added file that was replaced while it was being staged, and keeps ours', async () => {
    const h = await open()
    mkdirSync(join(h.dir, 'locked'))
    writeFileSync(join(h.dir, 'locked/f'), 'f\n')
    await h.observe('locked/f')
    chmodSync(join(h.dir, 'locked'), 0o500)
    locked.push(join(h.dir, 'locked'))
    fakeLn(h, `/bin/ln "$@" || exit 1; case "$2" in */new) printf 'theirs\\n' > "$2.x" && mv -f "$2.x" "$2" ;; esac`)
    const error = await h.run(patch('*** Add File: new', '+ours', '*** Delete File: locked/f')).catch((e: Error) => e)
    expect(String(error)).toContain('"new" was changed while it was being removed')
    expect(bytes(h, 'new')).toEqual(Buffer.from('theirs\n'))
    const [dir] = staged(h)
    expect(readFileSync(join(h.dir, dir, '0'), 'utf8')).toBe('ours\n')
  })
})

describe('staged files are verified', () => {
  it('puts a file edited in place while it is being staged back, and does not report it deleted', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'f'), 'read version\n')
    await h.observe('f')
    fakeLn(h, `/bin/ln "$@" || exit 1; printf 'edited in place\\n' > "$2"`)
    const error = await h.run(patch('*** Delete File: f')).catch((e: Error) => e)
    expect(error).toMatchObject({ code: 'PATCH_STALE', message: expect.stringContaining('"f" changed while it was being deleted') })
    expect(String(error)).toContain('It was put back as it is now')
    expect(bytes(h, 'f')).toEqual(Buffer.from('edited in place\n'))
    expect(staged(h)).toEqual([])
  })

  it('keeps a staged file edited after staging and names it instead of removing it', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'a'), 'a\n')
    writeFileSync(join(h.dir, 'b'), 'b\n')
    await h.observe('a')
    await h.observe('b')
    h.mapShell((result, n) => {
      if (n === 2) {
        const [dir] = staged(h)
        writeFileSync(join(h.dir, dir, '0'), 'edited after staging\n')
      }
      return result
    })
    const result = await h.run(patch('*** Delete File: a', '*** Delete File: b')) as { summary: string }
    const [dir] = staged(h)
    expect(result.summary).toContain(`"${join(h.dir, dir, '0')}" changed after this patch staged it, so it was kept`)
    expect(readdirSync(join(h.dir, dir))).toEqual(['0'])
    expect(readFileSync(join(h.dir, dir, '0'), 'utf8')).toBe('edited after staging\n')
    expect(existsSync(join(h.dir, 'b'))).toBe(false)
  })

  it('never takes over a staging directory that exists already', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'source'), 'source\n')
    await h.observe('source')
    let foreign = ''
    const shell = h.ctx.get('shell') as { execute(spec: { env?: Record<string, string> }): Promise<unknown> }
    const execute = shell.execute.bind(shell)
    shell.execute = spec => {
      if (foreign === '' && spec.env?.DSH_APPLY_PATCH_MKDIR === 'private') {
        foreign = join(spec.env.DSH_APPLY_PATCH_TO, '..')
        mkdirSync(foreign, { mode: 0o700 })
        writeFileSync(join(foreign, 'valuable'), 'unrelated work\n')
        writeFileSync(join(foreign, '0'), 'unrelated slot\n')
      }
      return execute(spec)
    }
    await h.run(patch('*** Delete File: source'))
    expect(existsSync(join(h.dir, 'source'))).toBe(false)
    expect(readdirSync(foreign).sort()).toEqual(['0', 'valuable'])
    expect(readFileSync(join(foreign, '0'), 'utf8')).toBe('unrelated slot\n')
    expect(staged(h)).toHaveLength(1)
  })

  /** Count the 1 MiB digest windows read after the first shell command (the staging relink); `during(n)` runs before window `n`. */
  const windowsAfterStaging = (h: Harness, during: (n: number) => void) => {
    let staged = false
    let windows = 0
    h.mapShell((result, n) => {
      if (n === 1) staged = true
      return result
    })
    const original = h.fs.readByteRange.bind(h.fs)
    h.fs.readByteRange = async (target, range, signal) => {
      if (staged && range.length === 1 << 20) during(++windows)
      return original(target, range, signal)
    }
    return () => windows
  }

  it('stops verifying a staged file that keeps growing as soon as its version changes', async () => {
    const h = await open()
    const block = Buffer.alloc(1 << 20, 0xa5)
    writeFileSync(join(h.dir, 'big'), Buffer.concat([block, block, block]))
    await h.observe('big')
    const windows = windowsAfterStaging(h, () => {
      const [dir] = staged(h)
      appendFileSync(join(h.dir, dir, '0'), block)
    })
    const error = await h.run(patch('*** Delete File: big')).catch((e: Error) => e)
    expect(error).toMatchObject({ code: 'PATCH_STALE' })
    expect(windows()).toBeLessThanOrEqual(2)
    // Still growing, the staged file cannot be put back at its read version; it is kept and named.
    const [dir] = staged(h)
    expect(String(error)).toContain(`It is kept, as it is now, at "${join(h.dir, dir, '0')}"`)
  })

  it('stops verifying a staged file when the call is aborted, and puts the file back', async () => {
    const h = await open()
    const block = Buffer.alloc(1 << 20, 0x5a)
    const content = Buffer.concat([block, block, block, block])
    writeFileSync(join(h.dir, 'big'), content)
    await h.observe('big')
    const abort = new AbortController()
    const windows = windowsAfterStaging(h, n => {
      if (n === 1) abort.abort()
    })
    await expect(h.run(patch('*** Delete File: big'), {}, abort.signal)).rejects.toBeInstanceOf(Error)
    expect(windows()).toBeLessThanOrEqual(2)
    expect(bytes(h, 'big')).toEqual(content)
    expect(staged(h)).toEqual([])
  })

  it('does not remove a staging directory whose creation it could not confirm', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'f'), 'f\n')
    await h.observe('f')
    h.mapShell((result, n) => n === 1 ? { ...result, exitCode: null, aborted: true } : result)
    const result = await h.run(patch('*** Delete File: f')) as { summary: string }
    const [dir] = staged(h)
    expect(readdirSync(join(h.dir, dir))).toEqual([])
    expect(result.summary).toContain(`"${join(h.dir, dir)}" may have been left by this patch`)
  })
})

describe('an undone move', () => {
  it('is not reported undone when the file put back changed right after', async () => {
    const h = await open()
    writeFileSync(join(h.dir, 'src'), 'original\n')
    await h.observe('src')
    mkdirSync(join(h.dir, 'locked'))
    writeFileSync(join(h.dir, 'locked/f'), 'f\n')
    await h.observe('locked/f')
    chmodSync(join(h.dir, 'locked'), 0o500)
    locked.push(join(h.dir, 'locked'))
    h.mapShell((result, n) => {
      if (n === 3) writeFileSync(join(h.dir, 'src'), 'edited after the undo\n')
      return result
    })
    const error = await h.run(patch('*** Update File: src', '*** Move to: dest', '*** Delete File: locked/f')).catch((e: Error) => e)
    expect(String(error)).not.toContain('were undone')
    expect(String(error)).toContain('"src" was moved back from "dest", but it changed right after or could not be checked')
    expect(bytes(h, 'src')).toEqual(Buffer.from('edited after the undo\n'))
  })
})
