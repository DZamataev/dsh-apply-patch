# Changelog

## 1.1.7 (2026-10-27)

- Unified: names of a bare `---`/`+++` pair are read as `git apply` reads a traditional patch (`apply.c` `parse_traditional_patch`). Each name loses its first path component, whatever it is (was: only `a/` or `b/`, so `--- x/f`/`+++ x/f` patched `x/f` where git patches `f`, and `--- /x/f` patched the absolute path `/x/f` where git patches `x/f`); from names without a directory git guesses `-p0` (`guess_p_value`), so `--- f`/`+++ f` still patches `f`; a timestamp at the end of the line is not part of the name (`diff_timestamp_len`; was: `--- a/f 2010-07-05 19:41:17` named `f 2010-07-05 19:41:17`); of two differing names the `---` one is patched when it is a shorter prefix of the `+++` one (was: `--- a/f`/`+++ b/f.orig` patched `f.orig` where git patches `f`); an epoch timestamp after a TAB creates or deletes the file (`has_epoch_timestamp`; was: an update, so a new-file hunk with an epoch `---` timestamp was inserted into an existing file where git refuses). A pair where git finds no name (`--- f`/`+++ /dev/null`) or with `/dev/null` on both sides (git creates `dev/null`) is `PATCH_PARSE`.
- Unified: git keeps a guessed `-p0` for the rest of the patch and would read a later `diff --git a/f b/f` section with it (moving `a/f` over `b/f`) or a later `--- a/f`/`+++ b/f` pair (patching `b/f`); after such a guess a later `diff --git` line, and a later pair whose name has a directory, is `PATCH_PARSE` (was: read with `-p1`). An `@@ @@` hunk without line numbers names its file as git would with numbers and changes no guess for later sections.
- Unified: an `@@ @@` hunk without line numbers is placed with one Knuth-Morris-Pratt pass over the file (was: O(file lines × hunk lines); 1,000 identical context lines and one unique line at the end of 200,000 identical lines took 10.3 s, a stale hunk of 3,000 such lines 30.3 s to refuse, now 34 ms and 0.2 s); the place found is the same.
- README: bare-pair names, timestamps, the `-p0` guess and its refusals; the refused git-accepted cases now also list `/dev/null` names git reads as `dev/null`, a bare pair whose only hunk creates a missing file, and sections read with a guessed `-p0`.
- Tests: 42 bare-pair name cases, each checked against the installed `git apply`, 864 generated pairs (name forms × timestamps on both sides) and 64 generated two-section patches that must never apply differently from git; two performance bounds for unnumbered hunks.

## 1.1.6 (2026-10-27)

- Unified: a CR in the patch is read as git reads it. At the end of a CRLF `diff --git a/f b/f` line it belongs to the second name, so the line names no file by itself (was: the CR was dropped, so a CRLF section of only `diff --git` and `new file mode 100644` created an empty `f`, and one with `deleted file mode 100644` deleted an empty `f`, where `git apply` fails with "git diff header lacks filename information"; such sections, and a CRLF section named only by its `diff --git` line, are now `PATCH_PARSE`). A CR ends a `---`/`+++` or rename name also inside the line, and a hunk line holding only a CR is `PATCH_PARSE` as for git ("corrupt patch"; was: an empty context line). CRLF diffs that git applies apply as before.
- Unified: header names follow `apply.c`: the default name of a `diff --git` line is found as `git_header_name` finds it (a TAB also separates the names, any first path component is removed, a quoted first name with an unquoted second gives none; was: split at a space with only `a/`/`b/` removed, so `diff --git x/f x/f` with `new file mode` created `x/f` where git creates `f`); `---`/`+++` names in a `diff --git` section lose their first path component (`-p1`) and a name without `/` names nothing; quoted names are decoded as `unquote_c_style` decodes them, and a name it rejects is taken literally; `/dev/null` may be followed by whitespace; a mode followed by a vertical tab or form feed is invalid.
- Codex: each tolerance level searches the change with one Knuth-Morris-Pratt pass over the normalized lines (was: every candidate place was compared with the whole change, O(file lines × change lines); a valid change of 1,000 identical context lines and one unique line at the end of a 3.2 MB file of 200,000 identical rows took 2.6 s, now 26 ms, and a stale change of 3,000 such lines took 26.7 s to refuse, now 0.18 s). The first exact place, the tolerant candidates (up to five, in order), the ambiguity messages and `*** End of File` pinning are unchanged; the bytes are those of 1.1.5.
- Tests: 17 CR and header-name cases, each checked against the installed `git apply`, and generated CR variants of the git header cases that must never apply differently from git; three performance bounds for near matches in repetitive files.

