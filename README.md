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

`*** Move to:` renames, stacked `@@ line` labels narrow the place, `*** End of File` pins a change to the end (unless all its unchanged and removed lines are blank, see Codex patches). A git or unified diff is accepted too. The result lists the files (`A`/`M`/`D`) and carries compact diffs for DSH's diff card.

## Behaviour

- **Checked before written.** Every file is resolved, read and patched in memory first; a dry run reports the same failures as a real run.
- **Read before write.** With DSH's `fs-observation-policy`, a file must have been read with the `read` tool (or `read_image`), and must not have changed since, before the patch may update, move or delete it. The patch's own writes count as reads, so the same file can be patched again.
- **Guarded steps.** Updates and added files are written first, then moves, then deletions. Every step is guarded by the version the patch expects: the version checked while preparing for existing files, the version our own step left for created and moved files. A file that changed in between is not overwritten, moved or removed; the patch fails with `PATCH_STALE`.
- **Undo on failure.** When a step fails, the earlier steps are undone in reverse order with the same guards, also after the call was aborted. A moved file is moved back and a deleted file is put back as the very same file (inode, bytes, permission bits); an updated file gets its text back. A file someone else changed or created meanwhile is left as it is, and our copy is kept and named (a moved file stays at its destination, a deleted one in its staging directory). The error names every such file and any file whose state is unknown; it says "No file had been changed" only when that is known.
- **Observations.** After a successful patch every changed file counts as read at its new version. After a failed one only the files the undo put back do; anything else must be read again.
- **Same bytes as the reference.** A Codex patch leaves the bytes codex-rs `apply-patch` would; a unified diff leaves the bytes plain `git apply` (without `--unidiff-zero`) would. Where that is not possible the patch fails with `PATCH_PARSE` or `PATCH_CONFLICT` instead of writing a different file. The accepted extras below are cases the reference rejects; the only cases the reference accepts and this tool refuses are context-free unified hunks away from the end of the file and hunks git would apply by joining lines (see Unified diffs).
- **Codex patches.** Markers, `@@` labels and paths are trimmed as Rust trims them (Unicode White_Space: U+0085 counts, a BOM does not); an operation's path is the rest of its header line without trailing whitespace, so `*** Add File:  x` names ` x`, as in codex-rs. A change is found with an exact match first, then tolerating trailing whitespace, surrounding whitespace (Unicode White_Space as Rust trims it: U+0085 counts, a BOM does not) and typographic punctuation, as in codex-rs; a tolerant match that fits more than one place is refused (codex-rs takes the first). Context lines keep the file's own text, so only `-`/`+` lines change. Untouched lines keep their own line ending (LF, CRLF or lone CR); new lines take the file's first line ending; the updated file always ends with a line ending. A change with only `+` lines is appended at the end of the file, also after an `@@` label. `@@ label` is the text after `@@ ` without trailing whitespace; `*** End of File` and `@@` count as markers only unindented. An unprefixed blank line is blank context; a change that matches nowhere is retried without its last blank line, as in codex-rs (a change left with no old lines is then inserted where the search stands, also with `*** End of File`). Extras: stacked `@@` labels, a first change without `@@`, an update with only `*** Move to:` (the file is moved byte for byte), several blank separator lines at the end of a change, text around `*** Begin Patch`/`*** End Patch`.
- **Unified diffs.** Lines match exactly, line endings and whitespace included: a CR in the diff belongs to its line, and `\ No newline at end of file` removes the LF of the line it follows, which must agree with the file. A marker is a line starting with `\ ` as git reads one (in any language; inside a hunk at least 12 bytes with its LF); any other line starting with `\` inside a hunk is a `PATCH_PARSE` error. git compares a marked line as a byte prefix, so it may match it against a line that has a newline and join the next line onto the new text; such a hunk is refused with `PATCH_CONFLICT`, and applied only where its marked line is the file's real last line without a newline. Hunk bodies are read by their header counts, so a body line such as `--- x` stays a change line; file headers count only between hunks. Hunks are placed as git places them, one after another and not necessarily in file order: a hunk whose header starts at line 0 or 1 must start at the beginning of the file, one without context lines after its last change must end at the end of the file (both, if both apply), otherwise the exact match nearest to the header's new line wins, the later one on a tie; lines an earlier hunk wrote are not matched again. When the anchoring fails the hunk is refused, never placed elsewhere. A hunk without any context lines (`git diff -U0`) applies only where its header points; plain `git apply` would move it to the end of the file, so it is refused with advice to add context or use the Codex format. Between a `+++` header and the first hunk only git header lines (`index`, mode and rename lines) of a `diff --git` section may stand, as for git; other text there, a blank line included, is a `PATCH_PARSE` error. A new file's hunks may have only `+` lines (git: "depends on old contents"). Header paths are taken exactly up to a TAB (git ends a path with a trailing space with one), `rename from`/`rename to` exactly after the prefix, and a `diff --git` line is split where both names agree. A deletion's hunks must remove the whole file. An unprefixed line inside a hunk, or more `-`/`+` lines than the header declares, is a `PATCH_PARSE` error with the line number. Extras: overstated counts at the end of the text or before the next hunk, `@@ @@` headers without numbers, prose, fences and blank lines around the diff and between hunks (git accepts nothing between hunks).
- **Files.** Codex changes must be in file order. Parent directories of new files and move destinations are created. A move without changes keeps the file itself, byte for byte with its mode (setuid, setgid and sticky included). A UTF-8 byte order mark belongs to the first line when matching, as for codex-rs and git; when the reference would refuse a change because of it (a first line written without the mark, which the read tool does not show), the change is applied after the mark. Either way the mark stays in the file, also after an undo.
- **Paths** are relative to the session's working directory, or absolute. The DSH sandbox fences writes like the native `write` tool; read-only mode refuses the whole patch up front.
- **Delete and move.** `ctx.fs` cannot rename or delete, so moves and deletions run one constant POSIX `sh` command through the session's shell, with the paths in environment variables and the call's sandbox policy. It relinks a file: `ln` gives it the new name (`ln` never replaces an existing name), and the old name is removed with `rm` only while `[ old -ef new ]` still says both name the same file; when that removal fails, the new name is removed again. The file keeps its inode, bytes and full mode. Move to relinks the source to the destination (creating missing parent directories with `mkdir -p`); with changes, the new text is then written through `ctx.fs` with the version the move left. The destination is taken as this patch's only after a stat, a read and a second stat agree that it holds the source's text. Delete File relinks the file into a private staging directory next to it (`.dsh-apply-patch-trash-<random>`, mode 700). A staging directory is used only when the relink's own `mkdir -m 700` created it; when the name exists already, another random name is tried (up to three), and a directory whose creation is unknown is never removed. The staged file must hold the bytes checked while preparing (SHA-256 over the whole file, binary included, read up to the size its first stat reported; a version change between read windows ends the check at once, and the call's abort signal ends it while applying, not while undoing); otherwise it is put back if its name is free, or kept and named, and the patch fails with `PATCH_STALE`. After the whole patch succeeded each staged file is checked again (version and bytes) and removed with `rm -f`, then its directory with `rmdir`, which removes only an empty directory; a staged file that changed is kept, and it and any directory that could not be removed are named in the result (`Note: …`). Undoing an added file stages it the same way, checked against the text written, and that staging is removed after the undo; an undone move or deletion counts as undone only when the file put back holds its text or bytes. Each relink stats the old name just before the command and runs only if it is still the expected version, then stats both names to learn the outcome, whatever the shell reported. In `workspace-write` mode every path the shell changes (the file, a move destination, a staging directory) must be inside the workspace or the temp directories, checked up front, also when the shell itself does not confine commands. Without a POSIX shell (none mounted, or Windows), patches with Delete File, Move to, or Add File together with other operations are refused with `PATCH_UNSUPPORTED` before anything is written; a patch that only updates files or adds one file works.
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

- Codex changes within one file must be listed in file order.
- A unified hunk without context lines applies only at the end of the file, where its header must point; elsewhere it is refused (plain `git apply` would move it to the end of the file). Send `git diff` output with context, or a Codex patch.
- Deleting a binary file needs an observation of it, which only `read_image` gives for images; delete other binary files with the shell.
- A move or deletion checks the file version and then runs the shell command; the two are not atomic (see Threat model). Closing that window needs a versioned rename in `ctx.fs`.
- Moves and deletions need hard links on the file system and the right to link the file (Linux `fs.protected_hardlinks` refuses linking another user's file unless it is readable and writable); where `ln` fails, the patch fails before changing that file. A file with several hard links keeps its other links.
- Staging directories appear in the file's directory for the duration of the call (and stay when their removal fails, a staged file changed, or an undo had to keep a copy; the result or error names them). Deleting a large file reads it twice more to compute its digest.
- Writes rely on `ctx.fs.writeText` either publishing atomically or failing; a write that reports failure is taken as not done.
- No `sandbox_permissions` escalation parameter: a write the sandbox denies fails with the `[sandbox: …]` marker.
- Codex `@@` labels are matched as single lines; a label that occurs earlier than intended in the file must be made more specific.
- A unified diff written without the CRs of a CRLF file, or without `\ No newline at end of file` for a file lacking its final newline, does not apply (as with git); the error says so and suggests the Codex format, which keeps line endings.
- Updates are written through `ctx.fs.writeText`, which replaces the file and keeps only its `0777` permission bits: an updated file, a moved file with changes, and their undo lose setuid, setgid and sticky bits and get a new inode. A file created by Add File gets the default mode of `ctx.fs`. A change by someone else that leaves exactly the text this patch wrote cannot be told apart from it.
- Delete File and Move to are unavailable on Windows.
- A header path with trailing spaces but no TAB after it (hand-written) keeps the spaces, as in git, and therefore usually names a file that does not exist.

## Threat model

The patch is protected against benign concurrent changes: an editor saving, a formatter, a watcher, another agent. Such a change is never overwritten, moved or removed, and a patch never reports success for a step that did not happen: every step checks the version it expects just before acting and stats the result afterwards. When a concurrent change makes a step or its undo impossible, the other party's file is left as it is, this patch's copy is kept under a named path, and the error says so.

A hostile process of the same user that swaps files, directories or symbolic links between a check and the single command that follows it is out of scope. `ctx.fs` has no atomic rename or delete, so short windows remain: a file swapped in between the version check and `ln` is moved or staged instead of ours (a staged one with other bytes is detected and put back or kept), a file put at the old name between `[ -ef ]` and `rm` (one system call) loses that name, and a staged file changed between its last check and `rm -f` (one command) is removed. An editor that writes the file in place while it is staged changes the staged file; its bytes then differ, so the file is put back or kept, never removed. A file being moved keeps such an edit at its destination, which is taken as this patch's only when it holds the source's text. An editor that saves by renaming a new file over the old name is seen by `[ -ef ]`, except within that single system call. A change that leaves exactly the bytes this patch expects cannot be told apart from them.
