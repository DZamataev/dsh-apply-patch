/**
 * Git and unified diff parser.
 *
 * A hunk body is read by its header counts: while the hunk still expects old
 * or new lines, every ` `, `-` or `+` line is payload, also one that looks like
 * a `---`/`+++` file header, and a blank line is an empty context line.
 * `\ No newline at end of file` may follow any hunk line and removes the LF of
 * that line only, as in git. A CR before the LF belongs to the line, as in git:
 * to a hunk line's text, so a line holding only a CR is not a hunk line; to
 * the second name of a `diff --git` line, so a CRLF `diff --git a/f b/f` line
 * names no file by itself (`apply.c` `git_header_name`); and it ends a
 * `---`/`+++` or rename name, as `find_name` reads them. In a `diff --git`
 * section `---`/`+++` names lose their first path component and rename names
 * none, as git reads them with `-p1`.
 * File headers are recognized only between hunks. Git header lines (`index`,
 * modes, `new file mode`, `deleted file mode`, renames, `---`/`+++`) are read
 * only right after a `diff --git` line, up to the first line that is not one,
 * as `apply.c` `parse_git_diff_header` reads them; anywhere else (after a hunk,
 * before a bare `---`/`+++` pair) they are text git skips. A `diff --git` line
 * without header lines is such text too. A `diff --git` section without a hunk
 * right after its header lines must be a new file, a deletion or a rename.
 * Between a bare `+++` header and the first hunk nothing may stand. Modes are
 * read and canonicalized as git reads them; a header that would change a
 * file's mode (`new mode` differing from the old mode or without one), create
 * anything but a non-executable regular file (`new file mode` other than
 * `100644`), or patch anything but a regular file (an old mode of `old mode`,
 * `deleted file mode` or an `index` line that is a symbolic link, directory or
 * submodule entry) is refused with `PATCH_UNSUPPORTED`, because the tool
 * writes regular file contents only; so is a negative mode, which git wraps
 * around to another mode. The old mode is not compared with the file's mode,
 * which `ctx.fs` does not report. A new file is the result of its hunks placed
 * against an empty file as git places them, so git's rejections apply. The
 * parser is lenient where models are sloppy, but never so that lines are
 * silently dropped:
 *
 * - text before the first header and between files (prose, a ```diff fence, `Index:` lines) is skipped;
 * - a hunk may end before its counts are reached at the end of the text, at the next hunk header or at `diff --git`; its trailing unprefixed blank lines (also lines holding only a CR) are then separators. Such a hunk is rejected when its body contains a `---`/`+++` pair, which may have been the next file's header;
 * - an unprefixed line inside a counted hunk, and a `-` or `+` line right after a hunk whose counts are reached, are rejected with their line number;
 * - a line starting with `\` is a newline marker only as git reads one ({@link isMarker}); inside a hunk any other such line is rejected, after a hunk it is skipped like other text there;
 * - `@@ @@` and `@@` without line numbers are accepted; such a hunk ends at the first line that is not ` `, `-`, `+` or `\`, or at a `---`/`+++` pair;
 * - the last line of the text may lack its LF (git rejects such a diff as corrupt);
 * - a path ends at a TAB (git writes one after a path ending in a space; `diff -u` puts a timestamp after it), a CR or the end of the line; spaces around it are part of the path. Quoted C-style paths are decoded as git `unquote_c_style` decodes them; text after the closing quote is ignored.
 *
 * In a `diff --git` section the file moves when its old and new names differ
 * (`rename from`/`rename to`, or differing `---`/`+++` names), as with git;
 * `---`/`+++ /dev/null` there needs the `new file mode`/`deleted file mode`
 * line. Two differing names of a bare `---`/`+++` pair (`foo.c.orig` and
 * `foo.c`) patch the `+++` file. A bare pair creates (`--- /dev/null`) or
 * deletes (`+++ /dev/null`) a file only with hunks; without hunks it is text
 * git skips, so an empty file is created or deleted only by a `diff --git`
 * section with `new file mode` or `deleted file mode`.
 * @module dsh-apply-patch/parse/unified
 */
import type { ParsedPatch } from './types.js';
/**
 * Parse a git or unified diff.
 * @param text - the diff text.
 * @returns the parsed patch.
 * @throws {@link PatchError} `PATCH_PARSE` with the failing line,
 * `PATCH_UNSUPPORTED` for a header that would change or set a file mode or
 * patch anything but a regular file, `PATCH_CONFLICT` for hunks of a new file
 * that git would not place.
 */
export declare function parseUnifiedDiff(text: string): ParsedPatch;
/**
 * Decode a git C-quoted path as `unquote_c_style` does, including octal UTF-8 escapes.
 * @param text - a whole quoted path (`"…"`), or an unquoted path.
 * @returns the decoded path; text that is not one valid quoted name is returned unchanged, spaces included.
 */
export declare function unquote(text: string): string;
