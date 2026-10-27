import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyToFile } from '../src/apply/content.js'
import { parseCodexPatch } from '../src/parse/codex.js'
import { parseUnifiedDiff } from '../src/parse/unified.js'

/**
 * File names of unified diffs are checked as plain `git apply` checks them
 * (`apply.c` `check_unsafe_path`, `read-cache.c` `verify_path` with git's
 * default `core.protectNTFS`, and `core.protectHFS` on macOS), and names that
 * are not valid UTF-8 are refused. Every expectation is checked against the
 * installed git.
 */

type Outcome = Record<string, string> | 'error'

const abc = 'alpha\nbeta\nomega\n'
const start: Record<string, string> = { f: abc, 'x/f': abc, 'x/.gitignore': abc }
const update = '@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n omega\n'
const add = '@@ -0,0 +1 @@\n+x\n'
const remove = '@@ -1,3 +0,0 @@\n-alpha\n-beta\n-omega\n'
const updated = (path: string) => ({ ...start, [path]: 'alpha\nBETA\nomega\n' })
const added = (path: string) => ({ ...start, [path]: 'x\n' })
const pair = (first: string, second: string, hunk = update) => `--- ${first}\n+++ ${second}\n${hunk}`
const newFile = (name: string) => `diff --git a/${name} b/${name}\nnew file mode 100644\n--- /dev/null\n+++ b/${name}\n${add}`

/** Apply `patch` to `files` in memory as the tool would. */
function ours(patch: string, files: Record<string, string> = start): Outcome {
  const out: Record<string, string> = { ...files }
  try {
    for (const op of parseUnifiedDiff(patch).ops) {
      if (op.kind === 'add') {
        if (op.path in out) return 'error'
        out[op.path] = op.content
      } else if (op.kind === 'delete') {
        if (!(op.path in out)) return 'error'
        if (op.chunks !== undefined && op.chunks.length > 0 && applyToFile(op.path, out[op.path], op.chunks, 'unified') !== '') return 'error'
        delete out[op.path]
      } else {
        if (!(op.path in out)) return 'error'
        const text = applyToFile(op.path, out[op.path], op.chunks, 'unified')
        delete out[op.path]
        const target = op.moveTo ?? op.path
        if (target in out) return 'error'
        out[target] = text
      }
    }
  } catch (error: unknown) {
    expect(error).toMatchObject({ code: expect.stringMatching(/^PATCH_/) })
    return 'error'
  }
  return out
}

/** The tool's error code and message for `patch`, or `''` when it parses. */
function failure(patch: string): string {
  try {
    parseUnifiedDiff(patch)
    return ''
  } catch (error: unknown) {
    return error instanceof Error ? `${(error as { code?: string }).code}: ${error.message}` : String(error)
  }
}

/** Apply `patch` with `git apply` in a fresh repository holding `files`. */
function real(patch: string, files: Record<string, string> = start): Outcome {
  const dir = mkdtempSync(join(tmpdir(), 'ap-paths-'))
  try {
    spawnSync('git', ['init', '-q', 'repo'], { cwd: dir })
    const repo = join(dir, 'repo')
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, name)), { recursive: true })
      writeFileSync(join(repo, name), text)
    }
    writeFileSync(join(dir, 'p.diff'), patch)
    if (spawnSync('git', ['apply', join(dir, 'p.diff')], { cwd: repo }).status !== 0) return 'error'
    const out: Record<string, string> = {}
    const walk = (rel: string): void => {
      for (const name of readdirSync(join(repo, rel))) {
        const path = rel === '' ? name : `${rel}/${name}`
        if (path === '.git') continue
        if (statSync(join(repo, path)).isDirectory()) walk(path)
        else out[path] = readFileSync(join(repo, path), 'utf8')
      }
    }
    walk('')
    return out
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const hasGit = spawnSync('git', ['--version']).status === 0
const mac = process.platform === 'darwin'

interface Case {
  name: string
  patch: string
  files?: Record<string, string>
  git: Outcome
  /** The tool's refusal: code and message. */
  refusal?: RegExp
  /** Only where git protects HFS+ names (macOS). */
  hfs?: boolean
  /** A name that is not UTF-8: git writes its bytes where the file system takes them (not on macOS), so git is asked only on macOS. */
  bytes?: boolean
}