## 1.1.5 (2026-10-26)

- Unified: a bare `---`/`+++` pair without hunks is skipped text, also with `/dev/null` on one side, as git skips it (was: `--- /dev/null`/`+++ b/f` created an empty `f` and `--- a/f`/`+++ /dev/null` deleted an empty `f` where `git apply` leaves the tree as it is; a diff of only such a pair was applied where git fails with "No valid patches in input" and is now `PATCH_PARSE`). A `diff --git` section with `new file mode` or `deleted file mode` still creates or deletes an empty file without hunks.
- Unified: many hunks in a large file apply in time proportional to the file plus the hunks (was: the whole file was joined, hashed and copied for every hunk; 200 three-line hunks took 2.6 s for a 2 MB file and 5.6 s for a 4 MB file, now 6 and 10 ms). The hunks replace lines in one line array, and a line is hashed only when a placement compares it; the bytes are those of 1.1.4.
- Codex: an exact match stops at the first place at or after the cursor, and the tolerant levels normalize each file line once and stop at the fifth candidate (was: every candidate of the file was collected; 200 changes with 40 identical context lines in a 3.2 MB file took 21 s, now 14 ms). An ambiguous tolerant match reports "5 or more places" beyond five; the bytes are those of 1.1.4.
- Tests: 14 bare-pair and empty-file cases, each also checked against the installed `git apply`; six performance bounds for large and repetitive files in both formats; 12 multi-hunk `git diff` outputs applied in order, reversed and shuffled, compared byte for byte with `git apply`.

## 1.1.4 (2026-10-26)

