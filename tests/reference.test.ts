import { describe, expect, it } from 'vitest'
import { applyChunks } from '../src/apply/content.js'
import { parseCodexPatch } from '../src/parse/codex.js'
import { parseUnifiedDiff } from '../src/parse/unified.js'
import { referenceCases } from './reference-cases.js'

/** Parse and apply one case to `f`. */
function apply(format: 'codex' | 'unified', before: string, patch: string): string {
  const parsed = format === 'codex' ? parseCodexPatch(`*** Begin Patch\n*** Update File: f\n${patch}\n*** End Patch`) : parseUnifiedDiff(patch)
  expect(parsed.ops).toHaveLength(1)
  const op = parsed.ops[0]
  if (op.kind !== 'update') throw new Error(`expected an update, got ${op.kind}`)
  return applyChunks('f', before, op.chunks, format)
}

describe('output matches codex-rs for Codex patches and git apply for unified diffs', () => {
  it.each(referenceCases)('$format: $name', ({ format, before, patch, expected }) => {
    if (typeof expected === 'string') {
      expect(JSON.stringify(apply(format, before, patch))).toBe(JSON.stringify(expected))
    } else {
      let error: unknown
      try { apply(format, before, patch) } catch (caught: unknown) { error = caught }
      expect(error).toMatchObject({ code: expected.code, message: expect.stringContaining(expected.error) })
    }
  })
})
