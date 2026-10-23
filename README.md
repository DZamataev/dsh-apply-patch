# dsh-apply-patch

A Codex-style `apply_patch` tool for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH), meant for GPT models that were trained on OpenAI's Codex patch format. It is mounted inside an Agent Preset, so only the Agents of that preset get it.

Fork of [drscrewdriver/dsh-patch-edit-plus](https://github.com/drscrewdriver/dsh-patch-edit-plus) 0.4.3, largely rewritten; see [NOTICE.md](NOTICE.md) and [CHANGELOG.md](CHANGELOG.md).

## What the model sees

One tool, `apply_patch`, with `input` (the whole patch) and an optional `dry_run`. The description teaches the Codex format:

```
*** Begin Patch
*** Update File: path/to/file.py
@@ def greet():
-    print("Hi")
+    print("Hello")
*** Add File: path/to/new.py
+print("new file")
*** Delete File: path/to/old.py
*** End Patch
```

`*** Move to:` renames, stacked `@@ line` labels narrow the place, `*** End of File` pins a change to the end. A git or unified diff is accepted too. The result lists the files (`A`/`M`/`D`) and carries compact diffs for DSH's diff card.

## Behaviour

- **Checked before written.** Every file is resolved, read and patched in memory first; a dry run reports the same failures as a real run.
- **Read before write.** With DSH's `fs-observation-policy`, a file must have been read with the `read` tool (or `read_image`), and must not have changed since, before the patch may update, move or delete it. The patch's own writes count as reads, so the same file can be patched again.
- **Guarded steps.** Writes come first, removals last. Every step is guarded by the version the patch expects: the version checked while preparing for existing files, the version of our own write for created files. A file that changed in between is not overwritten or removed; the patch fails with `PATCH_STALE`.
- **Undo on failure.** When a step fails, the earlier steps are undone in reverse order with the same guards, also after the call was aborted. A file someone else changed meanwhile is left as it is; a move destination is kept when the source could not be put back, so the moved text is never lost. The error names every such file, a removed binary file (it cannot be restored), and any file whose state is unknown; it says "No file had been changed" only when that is known.
- **Observations.** After a successful patch every changed file counts as read at its new version. After a failed one only the files the undo put back do; anything else must be read again.
- **Locating changes.** Exact match first, then tolerating trailing whitespace, surrounding whitespace and typographic punctuation, as in codex-rs. A tolerant match that fits more than one place is refused. Unified hunk line numbers are hints: the nearest exact match wins. Changes must be in file order.
- **Files.** Line endings follow the file's majority; the final newline is kept unless a unified `\ No newline at end of file` marker says otherwise. Parent directories of new files are created.
- **Paths** are relative to the session's working directory, or absolute. The DSH sandbox fences writes like the native `write` tool; read-only mode refuses the whole patch up front.
- **Delete and move.** `ctx.fs` cannot delete, so removals (Delete File, the source of Move to, and undoing a created file) run a constant `rm -f -- "$DSH_APPLY_PATCH_TARGET"` (PowerShell `Remove-Item` on Windows) through the session's shell with the call's sandbox policy. Each removal stats the file first and runs only if it is still the expected version, then stats it again to learn the outcome, whatever the shell reported. In `workspace-write` mode a file outside the workspace and the temp directories is refused up front, also when the shell itself does not confine commands. Without a shell, patches with Delete File, Move to, or Add File together with other operations are refused before anything is written, because a created file could not be removed again on failure; a patch that only adds one file works.
- **Symbolic links.** Update and Add write through a link to its target, like the native `write` tool. Delete File and Move to refuse a path that is itself a symbolic link (the link is never followed to remove its target); a file reached through a linked directory is handled normally. Add File refuses a path where a dangling link exists.
- **Errors** are `PatchError` (a DSH `HarnessError`), so the tool result carries `{ name, code }`: `PATCH_PARSE`, `PATCH_CONFLICT`, `PATCH_NOT_OBSERVED`, `PATCH_STALE`, `PATCH_SANDBOX`, `PATCH_IO`, `PATCH_UNSUPPORTED`, `PATCH_LIMIT`.

## Use

Install it as a plain dependency of the DSH profile (not a bundle; the package deliberately has no `dsh.bundle`), then add a row to an Agent Preset:

```yaml
- id: apply-patch
  name: '@local/dsh-apply-patch'
```

Disable the native `edit`/`write` in that preset (`dsh-tool-fs` with `write: false, edit: false`) if the model should use only `apply_patch`. A second tool named `apply_patch` in the same scope makes the row fail to load.

| Option | Default | Meaning |
|---|---|---|
| `toolName` | `apply_patch` | Tool name |
| `allowCodexPatch` | `true` | Accept Codex patches |
| `allowUnifiedDiff` | `true` | Accept git/unified diffs |
| `maxFiles` | `50` | File operations per patch |
| `maxPatchBytes` | `524288` | Patch size in UTF-8 bytes |
| `maxDiffBytes` | `16384` | Display diff size per file |

## Develop

```sh
npm install --legacy-peer-deps
npm run check   # typecheck, tests (parsers, content, exact output bytes, and real fs-local or fs-sandbox + sandbox-policy / fs-observation-policy / bash-local), build; lib/ must be committed up to date
```

`lib/` is committed so the package installs from a git checkout without a build.

## Known limitations

- Changes within one file must be listed in file order.
- A removed binary file cannot be restored if a later step of the same patch fails. Deleting a binary file needs an observation of it, which only `read_image` gives for images; delete other binary files with the shell.
- A removal checks the file version and then runs the shell command; the two are not atomic, so a change made in that short window is lost. Closing it needs a versioned delete in `ctx.fs`.
- Writes rely on `ctx.fs.writeText` either publishing atomically or failing; a write that reports failure is taken as not done.
- No `sandbox_permissions` escalation parameter: a write the sandbox denies fails with the `[sandbox: …]` marker.
- Codex `@@` labels are matched as single lines; a label that occurs earlier than intended in the file must be made more specific.
