import { spawnSync } from 'node:child_process'
import { chmodSync, lstatSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyToFile } from '../src/apply/content.js'
import { parseUnifiedDiff } from '../src/parse/unified.js'

/**
 * Git header lines (`apply.c` `parse_git_diff_header`) are read only between
 * `diff --git` and the first hunk; elsewhere they are text git skips. Every
 * `git` expectation was produced by plain `git apply` on `f` = `a\nb\n`, and is
 * checked again against the installed git when there is one.
 */

/** Files after the patch, or the fact that the patch was refused. */
type Outcome = Record<string, string> | 'error'

interface Case {
  name: string
  patch: string
  git: Outcome
  /** Where this tool deliberately differs from git: refuses what git accepts. */
  ours?: 'error'
}

const before = 'a\nb\n'
const hunk = '@@ -1,2 +1,2 @@\n-a\n+A\n b\n'
const head = '--- a/f\n+++ b/f\n'
const git = 'diff --git a/f b/f\n'
const updated = { f: 'A\nb\n' }

const cases: Case[] = [
  ...['rename from f\nrename to g', 'deleted file mode 100644', 'new file mode 100644', 'copy from f\ncopy to g', 'old mode 100644\nnew mode 100755', 'similarity index 90%', 'index 1234567..abcdef0 100644']
    .flatMap(meta => [
      { name: `skips "${meta.split('\n')[0]}" after a hunk`, patch: `${head}${hunk}${meta}\n`, git: updated },
      { name: `skips "${meta.split('\n')[0]}" after a hunk of a "diff --git" section`, patch: `${git}${head}${hunk}${meta}\n`, git: updated },
      { name: `skips "${meta.split('\n')[0]}" before a bare "---"/"+++" section`, patch: `${meta}\n${head}${hunk}`, git: updated },
    ]),
  { name: 'reads git header lines of the next section after a hunk', patch: `${head}${hunk}new file mode 100644\n--- /dev/null\n+++ b/g\n@@ -0,0 +1 @@\n+x\n`, git: { f: 'A\nb\n', g: 'x\n' } },
  { name: 'renames with "rename to" after the "---"/"+++" names', patch: `${git}${head}rename to g\n${hunk}`, git: { g: 'A\nb\n' } },
  { name: 'renames with "rename old"/"rename new"', patch: `${git}${head}rename old f\nrename new g\n${hunk}`, git: { g: 'A\nb\n' } },
  { name: 'moves a "diff --git" file whose "---"/"+++" names differ', patch: `${git}--- a/f\n+++ b/g\n${hunk}`, git: { g: 'A\nb\n' } },
  { name: 'renames without hunks', patch: 'diff --git a/f b/g\nsimilarity index 100%\nrename from f\nrename to g\n', git: { g: 'a\nb\n' } },
  { name: 'renames without hunks before the next section', patch: 'diff --git a/f b/g\nrename from f\nrename to g\ndiff --git a/h b/h\nnew file mode 100644\n--- /dev/null\n+++ b/h\n@@ -0,0 +1 @@\n+x\n', git: { g: 'a\nb\n', h: 'x\n' } },
  { name: 'skips a "diff --git" line without header lines', patch: `${git}\n${head}${hunk}`, git: updated },
  { name: 'skips a "diff --git" line followed by text', patch: `${git}foo\n${head}${hunk}`, git: updated },
  { name: 'rejects a hunk right after a "diff --git" line', patch: `${git}${hunk}`, git: 'error' },
  { name: 'rejects a "diff --git" line with two different names and no header lines', patch: `diff --git a/f b/g\n\n${head}${hunk}`, git: 'error' },
  { name: 'rejects "rename from" without "rename to"', patch: `diff --git a/f b/g\nrename from f\n${hunk}`, git: 'error' },
  { name: 'rejects "rename to" without "rename from"', patch: `diff --git a/f b/g\nrename to g\n${hunk}`, git: 'error' },
  { name: 'rejects a "+++" name that disagrees with "rename to"', patch: `${git}rename from f\nrename to g\n${head}${hunk}`, git: 'error' },
  { name: 'rejects two different "---" names', patch: `${git}--- a/g\n${head}${hunk}`, git: 'error' },
  { name: 'rejects a "+++" name after "deleted file mode"', patch: `${git}deleted file mode 100644\n${head}${hunk}`, git: 'error' },
  { name: 'rejects a "---" name after "new file mode"', patch: `${git}new file mode 100644\n${head}@@ -1 +1,2 @@\n a\n+b\n`, git: 'error' },
  { name: 'rejects "new file mode" together with a rename', patch: 'diff --git a/f b/g\nnew file mode 100644\nrename from f\nrename to g\n', git: 'error' },
  { name: 'rejects an invalid mode', patch: `${git}old mode nonsense\n${head}${hunk}`, git: 'error' },
  { name: 'rejects an invalid mode on an "index" line', patch: `${git}index 123..456 nonsense\n${head}${hunk}`, git: 'error' },
  { name: 'rejects blank lines after the git header lines', patch: `${git}index 1234567..abcdef0 100644\n\n\n${head}${hunk}`, git: 'error' },
  { name: 'rejects a hunk after the blank line that ends a section without hunks', patch: `diff --git a/f b/g\nrename from f\nrename to g\n\n${hunk}`, git: 'error' },
  { name: 'rejects names that disagree without "---"/"+++" or rename lines', patch: `diff --git a/f b/g\n${hunk}`, git: 'error' },
  { name: 'rejects "--- /dev/null" without "new file mode"', patch: 'diff --git a/g b/g\n--- /dev/null\n+++ b/g\n@@ -0,0 +1 @@\n+x\n', git: 'error' },
  // git takes the name `dev/null` and writes the file `dev/null`.
  { name: 'rejects "+++ /dev/null" without "deleted file mode"', patch: `${git}--- a/f\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n`, git: { 'dev/null': '' }, ours: 'error' },
  // git ignores a lone `---` line after a hunk; here it is a change line beyond the header counts.
  { name: 'rejects a "---" line after a complete hunk', patch: `${head}${hunk}--- a/g\n`, git: updated, ours: 'error' },
]

