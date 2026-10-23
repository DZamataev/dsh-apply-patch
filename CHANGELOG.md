# Changelog

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
