/**
 * Git and unified diff parser. It is lenient where models are sloppy:
 *
 * - text before the first header (prose, a ```diff fence, `Index:` lines) is skipped;
 * - hunk header counts are hints only: a hunk ends at the next header, and blank
 *   lines between hunks or at the end are separators;
 * - `@@ @@` and `@@` without line numbers are accepted;
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
/** Decode a git C-style quoted path, including octal UTF-8 escapes; unquoted text is returned as is. */
export declare function unquote(raw: string): string;