/** Apply `patch` to `start` (`f` = `before`) in memory. */
function ours(patch: string, start: Record<string, string> = { f: before }): Outcome {
  const files: Record<string, string> = { ...start }
  try {
    for (const op of parseUnifiedDiff(patch).ops) {
      if (op.kind === 'add') {
        if (op.path in files) return 'error'
        files[op.path] = op.content
      } else if (op.kind === 'delete') {
        if (!(op.path in files)) return 'error'
        if (op.chunks !== undefined && op.chunks.length > 0 && applyToFile(op.path, files[op.path], op.chunks, 'unified') !== '') return 'error'
        delete files[op.path]
      } else {
        if (!(op.path in files)) return 'error'
        const text = applyToFile(op.path, files[op.path], op.chunks, 'unified')
        delete files[op.path]
        const target = op.moveTo ?? op.path
        if (target in files) return 'error'
        files[target] = text
      }
    }
  } catch (error: unknown) {
    expect(error).toMatchObject({ code: expect.stringMatching(/^PATCH_/) })
    return 'error'
  }
  return files
}

/** Apply `patch` with `git apply` in a fresh repository holding `start` (`f` = `before`). */
function real(patch: string, start: Record<string, string> = { f: before }): Outcome {
  const dir = mkdtempSync(join(tmpdir(), 'ap-git-headers-'))
  try {
    spawnSync('git', ['init', '-q'], { cwd: dir })
    for (const [name, text] of Object.entries(start)) writeFileSync(join(dir, name), text)
    writeFileSync(join(dir, '.patch'), patch)
    if (spawnSync('git', ['apply', '.patch'], { cwd: dir }).status !== 0) return 'error'
    const files: Record<string, string> = {}
    const walk = (rel: string): void => {
      for (const name of readdirSync(join(dir, rel))) {
        const path = rel === '' ? name : `${rel}/${name}`
        if (path === '.git' || path === '.patch') continue
        if (statSync(join(dir, path)).isDirectory()) walk(path)
        else files[path] = readFileSync(join(dir, path), 'utf8')
      }
    }
    walk('')
    return files
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const hasGit = spawnSync('git', ['--version']).status === 0

describe('git header lines', () => {
  it.each(cases)('$name', ({ patch, git: expected, ours: override }) => {
    expect(ours(patch)).toEqual(override ?? expected)
  })

  it.runIf(hasGit).each(cases)('git apply agrees: $name', ({ patch, git: expected }) => {
    expect(real(patch)).toEqual(expected)
  })
})

/**
 * A bare `---`/`+++` pair without hunks is text git skips, also with
 * `/dev/null` on one side; only a `diff --git` header with `new file mode` or
 * `deleted file mode` creates or deletes a file without hunks.
 */
describe('bare "---"/"+++" pairs without hunks', () => {
  const updateG = 'diff --git a/g b/g\n--- a/g\n+++ b/g\n@@ -1 +1 @@\n-a\n+A\n'
  const addPair = '--- /dev/null\n+++ b/f\n'
  const deletePair = '--- a/f\n+++ /dev/null\n'
  const cases: { name: string; start: Record<string, string>; patch: string; git: Outcome }[] = [
    { name: 'keeps an empty file after a deletion pair that follows a hunk', start: { g: 'a\n', f: '' }, patch: updateG + deletePair, git: { g: 'A\n', f: '' } },
    { name: 'keeps an empty file after a deletion pair before a section', start: { g: 'a\n', f: '' }, patch: deletePair + updateG, git: { g: 'A\n', f: '' } },
    { name: 'keeps a file holding only a byte order mark after a deletion pair', start: { g: 'a\n', f: '\uFEFF' }, patch: updateG + deletePair, git: { g: 'A\n', f: '\uFEFF' } },
    { name: 'creates no file for an addition pair that follows a hunk', start: { g: 'a\n' }, patch: updateG + addPair, git: { g: 'A\n' } },
    { name: 'creates no file for an addition pair before a section', start: { g: 'a\n' }, patch: addPair + updateG, git: { g: 'A\n' } },
    { name: 'creates no file for an addition pair between sections', start: { g: 'a\n', h: 'b\n' }, patch: `${updateG}${addPair}diff --git a/h b/h\n--- a/h\n+++ b/h\n@@ -1 +1 @@\n-b\n+B\n`, git: { g: 'A\n', h: 'B\n' } },
    { name: 'rejects a lone deletion pair', start: { f: '' }, patch: deletePair, git: 'error' },
    { name: 'rejects a lone addition pair', start: {}, patch: addPair, git: 'error' },
    { name: 'rejects a lone update pair', start: { f: '' }, patch: '--- a/f\n+++ b/f\n', git: 'error' },
    { name: 'deletes with a deletion pair and hunks', start: { g: 'a\n', f: 'x\n' }, patch: `${updateG}${deletePair}@@ -1 +0,0 @@\n-x\n`, git: { g: 'A\n' } },
    { name: 'creates with an addition pair and hunks', start: { g: 'a\n' }, patch: `${updateG}${addPair}@@ -0,0 +1 @@\n+x\n`, git: { g: 'A\n', f: 'x\n' } },
    { name: 'creates an empty file with "new file mode" and no hunks', start: { g: 'a\n' }, patch: `${updateG}diff --git a/f b/f\nnew file mode 100644\n`, git: { g: 'A\n', f: '' } },
    { name: 'deletes an empty file with "deleted file mode" and no hunks', start: { g: 'a\n', f: '' }, patch: `${updateG}diff --git a/f b/f\ndeleted file mode 100644\n`, git: { g: 'A\n' } },
    { name: 'creates an empty file with "new file mode" and "---"/"+++" names', start: {}, patch: 'diff --git a/f b/f\nnew file mode 100644\n--- /dev/null\n+++ b/f\n', git: { f: '' } },
  ]

  it.each(cases)('$name', ({ start, patch, git: expected }) => {
    expect(ours(patch, start)).toEqual(expected)
  })

  it('reports a patch of only hunkless pairs as PATCH_PARSE', () => {
    for (const patch of [deletePair, addPair, addPair + deletePair]) {
      expect(() => parseUnifiedDiff(patch)).toThrow(expect.objectContaining({ code: 'PATCH_PARSE', message: expect.stringMatching(/no file changes/) }))
    }
  })

  it.runIf(hasGit).each(cases)('git apply agrees: $name', ({ start, patch, git: expected }) => {
    expect(real(patch, start)).toEqual(expected)
  })
})

/** Files after `git apply` as `<kind>:<text>`: kind is the octal permission bits, `link` or `dir`. */
type ModeOutcome = Record<string, string> | 'error'

interface ModeCase {
  name: string
  patch: string
  /** What `git apply` (umask 022) leaves, starting from `f` = `before` with mode 644. */
  git: ModeOutcome
  /** What this tool leaves (no mode is ever changed), or `unsupported` for a `PATCH_UNSUPPORTED` refusal. */
  ours: Outcome | 'unsupported'
}

const newG = (mode: string) => `diff --git a/g b/g\nnew file mode ${mode}\n--- /dev/null\n+++ b/g\n@@ -0,0 +1 @@\n+x\n`

const modeCases: ModeCase[] = [
  { name: 'refuses a mode change without hunks', patch: `${git}old mode 100644\nnew mode 100755\n`, git: { f: '755:a\nb\n' }, ours: 'unsupported' },
  { name: 'refuses a mode change with hunks', patch: `${git}old mode 100644\nnew mode 100755\n${head}${hunk}`, git: { f: '755:A\nb\n' }, ours: 'unsupported' },
  { name: 'refuses removing the executable bit', patch: `${git}old mode 100755\nnew mode 100644\n${head}${hunk}`, git: { f: '644:A\nb\n' }, ours: 'unsupported' },
  { name: 'refuses a mode change next to another file', patch: `${git}old mode 100644\nnew mode 100755\n${newG('100644')}`, git: { f: '755:a\nb\n', g: '644:x\n' }, ours: 'unsupported' },
  { name: 'refuses a mode change after another file', patch: `${newG('100644')}${git}old mode 100644\nnew mode 100755\n${head}${hunk}`, git: { f: '755:A\nb\n', g: '644:x\n' }, ours: 'unsupported' },
  { name: 'refuses "new mode" without "old mode" before a hunk', patch: `${git}new mode 100755\n${head}${hunk}`, git: { f: '755:A\nb\n' }, ours: 'unsupported' },
  { name: 'refuses "new mode" without "old mode" or a hunk', patch: `${git}new mode 100755\n`, git: 'error', ours: 'unsupported' },
  { name: 'refuses "new mode" after the mode of an "index" line', patch: `${git}index 1234567..abcdef0 100644\nnew mode 100755\n`, git: { f: '755:a\nb\n' }, ours: 'unsupported' },
  { name: 'refuses a mode change with a rename', patch: 'diff --git a/f b/g\nold mode 100644\nnew mode 100755\nrename from f\nrename to g\n', git: { g: '755:a\nb\n' }, ours: 'unsupported' },
  { name: 'refuses an executable new file', patch: newG('100755'), git: { f: '644:a\nb\n', g: '755:x\n' }, ours: 'unsupported' },
  { name: 'refuses a new file with group write and execute bits', patch: newG('100775'), git: { f: '644:a\nb\n', g: '755:x\n' }, ours: 'unsupported' },
  { name: 'refuses a new symbolic link', patch: newG('120000'), git: { f: '644:a\nb\n', g: 'link:x\n' }, ours: 'unsupported' },
  { name: 'refuses a new submodule entry', patch: newG('160000'), git: { f: '644:a\nb\n', g: 'dir:' }, ours: 'unsupported' },
  { name: 'refuses a new file mode without file type bits', patch: newG('644'), git: { f: '644:a\nb\n', g: 'dir:' }, ours: 'unsupported' },
  { name: 'accepts equal old and new modes before a hunk', patch: `${git}old mode 100644\nnew mode 100644\n${head}${hunk}`, git: { f: '644:A\nb\n' }, ours: updated },
  { name: 'accepts modes that git reads as the same mode before a hunk', patch: `${git}old mode 100644\nnew mode 100664\n${head}${hunk}`, git: { f: '644:A\nb\n' }, ours: updated },
  { name: 'rejects modes that git reads as the same mode without hunks', patch: `${git}old mode 100644\nnew mode 100664\n`, git: 'error', ours: 'error' },
  { name: 'accepts a lone "old mode" line before a hunk', patch: `${git}old mode 100755\n${head}${hunk}`, git: { f: '644:A\nb\n' }, ours: updated },
  { name: 'accepts the mode of an "index" line before a hunk', patch: `${git}index 1234567..abcdef0 100755\n${head}${hunk}`, git: { f: '644:A\nb\n' }, ours: updated },
  { name: 'accepts a regular new file', patch: newG('100644'), git: { f: '644:a\nb\n', g: '644:x\n' }, ours: { f: before, g: 'x\n' } },
  { name: 'accepts a new file mode that git reads as 100644', patch: newG('100664'), git: { f: '644:a\nb\n', g: '644:x\n' }, ours: { f: before, g: 'x\n' } },
  { name: 'accepts deleting a file with another mode', patch: `${git}deleted file mode 100755\n--- a/f\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n`, git: {}, ours: {} },
  { name: 'accepts a "+" sign on a mode as git does', patch: `${git}old mode +100644\nnew mode 100644\n${head}${hunk}`, git: { f: '644:A\nb\n' }, ours: updated },
  { name: 'refuses a mode change written with a "+" sign', patch: `${git}old mode 100644\nnew mode +100755\n${head}${hunk}`, git: { f: '755:A\nb\n' }, ours: 'unsupported' },
  { name: 'accepts a "+" sign on a new file mode', patch: newG('+100644'), git: { f: '644:a\nb\n', g: '644:x\n' }, ours: { f: before, g: 'x\n' } },
  { name: 'refuses a negative new mode', patch: `${git}old mode 100644\nnew mode -100644\n${head}${hunk}`, git: 'error', ours: 'unsupported' },
  { name: 'refuses a negative old mode', patch: `${git}old mode -100644\nnew mode 100644\n${head}${hunk}`, git: 'error', ours: 'unsupported' },
  { name: 'refuses a negative executable old mode', patch: `${git}old mode -100755\nnew mode 100755\n${head}${hunk}`, git: 'error', ours: 'unsupported' },
  { name: 'refuses equal negative modes', patch: `${git}old mode -100644\nnew mode -100644\n${head}${hunk}`, git: 'error', ours: 'unsupported' },
  { name: 'refuses a negative mode that git wraps to 100644', patch: `${git}old mode -37777677134\nnew mode 100644\n${head}${hunk}`, git: { f: '644:A\nb\n' }, ours: 'unsupported' },
  { name: 'refuses a negative new file mode', patch: newG('-100644'), git: { f: '644:a\nb\n', g: 'dir:' }, ours: 'unsupported' },
  { name: 'refuses a negative deleted file mode', patch: `${git}deleted file mode -100644\n--- a/f\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n`, git: 'error', ours: 'unsupported' },
  { name: 'refuses a negative mode on an "index" line', patch: `${git}index 1234567..abcdef0 -100644\n${head}${hunk}`, git: 'error', ours: 'unsupported' },
  { name: 'rejects two signs on a mode', patch: `${git}old mode +-100644\nnew mode 100644\n${head}${hunk}`, git: 'error', ours: 'error' },
  { name: 'accepts leading zeros on a mode', patch: `${git}old mode 0000100644\nnew mode 100644\n${head}${hunk}`, git: { f: '644:A\nb\n' }, ours: updated },
  { name: 'accepts an overlong mode whose low 32 bits are 100644', patch: `${git}old mode 1000000100644\nnew mode 100644\n${head}${hunk}`, git: { f: '644:A\nb\n' }, ours: updated },
  { name: 'refuses a 64-bit mode that git reads as a submodule entry', patch: `${git}old mode 1777777777777777677134\nnew mode 100644\n${head}${hunk}`, git: 'error', ours: 'unsupported' },
  { name: 'refuses a mode beyond 64 bits', patch: `${git}old mode 777777777777777777777777100644\nnew mode 100644\n${head}${hunk}`, git: 'error', ours: 'unsupported' },
  { name: 'refuses equal symbolic link modes for a regular file', patch: `${git}old mode 120000\nnew mode 120000\n${head}${hunk}`, git: 'error', ours: 'unsupported' },
  { name: 'refuses a lone submodule "old mode"', patch: `${git}old mode 160000\n${head}${hunk}`, git: 'error', ours: 'unsupported' },
  { name: 'refuses a symbolic link mode on an "index" line', patch: `${git}index 1234567..abcdef0 120000\n${head}${hunk}`, git: 'error', ours: 'unsupported' },
  { name: 'refuses deleting a regular file as a symbolic link', patch: `${git}deleted file mode 120000\n--- a/f\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n`, git: 'error', ours: 'unsupported' },
  { name: 'refuses a lone directory "old mode"', patch: `${git}old mode 40000\n${head}${hunk}`, git: 'error', ours: 'unsupported' },
  { name: 'refuses a directory mode on an "index" line', patch: `${git}index 123..456 040000\n${head}${hunk}`, git: 'error', ours: 'unsupported' },
  { name: 'refuses a submodule mode on an "index" line', patch: `${git}index 123..456 160000\n${head}${hunk}`, git: 'error', ours: 'unsupported' },
  { name: 'skips mode lines after a hunk', patch: `${git}${head}${hunk}old mode 100644\nnew mode 100755\n`, git: { f: '644:A\nb\n' }, ours: updated },
]

/** Apply `patch` with `git apply` under umask 022 and report kinds and texts of the files. */
function realModes(patch: string): ModeOutcome {
  const dir = mkdtempSync(join(tmpdir(), 'ap-git-modes-'))
  try {
    spawnSync('git', ['init', '-q'], { cwd: dir })
    writeFileSync(join(dir, 'f'), before)
    chmodSync(join(dir, 'f'), 0o644)
    writeFileSync(join(dir, '.patch'), patch)
    if (spawnSync('sh', ['-c', 'umask 022 && git apply .patch'], { cwd: dir }).status !== 0) return 'error'
    const files: Record<string, string> = {}
    for (const name of readdirSync(dir)) {
      if (name === '.git' || name === '.patch') continue
      const path = join(dir, name)
      const stat = lstatSync(path)
      files[name] = stat.isSymbolicLink() ? `link:${readlinkSync(path)}` : stat.isDirectory() ? 'dir:' : `${(stat.mode & 0o777).toString(8)}:${readFileSync(path, 'utf8')}`
    }
    return files
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('git mode lines', () => {
  it.each(modeCases)('$name', ({ patch, ours: expected }) => {
    if (expected !== 'unsupported') return expect(ours(patch)).toEqual(expected)
    expect(() => parseUnifiedDiff(patch)).toThrow(expect.objectContaining({ code: 'PATCH_UNSUPPORTED', message: expect.stringMatching(/mode .*not supported|not supported.*mode|mode .*patches only regular files/) }))
  })

  it.runIf(hasGit).each(modeCases)('git apply: $name', ({ patch, git: expected }) => {
    expect(realModes(patch)).toEqual(expected)
  })
})

/**
 * Hunks of a new file are placed against an empty file, and hunks of a deleted
 * file against its text, as git places hunks of an update. Every generated
 * case is compared with `git apply`; the only allowed difference is a refused
 * context-free hunk that git would put at the end of the file instead of where
 * its header points.
 */
describe('hunks of new and deleted files', () => {
  const addHunks = [
    '@@ -0,0 +1 @@\n+x\n', '@@ -0,0 +1,2 @@\n+x\n+y\n', '@@ -0,0 +0,1 @@\n+x\n', '@@ -0,0 +5,2 @@\n+x\n+y\n', '@@ -1,0 +1 @@\n+x\n',
    '@@ -1,0 +2 @@\n+y\n', '@@ -2,0 +2 @@\n+y\n', '@@ -0,0 +2 @@\n+y\n', '@@ -3,0 +3 @@\n+z\n', '@@ -5,0 +5 @@\n+z\n', '@@ -0,0 +1 @@\n+z\n\\ No newline at end of file\n',
  ]
  const added = [
    ...addHunks.map(h => [h]),
    ...addHunks.slice(0, 2).flatMap(first => addHunks.map(second => [first, second])),
    ['@@ -0,0 +1 @@\n+x\n', '@@ -2,0 +2 @@\n+y\n', '@@ -3,0 +3 @@\n+z\n'],
  ].map(hunks => `diff --git a/g b/g\nnew file mode 100644\n--- /dev/null\n+++ b/g\n${hunks.join('')}`)
  const deleteHunks = ['@@ -1,2 +0,0 @@\n-a\n-b\n', '@@ -1 +0,0 @@\n-a\n', '@@ -2 +0,0 @@\n-b\n', '@@ -1 +0,0 @@\n-b\n', '@@ -1,2 +5,0 @@\n-a\n-b\n', '@@ -2 +1,0 @@\n-b\n']
  const deleted = [
    ...deleteHunks.map(h => [h]),
    ...deleteHunks.slice(1, 3).flatMap(first => deleteHunks.slice(1).map(second => [first, second])),
  ].flatMap(hunks => [`diff --git a/f b/f\ndeleted file mode 100644\n--- a/f\n+++ /dev/null\n${hunks.join('')}`, `--- a/f\n+++ /dev/null\n${hunks.join('')}`])
  const cases = [...added, ...deleted]

  it('places hunks of a new file as git does: the second of two hunks at the start of the file is rejected', () => {
    expect(ours(added.find(p => p.endsWith('@@ -0,0 +1 @@\n+x\n@@ -0,0 +2 @@\n+y\n'))!)).toBe('error')
    expect(ours(`diff --git a/g b/g\nnew file mode 100644\n--- /dev/null\n+++ b/g\n@@ -0,0 +1 @@\n+x\n@@ -2,0 +2 @@\n+y\n`)).toEqual({ f: before, g: 'x\ny\n' })
    expect(ours(`diff --git a/g b/g\nnew file mode 100644\n--- /dev/null\n+++ b/g\n@@ -0,0 +5,2 @@\n+x\n+y\n`)).toEqual({ f: before, g: 'x\ny\n' })
    expect(ours(`--- a/f\n+++ /dev/null\n@@ -1,2 +5,0 @@\n-a\n-b\n`)).toEqual({})
  })

  it.runIf(hasGit).each(cases.map((patch, i) => ({ i, patch })))('agrees with git apply: case $i', ({ patch }) => {
    const expected = real(patch)
    const actual = ours(patch)
    if (actual === 'error' && expected !== 'error') expect(diagnose(patch)).toMatch(/no context lines/)
    else expect(actual).toEqual(expected)
  })
})

/** The error message of this tool for `patch`, or `''` when it applies. */
function diagnose(patch: string): string {
  try {
    const files: Record<string, string> = { f: before }
    for (const op of parseUnifiedDiff(patch).ops) {
      if (op.kind === 'delete' && op.chunks !== undefined) applyToFile(op.path, files[op.path], op.chunks, 'unified')
    }
    return ''
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error)
  }
}
