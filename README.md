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
- **Read before write.** With DSH's `fs-observation-policy`, a file must have been read with the `read` tool, and must not have changed since, before the patch may update it. The patch's own writes count as reads, so the same file can be patched again.
- **Undo on failure.** Writes come first, removals last; when one fails, the earlier changes of the same patch are undone, and the error names anything that could not be restored (a removed binary file).
- **Locating changes.** Exact match first, then tolerating trailing whitespace, surrounding whitespace and typographic punctuation, as in codex-rs. A tolerant match that fits more than one place is refused. Unified hunk line numbers are hints: the nearest exact match wins. Changes must be in file order.
- **Files.** Line endings follow the file's majority; the final newline is kept unless a unified `\ No newline at end of file` marker says otherwise. Parent directories of new files are created.
- **Paths** are relative to the session's working directory, or absolute. The DSH sandbox fences writes like the native `write` tool; read-only mode refuses the whole patch up front.
- **Delete and move.** `ctx.fs` cannot delete, so Delete File and the source side of Move to run a constant `rm -f -- "$DSH_APPLY_PATCH_TARGET"` (PowerShell `Remove-Item` on Windows) through the session's shell with the call's sandbox policy. Without a shell such patches are refused before anything is written.
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
npm run check   # typecheck, tests (parsers, content, and real fs-local / fs-observation-policy / bash-local), build; lib/ must be committed up to date
```

`lib/` is committed so the package installs from a git checkout without a build.

## Known limitations

- Changes within one file must be listed in file order.
- A removed binary file cannot be restored if a later step of the same patch fails.
- No `sandbox_permissions` escalation parameter: a write the sandbox denies fails with the `[sandbox: …]` marker.
- Codex `@@` labels are matched as single lines; a label that occurs earlier than intended in the file must be made more specific.
