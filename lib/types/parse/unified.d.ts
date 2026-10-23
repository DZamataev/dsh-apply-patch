/**
 * Git and unified diff parser.
 *
 * A hunk body is read by its header counts: while the hunk still expects old
 * or new lines, every ` `, `-` or `+` line is payload, also one that looks like
 * a `---`/`+++` file header, and a blank line is an empty context line.
 * `\ No newline at end of file` may follow any hunk line. A CR before the LF
 * belongs to the line, as in git. File headers and git metadata are recognized
 * only between hunks. The parser is lenient where models are sloppy, but never
 * so that lines are silently dropped:
 *
 * - text before the first header and between files (prose, a ```diff fence, `Index:` lines) is skipped;
 * - a hunk may end before its counts are reached at the end of the text, at the next hunk header or at `diff --git`; its trailing unprefixed blank lines are then separators. Such a hunk is rejected when its body contains a `---`/`+++` pair, which may have been the next file's header;
 * - an unprefixed line inside a counted hunk, and a `-` or `+` line right after a hunk whose counts are reached, are rejected with their line number;
 * - `@@ @@` and `@@` without line numbers are accepted; such a hunk ends at the first line that is not ` `, `-`, `+` or `\`, or at a `---`/`+++` pair;
 * - a tab-separated timestamp after a path is dropped, and quoted C-style paths are decoded.
 *
 * A file is renamed only by git `rename from`/`rename to` headers. Two differing
 * `---`/`+++` names without them (`foo.c.orig` and `foo.c`) patch the `+++` file.
 * @module dsh-apply-patch/parse/unified
 */
import type { ParsedPatch } from './types.js';
/**
 * Parse a git or unified diff.
 * @param text - the diff text.
 * @returns the parsed patch.
 * @throws {@link PatchError} `PATCH_PARSE` with the failing line.
 */
export declare function parseUnifiedDiff(text: string): ParsedPatch;
/** Decode a git C-style quoted path, including octal UTF-8 escapes, by code point; unquoted text is returned trimmed. */
export declare function unquote(raw: string): string;
