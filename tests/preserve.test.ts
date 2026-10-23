import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