- Very large files and hunks apply: replacements are rebuilt with loops and the unified image with `concat` (was: `push(...lines)` and `splice(..., ...lines)` threw an unstructured `RangeError: Maximum call stack size exceeded` for a Codex update of a 250,000-line file or a unified hunk of 170,000 lines, and the file stayed unchanged).
- Unified: a negative mode (`old mode`, `new mode`, `new file mode`, `deleted file mode`, an `index` line) is refused with `PATCH_UNSUPPORTED` before anything is written (was: the sign was dropped, so `new mode -100644` patched the file where git fails with a type change, and `new file mode -100644` created a regular file where git creates a submodule directory). Modes are otherwise read as git's `strtoul` reads them: a `+` sign and leading zeros are accepted, an overlong value keeps its low 32 bits.
- Unified: an old mode (`old mode`, `deleted file mode`, an `index` line) that is a symbolic link, directory or submodule entry is refused with `PATCH_UNSUPPORTED` before anything is written; only regular files are patched (was: the type was ignored and the regular file patched, where git fails with "wrong type").
- Unified: a new file is built by placing its hunks against an empty file as git places hunks of an update (was: all hunks were concatenated, so a second hunk that again started at line 0 was appended where git rejects it). A context-free hunk whose old lines span the whole current text (a new file's first hunk, a deletion of the whole file) applies whatever line its header names, as with git.
- README: the byte order mark fallback is listed as an extra of both formats; negative modes and non-regular old modes are listed among the git-accepted patches this tool refuses; Known limitations notes that the old mode is not compared with the file's mode, which `ctx.fs` does not report.
- Tests: large Codex and unified inputs end to end, 23 more mode-line cases and 66 generated new-file and deletion hunk cases, each checked against the installed `git apply`.

## 1.1.3 (2026-10-24)

- Unified: a `diff --git` header that would change or set a file mode is refused with `PATCH_UNSUPPORTED` before anything is written, also in a dry run, and the whole patch is refused: a `new mode` line that differs from the old mode or comes without one, with or without hunks, next to other files or a rename, and a `new file mode` other than `100644` (executable, symbolic link, submodule entry). Was: a pure mode change failed with `PATCH_PARSE: the diff contains no file changes`, or was silently dropped next to other files; a mode change with hunks applied only the text; an executable or symbolic link new file was created as a regular non-executable file. `git apply` changes the mode in all these cases, and this tool cannot.
- Unified: modes are compared as git canonicalizes them (`100664` is `100644`), so `old mode 100644` with `new mode 100664` is no mode change.
- README: mode changes are listed among the git-accepted patches this tool refuses, and under Known limitations.
- Tests: 23 mode-line cases, each checked against the installed `git apply` for the resulting modes and texts, and an integration test that a refused mode change writes nothing.

## 1.1.2 (2026-10-24)

- The staged-file digest reads a file only up to the size its first stat reported, stops as soon as the file's version changes between read windows, and honours the call's abort signal while applying (was: an unbounded read that a growing file could keep going).
- Dry runs and real runs check `workspace-write` containment up front for every write target: an added file, a changed updated file and a move destination; a dry run now reports the sandbox denial instead of succeeding.
- Unified: git header lines are read only right after a `diff --git` line, up to the first line that is not one, as `git apply` reads them. After a hunk or before a bare `---`/`+++` pair, `rename from`/`rename to`, `new file mode`, `deleted file mode`, `copy from`/`copy to`, mode, `similarity index` and `index` lines are skipped text (was: a `rename from`/`rename to` after a hunk moved the file, and `deleted file mode` after a hunk deleted it).
- Unified: in a `diff --git` header, `---`/`+++` names must agree with earlier lines, `/dev/null` needs `new file mode`/`deleted file mode`, a rename needs both `rename from` and `rename to`, modes must be octal, new file, deleted file and rename exclude each other, and a section without a hunk right after its header lines must be a new file, a deletion, a rename or a mode change; each violation is a `PATCH_PARSE` error, as git rejects it. Differing old and new names in a `diff --git` section move the file, as with git. A `diff --git` line without header lines is skipped text, and a hunk without a file header is a `PATCH_PARSE` error.
- README: the Codex blank-tail extra and the unified last-line-without-LF extra are stated precisely.
- Tests: 46 git header cases, each also checked against the installed `git apply`.

## 1.1.1 (2026-10-24)

- Delete File verifies the staged file: it must hold the bytes checked while preparing (SHA-256 over the whole file, binary included). A file edited in place while it was staged is put back when its name is free, or kept and named, and the patch fails with `PATCH_STALE` (was: the edit travelled into staging and was removed while the result said deleted). Undoing an added file checks the staged copy against the text written.
- Staged files are removed one by one with `rm -f`, each after checking its version and bytes again, and then their directory with `rmdir` (was: `rm -rf` of the whole staging directory); a staged file that changed is kept and named in the result.
- A staging directory is used only when this patch's own `mkdir` created it; an existing name gets a new random name (up to three tries), and a directory whose creation is unknown is never removed (was: an existing directory was adopted and removed with its contents, and the error said no file had been changed).
- An undone move or deletion counts as undone only when the file put back holds its text or bytes; otherwise the error names it (was: an unverifiable move-back was reported as undone).
- Unified: `\ No newline at end of file` markers are recognized as git recognizes them (a line starting with `\ `, at least 12 bytes inside a hunk); another line starting with `\` inside a hunk is a `PATCH_PARSE` error, and after a hunk it is skipped as git skips it (was: any line starting with `\` removed the newline).
- Unified: a hunk with a marked line that git would match against a line with a newline, joining the next line onto the new text, is refused with `PATCH_CONFLICT` (was: applied at the file's real end, a different place than git).
- Unified: a new file whose hunks have context or removed lines is refused, as git refuses it; text between a `+++` header and the first hunk is a `PATCH_PARSE` error, except git header lines in a `diff --git` section.
- Tool description: `*** End of File` notes that a change whose unchanged and removed lines are all blank is inserted at the current position.
- Tests: in-place edits during and after staging, a pre-existing staging directory, a staging directory of unknown origin, an unverifiable move-back, 11 new byte-exact reference cases checked against `git apply`.

## 1.1.0 (2026-10-24)

Delete File and Move to change semantics: files are relinked instead of rewritten and removed, and no permission bits are read or set any more.

- Move to relinks the source to the destination with one constant `sh` command (`ln`, which never replaces an existing name, then `rm` of the old name only while `[ old -ef new ]` holds; missing parent directories are created with `mkdir -p`). The moved file keeps its inode, bytes (a UTF-8 byte order mark included) and full mode, setuid, setgid and sticky included (were: the text was rewritten at the destination and the mode copied with `stat`/`chmod`, which dropped the special bits on BSD and lost the mark). With changes, the new text is written to the destination afterwards, guarded by the version the move left. The destination is taken as this patch's only when a stat, a read and a second stat agree it holds the source's text.
- Delete File relinks the file into a private staging directory next to it (`.dsh-apply-patch-trash-<random>`, mode 700), removed after the whole patch succeeded. An undo relinks it back, so a deleted file, binary included, is restored byte for byte with its mode and inode (was: text files rewritten with the default mode plus `chmod`, binary files lost).
- Undoing an added file stages it the same way and removes the staging afterwards (was: `rm`); undoing a move relinks the destination back. When a name was taken again or a file changed meanwhile, the other file is left as it is and this patch's copy is kept and named; an undo step reports success only when the file put back was verified (was: a restore whose result could not be verified counted as done, so a move destination, the only copy, could be removed).
- Without a POSIX shell (none mounted, or Windows), Delete File, Move to, and Add File together with other operations are refused with `PATCH_UNSUPPORTED` (Windows used PowerShell `Remove-Item`).
- In `workspace-write` mode a move destination and every staging path must be inside the workspace or the temp directories too.
- Update keeps a UTF-8 byte order mark, also when an undo restores the text (`readText` drops it, so it was lost). The mark belongs to the first line when matching, as in codex-rs and git; where the reference would refuse a change because of it, the change is applied after the mark.
- Codex: every trim of markers, `@@` labels, `*** End of File` and paths uses Rust's whitespace (U+0085 is whitespace, U+FEFF is not); `@@ label` used JavaScript's `trimEnd`, so a label ending in U+FEFF matched an earlier line and the wrong occurrence was edited. An operation's path keeps whitespace after the marker's space, as in codex-rs (`*** Add File:  x` names ` x`; was trimmed).
- README: threat model, staging, hard-link requirements.
- Tests: setuid and sticky bits, inodes and BOM bytes through moves and undone deletions, binary restore, staging cleanup, a destination created after the check, a file replaced while it is being staged, names taken again before an undo, Rust whitespace in markers, labels and paths.

## 1.0.3 (2026-10-24)

- Unified diffs follow plain `git apply` (no `--unidiff-zero`) throughout: a hunk at line 0 or 1 must start at the beginning of the file and a hunk without trailing context must end at its end, with no fallback to another exact match (was: any exact match when the anchoring failed); context-free hunks are anchored too (were read as `-U0` and placed by the header). Hunks are applied one after another to the current text, may come out of file order, and do not match lines an earlier hunk wrote, as in git.
- A unified hunk without any context lines applies only where git and its header agree (in practice at the end of the file); otherwise it is refused with advice to add context or use the Codex format, instead of writing what git would (the change moved to the end of the file).
- `\ No newline at end of file` removes the LF of the line it follows (was: of the last line of that side), so git's bytes result also for a marker in the middle of a hunk or of a new file.
- Unified paths: header paths are kept exactly up to the TAB (trailing and leading spaces were trimmed, so `f ` patched `f`), `rename from`/`rename to` exactly after the prefix, and a `diff --git` line with spaces in its names is split where both names agree.
- Codex: the tolerant whitespace levels trim Unicode White_Space as Rust does (U+0085 counts, U+FEFF does not); a change left with no old lines after dropping its last blank line is inserted at the search position, also with `*** End of File` (was: appended at the end), as in codex-rs.
- Permission bits: the mode of a file to be deleted or moved is read while preparing; when it cannot be read the patch is refused before anything is written (was: the file was deleted and an undo restored it with the default mode while reporting a complete undo). After a `chmod` the file's new version is taken as this patch's only if the file still holds the patch's text; otherwise it is not recorded as read, an undo leaves it alone, and it is named (was: a concurrent rewrite right after the `chmod` was adopted and could be deleted by an undo).
- Tests: 18 new byte-exact reference cases checked against plain `git apply` and the codex-rs sources, exact paths from real `git diff` output, out-of-order and overlapping hunks, unreadable modes, a rewrite right after `chmod`.

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
