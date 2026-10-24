import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

/** Apply `patch` to `f` = `before` in memory. */
function ours(patch: string): Outcome {
  const files: Record<string, string> = { f: before }
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

/** Apply `patch` with `git apply` in a fresh repository. */
function real(patch: string): Outcome {
  const dir = mkdtempSync(join(tmpdir(), 'ap-git-headers-'))
  try {
    spawnSync('git', ['init', '-q'], { cwd: dir })
    writeFileSync(join(dir, 'f'), before)
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