const invalid = (name: string) => new RegExp(`^PATCH_PARSE: .*invalid path ${JSON.stringify(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)
const notUtf8 = /^PATCH_UNSUPPORTED: .*not valid UTF-8/

const cases: Case[] = [
  // Refused by git: "invalid path".
  { name: 'refuses a "." component of a bare pair', patch: pair('a/./f', 'b/./f'), git: 'error', refusal: invalid('./f') },
  { name: 'refuses a ".." component of a bare pair', patch: pair('a/../f', 'b/../f'), git: 'error', refusal: invalid('../f') },
  { name: 'refuses a ".." component inside a name', patch: pair('a/x/../f', 'b/x/../f'), git: 'error', refusal: invalid('x/../f') },
  { name: 'refuses a "." last component', patch: pair('/dev/null', 'b/x/.', add), git: 'error', refusal: invalid('x/.') },
  { name: 'refuses an absolute name left after removing the first component', patch: pair('a//f', 'b//f'), git: 'error', refusal: invalid('/f') },
  { name: 'refuses a name ending in "/"', patch: pair('/dev/null', 'b/dir/', add), git: 'error', refusal: invalid('dir/') },
  { name: 'refuses ".git/config"', patch: pair('a/.git/config', 'b/.git/config'), files: { ...start, '.git/config': abc }, git: 'error', refusal: invalid('.git/config') },
  { name: 'refuses a ".git" component in any case', patch: pair('/dev/null', 'b/x/.GIT/y', add), git: 'error', refusal: invalid('x/.GIT/y') },
  { name: 'refuses a last ".git" component', patch: pair('/dev/null', 'b/x/.git', add), git: 'error', refusal: invalid('x/.git') },
  { name: 'refuses ".git" with trailing dots, as NTFS reads it', patch: pair('/dev/null', 'b/.git./y', add), git: 'error', refusal: invalid('.git./y') },
  { name: 'refuses ".git" with a trailing space, as NTFS reads it', patch: `--- /dev/null\n+++ b/.git \t2010-07-05 19:41:18\n${add}`, git: 'error', refusal: invalid('.git ') },
  { name: 'refuses the NTFS short name "git~1"', patch: pair('/dev/null', 'b/GIT~1/y', add), git: 'error', refusal: invalid('GIT~1/y') },
  { name: 'refuses ".git" with an NTFS stream', patch: pair('/dev/null', 'b/.git:y', add), git: 'error', refusal: invalid('.git:y') },
  { name: 'refuses ".git" after a backslash, as NTFS reads it', patch: pair('/dev/null', 'b/x\\.git/y', add), git: 'error', refusal: invalid('x\\.git/y') },
  { name: 'refuses ".git" with ignorable code points, as HFS+ reads it', patch: pair('/dev/null', 'b/.g\u200Cit/y', add), git: 'error', refusal: invalid('.g\u200Cit/y'), hfs: true },
  { name: 'refuses ".git" after a byte order mark, as HFS+ reads it', patch: pair('/dev/null', 'b/\uFEFF.git/y', add), git: 'error', refusal: invalid('\uFEFF.git/y'), hfs: true },
  { name: 'refuses a "." component of a "diff --git" section', patch: `diff --git a/./f b/./f\n--- a/./f\n+++ b/./f\n${update}`, git: 'error', refusal: invalid('./f') },
  { name: 'refuses a quoted ".git" name', patch: `diff --git "a/.git/x" "b/.git/x"\nnew file mode 100644\n--- /dev/null\n+++ "b/.git/x"\n${add}`, git: 'error', refusal: invalid('.git/x') },
  { name: 'refuses a new file in ".git"', patch: newFile('.git/hooks/pre-commit'), git: 'error', refusal: invalid('.git/hooks/pre-commit') },
  { name: 'refuses a deletion of a "." name', patch: `diff --git a/./f b/./f\ndeleted file mode 100644\n--- a/./f\n+++ /dev/null\n${remove}`, git: 'error', refusal: invalid('./f') },
  { name: 'refuses a rename into ".git"', patch: 'diff --git a/f b/.git/f\nsimilarity index 100%\nrename from f\nrename to .git/f\n', git: 'error', refusal: invalid('.git/f') },
  { name: 'refuses a rename from a ".." name', patch: 'diff --git a/../f b/g\nsimilarity index 100%\nrename from ../f\nrename to g\n', git: 'error', refusal: invalid('../f') },
  { name: 'refuses a rename out of the tree with ".."', patch: 'diff --git a/f b/../g\nsimilarity index 100%\nrename from f\nrename to ../g\n', git: 'error', refusal: invalid('../g') },

  // Accepted by git.
  { name: 'accepts a name starting with ".git"', patch: pair('/dev/null', 'b/.gitfoo', add), git: added('.gitfoo') },
  { name: 'accepts ".gitmodules"', patch: pair('/dev/null', 'b/.gitmodules', add), git: added('.gitmodules') },
  { name: 'accepts a name starting with ".."', patch: pair('/dev/null', 'b/..foo', add), git: added('..foo') },
  { name: 'accepts "..."', patch: pair('/dev/null', 'b/x/...', add), git: added('x/...') },
  { name: 'accepts a dot file', patch: pair('/dev/null', 'b/.x', add), git: added('.x') },
  { name: 'accepts "git~2"', patch: pair('/dev/null', 'b/git~2/y', add), git: added('git~2/y') },
  { name: 'accepts ".git" inside a component', patch: pair('/dev/null', 'b/x.git/y', add), git: added('x.git/y') },
  { name: 'accepts ".gitignore" in a directory', patch: pair('a/x/.gitignore', 'b/x/.gitignore'), git: updated('x/.gitignore') },
  { name: 'accepts a leading backslash before ".git" in a component', patch: pair('/dev/null', 'b/\\.git', add), git: added('\\.git') },
  { name: 'squashes doubled slashes of a rename name', patch: 'diff --git a/f b/x//g\nsimilarity index 100%\nrename from f\nrename to x//g\n', git: (({ f: _, ...rest }) => ({ ...rest, 'x/g': abc }))(start) },
  { name: 'accepts a name whose first component is removed', patch: pair('a/x/f', 'b/x/f'), git: updated('x/f') },
  // UTF-8 names.
  { name: 'decodes a quoted UTF-8 name', patch: `diff --git "a/caf\\303\\251" "b/caf\\303\\251"\nnew file mode 100644\n`, git: { ...start, 'café': '' } },
  { name: 'reads distinct quoted names that are not UTF-8 as different names', patch: 'diff --git "a/\\377" "b/\\376"\nnew file mode 100644\n', git: 'error', refusal: /^PATCH_PARSE: .*names two different files/ },
  { name: 'refuses a new file whose quoted name is not UTF-8', patch: 'diff --git "a/\\377" "b/\\377"\nnew file mode 100644\n', git: 'error', refusal: notUtf8, bytes: true },
  { name: 'refuses a quoted name that is not UTF-8 in a bare pair', patch: pair('/dev/null', '"b/x\\377"', add), git: 'error', refusal: notUtf8, bytes: true },
  { name: 'refuses a truncated UTF-8 sequence in a quoted rename name', patch: 'diff --git a/f b/g\nsimilarity index 100%\nrename from f\nrename to "g\\303"\n', git: 'error', refusal: notUtf8, bytes: true },
  { name: 'refuses an encoded surrogate in a quoted name', patch: pair('/dev/null', '"b/x\\355\\240\\200"', add), git: 'error', refusal: notUtf8, bytes: true },
  { name: 'skips a "diff --git" line with a name that is not UTF-8, as git skips it as text', patch: `diff --git "a/\\377" "b/\\377"\nprose\n${pair('a/f', 'b/f')}`, git: updated('f') },
]

describe('file names of unified diffs', () => {
  it.each(cases)('$name', ({ patch, files, git: expected, refusal, hfs }) => {
    if (hfs === true && !mac) {
      expect(ours(patch, files)).not.toBe('error')
      return
    }
    if (refusal === undefined) expect(ours(patch, files)).toEqual(expected)
    else {
      expect(ours(patch, files)).toBe('error')
      expect(failure(patch)).toMatch(refusal)
    }
  })

  it.runIf(hasGit).each(cases.filter(c => (c.hfs !== true && c.bytes !== true) || mac))('git apply agrees: $name', ({ patch, files, git: expected }) => {
    expect(real(patch, files)).toEqual(expected)
  })

  it('refuses an unquoted name with a lone surrogate, which no file name holds', () => {
    expect(failure(pair('/dev/null', 'b/x\uD800', add))).toMatch(notUtf8)
  })

  it('shows the bytes of a name that is not UTF-8 as octal escapes', () => {
    expect(failure('diff --git "a/x\\377" "b/x\\377"\nnew file mode 100644\n')).toContain('x\\377')
  })

  it('leaves Codex names as they were', () => {
    const op = parseCodexPatch('*** Begin Patch\n*** Add File: ./x/../.gitfoo\n+x\n*** End Patch\n').ops[0]
    expect(op.path).toBe('./x/../.gitfoo')
  })
})
