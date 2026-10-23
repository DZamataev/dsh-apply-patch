# Changelog

## 1.0.2 (2026-10-24)

Codex patches now leave exactly the bytes of codex-rs `apply-patch`, unified diffs exactly those of `git apply`; where that is impossible the patch fails instead of writing a different file. Behaviour changes:

- Codex: context lines keep the file's text (no rewriting of whitespace or punctuation); every untouched line keeps its own line ending and new lines take the file's first one (was: majority rebuild of the whole file); lone CR ends a line; an updated file always ends with a line ending; a change with only `+` lines is appended at the end of the file, also after an `@@` label.
- Codex parser: a ` ` blank context line before the next operation is kept; unprefixed blank lines are blank context, dropped only when the change matches nowhere with them; `*** End of File` and `@@` count only unindented; `@@ label` keeps its leading indentation; `@@text` without a space is an error; a blank line after `*** End of File` is accepted.
- Unified: exact matching only (no whitespace or punctuation tolerance); a CR in the diff belongs to its line; `\ No newline at end of file` must agree with the file; git's anchoring and nearest-match tie rule; hunk bodies are read by their counts, so `--- x`/`+++ y` body lines are no longer taken for a file header that could route later hunks to another file; an unprefixed line inside a hunk and more change lines than declared are `PATCH_PARSE` errors (were: the rest of the patch silently skipped); a deletion's hunks must remove the whole file (was: any deletion header deleted the file).
- Detection: a `*** Begin Patch` context line inside a unified diff no longer makes it a Codex patch.
- Quoted git paths with characters outside the BMP decode correctly.
- A moved file keeps its source's permission bits, and a deleted file restored by an undo gets its bits back (POSIX shell `stat`/`chmod`); a failure to do so is named in the result.
- Tests: 30 byte-exact cases confirmed against the codex-rs sources and `git apply` (`tests/reference-cases.ts`), header-looking hunk lines, partial deletions, permission bits.

## 1.0.1 (2026-10-24)

- Delete File and the source of Move to require that the session read the file and that it did not change since, like Update File, also in a dry run.
- Every removal is version-guarded: the file is stat'ed just before the shell command and kept if it changed (including a move source overwritten between checking and committing, and a created file edited by someone else before the undo). The outcome is learned by stat'ing again, so a removal the shell reports as failed but that happened is recorded, and an undeterminable one is reported as unknown.
- Delete File and Move to refuse a symbolic link instead of removing its target; Add File refuses a dangling link.
- Undo keeps a move destination when the source could not be restored, runs without the call's abort signal, and reports each file it could not put back; the error no longer claims that nothing was changed when that is not known.
- A shell is required up front whenever undoing could need it (Add File together with other operations).
- In `workspace-write` mode a removal outside the workspace and temp directories is refused up front.
- After a failed patch, files the undo put back count as read at their restored version.
- Tool descriptions state what happens when an undo is impossible.
- Tests: version races, abort, uncertain shell outcomes, symbolic links, the fs sandbox in `workspace-write` mode, and exact output bytes of realistic Codex patches.

## 1.0.0 (2026-10-24)

First release of the fork, renamed `@local/dsh-apply-patch`. Differences from `dsh-patch-edit-plus` 0.4.3:

- Preset-only: no `dsh.bundle` layer, no Plugins-page settings card, no compatibility code for DSH 0.1.x; registration in the mounting scope fails on a name clash instead of renaming.
- Codex-oriented tool: parameter `input`, a description that teaches the Codex format with no routing to `edit`; Codex patches accepted by default.
- Read-before-write and staleness checked while preparing, so dry runs report them; the patch's own writes, deletes and moves are recorded as observations.
- Undo on failure instead of partial application; writes first, removals last.
- Delete and Move work: the shell is read with `ctx.get` (0.4.3 read `ctx.shell` without injecting it, so every Delete/Move failed); a move writes the destination through `ctx.fs` and refuses an existing destination; deleting a binary file works.
- Paths resolve against the session working directory; containment is left to the DSH sandbox like the native tools; read-only mode is refused up front; parent directories are created.
- Locating: exact match nearest to a unified hint (also before it), tolerant levels only when unambiguous, typographic punctuation level, `@@` labels honoured and stackable, first Codex chunk without `@@`, `*** End of File` for pure additions, git `-U0` insertions after the named line.
- Unified parser: lenient counts and blank separators, prose/fence preambles, tab timestamps, C-quoted paths, empty new/deleted files without hunks, renames only from git headers.
- Majority line endings, git-compatible final newline, compact display diffs, `PatchError` extends `HarnessError`, limits in UTF-8 bytes.
- Tests run against real `fs-local`, `fs-observation-policy` and `bash-local`.
