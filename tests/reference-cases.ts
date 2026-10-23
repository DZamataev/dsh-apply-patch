/**
 * Byte-exact expectations for one-file updates. Codex cases were produced by
 * the codex-rs `apply-patch` sources (streaming parser, `compute_replacements`,
 * `seek_sequence`, `text_file`); unified cases by plain `git apply` (without
 * `--unidiff-zero`). Cases marked `extension` are accepted here but rejected by
 * the reference, cases marked `stricter` are rejected here but accepted by the
 * reference; other `error` cases are rejected by both.
 */

/** One update of the file `f`. */
export interface ReferenceCase {
  name: string
  format: 'codex' | 'unified'
  before: string
  /** Codex: the lines between `*** Update File: f` and `*** End Patch`. Unified: the whole diff. */
  patch: string
  /** Expected file text, or a message fragment of the expected `PatchError`. */
  expected: string | { error: string; code: 'PATCH_PARSE' | 'PATCH_CONFLICT' }
  /** Accepted here although the reference rejects it. */
  extension?: true
  /** Rejected here although the reference accepts it. */
  stricter?: true
}

const git = (body: string) => `diff --git a/f b/f\n--- a/f\n+++ b/f\n${body}`

/** Every case, in finding order. */
export const referenceCases: ReferenceCase[] = [
  { name: 'explicit blank context after the last change stays context', format: 'codex', before: 'old\nmiddle\nold\n\n', patch: '@@\n-old\n+new\n ', expected: 'old\nmiddle\nnew\n\n' },
  { name: 'an unprefixed blank line before *** End Patch is tried as context first', format: 'codex', before: 'b\nx\nb\n\n', patch: '@@\n-b\n+B\n', expected: 'b\nx\nB\n\n' },
  { name: 'several blank separator lines are dropped when nothing else matches', format: 'codex', before: 'a\n\nb\n', patch: '@@\n a\n\n-b\n+B\n\n', expected: 'a\n\nB\n', extension: true },
  { name: 'a context line " *** End of File" is file text', format: 'codex', before: 'old\n*** End of File\nold\n', patch: '@@\n-old\n+new\n *** End of File', expected: 'new\n*** End of File\nold\n' },
  { name: 'an indented "*** End of File" is a context line', format: 'codex', before: 'a\n', patch: '@@\n-a\n+A\n   *** End of File', expected: { error: 'Could not find the lines', code: 'PATCH_CONFLICT' } },
  { name: '"*** End of File" with trailing spaces is the marker', format: 'codex', before: 'a\nb\na\n', patch: '@@\n-a\n+A\n*** End of File  ', expected: 'a\nb\nA\n' },
  { name: 'an @@ label keeps its leading indentation', format: 'codex', before: 'def f\nold\n    def f\nold\n', patch: '@@     def f\n-old\n+new', expected: 'def f\nold\n    def f\nnew\n' },
  { name: 'an @@ label loses its trailing whitespace', format: 'codex', before: 'head  \nold\n', patch: '@@ head  \n-old\n+new', expected: 'head  \nnew\n' },
  { name: '"@@" directly followed by text is not a label', format: 'codex', before: 'xhead\nold\n', patch: '@@xhead\n-old\n+new', expected: { error: '"@@ "', code: 'PATCH_PARSE' } },
  { name: 'a context line keeps the file spelling of trailing whitespace', format: 'codex', before: 'ctx  \nold\n', patch: '@@\n ctx\n-old\n+new', expected: 'ctx  \nnew\n' },
  { name: 'a context line keeps the file spelling of punctuation', format: 'codex', before: 'a\u2014b\nold\n', patch: '@@\n a-b\n-old\n+new', expected: 'a\u2014b\nnew\n' },
  { name: 'untouched lines keep their own line endings', format: 'codex', before: 'one\r\nold\r\ntail\n', patch: '@@\n-old\n+new', expected: 'one\r\nnew\r\ntail\n' },
  { name: 'new lines take the first line ending of the file', format: 'codex', before: 'a\r\nb\nc\n', patch: '@@\n-c\n+C\n+D', expected: 'a\r\nb\nC\r\nD\r\n' },
  { name: 'a lone CR ends a line', format: 'codex', before: 'a\rb\rc\r', patch: '@@\n-b\n+B', expected: 'a\rB\rc\r' },
  { name: '"*** End of File" followed by a blank line', format: 'codex', before: 'old\n', patch: '@@\n-old\n+new\n*** End of File\n', expected: 'new\n' },
  { name: 'a pure addition after an @@ label goes to the end of the file', format: 'codex', before: 'head\ntail\n', patch: '@@ head\n+new', expected: 'head\ntail\nnew\n' },
  { name: 'an update ends the file with a newline', format: 'codex', before: 'old', patch: '@@\n-old\n+new', expected: 'new\n' },
  { name: 'an update gives an inner unterminated line an ending', format: 'codex', before: 'a\nb', patch: '@@\n a\n+x', expected: 'a\nx\nb\n' },

  {
    name: 'hunk lines that look like a file header are payload while the counts last', format: 'unified',
    before: 'keep\n-- foo\n', patch: git('@@ -1,2 +1,2 @@\n keep\n--- foo\n+++ bar\n'), expected: 'keep\n++ bar\n',
  },
  {
    name: 'a CR in the diff payload belongs to the line', format: 'unified',
    before: 'one\r\nold\r\ntail\n', patch: git('@@ -1,3 +1,3 @@\n one\r\n-old\r\n+new\r\n tail\n'), expected: 'one\r\nnew\r\ntail\n',
  },
  { name: 'a CRLF line can be replaced by an LF line', format: 'unified', before: 'old\r\n', patch: git('@@ -1 +1 @@\n-old\r\n+new\n'), expected: 'new\n' },
  { name: 'an LF diff does not match CRLF lines', format: 'unified', before: 'old\r\n', patch: git('@@ -1 +1 @@\n-old\n+new\n'), expected: { error: 'CRLF', code: 'PATCH_CONFLICT' } },
  { name: 'an unprefixed line inside a hunk is rejected', format: 'unified', before: 'old\nold2\n', patch: git('@@ -1,2 +1,2 @@\n-old\n+new\nWRONG UNPREFIXED LINE\n-old2\n+new2\n'), expected: { error: 'line 7', code: 'PATCH_PARSE' } },
  { name: 'more change lines than the header declares are rejected', format: 'unified', before: 'keep\na\n', patch: git('@@ -1 +1 @@\n keep\n-a\n+b\n'), expected: { error: 'more', code: 'PATCH_PARSE' } },
  { name: 'removed lines must match exactly, whitespace included', format: 'unified', before: '    old\n', patch: git('@@ -1 +1 @@\n-old\n+new\n'), expected: { error: 'exactly', code: 'PATCH_CONFLICT' } },
  { name: 'a line without the final newline needs the marker', format: 'unified', before: 'a\nX', patch: git('@@ -1,2 +1,2 @@\n a\n-X\n+Y\n'), expected: { error: 'Could not find', code: 'PATCH_CONFLICT' } },
  {
    name: 'of two places equally far from the header line, the later one wins', format: 'unified',
    before: 'a\nk\nX\nk\nm\nk\nX\nk\ne\n', patch: git('@@ -4,3 +4,3 @@\n k\n-X\n+Y\n k\n'), expected: 'a\nk\nX\nk\nm\nk\nY\nk\ne\n',
  },
  {
    name: 'a hunk without trailing context goes to the end of the file', format: 'unified',
    before: 'a\nX\nq\na\nX\n', patch: git('@@ -2,2 +2,2 @@\n a\n-X\n+Y\n'), expected: 'a\nX\nq\na\nY\n',
  },
  {
    name: 'a hunk starting at line 1 goes to the start of the file', format: 'unified',
    before: 'a\nX\nb\nq\na\nX\nb\n', patch: git('@@ -1,3 +5,3 @@\n a\n-X\n+Y\n b\n'), expected: 'a\nY\nb\nq\na\nX\nb\n',
  },
  { name: 'an overstated count at the end of the diff is accepted', format: 'unified', before: 'old\n', patch: git('@@ -1,9 +1,9 @@\n-old\n+new\n'), expected: 'new\n', extension: true },

  { name: 'Rust trim_end strips NEL, so a line ending in U+0085 matches before a padded line', format: 'codex', before: 'old\u0085\nx\n old \n', patch: '@@\n-old\n+new', expected: 'new\nx\n old \n' },
  { name: 'Rust trim keeps a BOM, so a line ending in U+FEFF does not match', format: 'codex', before: 'old\uFEFF\nx\n old \n', patch: '@@\n-old\n+new', expected: 'old\uFEFF\nx\nnew\n' },
  { name: 'an end-of-file change whose only old line is blank inserts at the cursor', format: 'codex', before: 'a\nb\n', patch: '@@\n-\n+new\n*** End of File', expected: 'new\na\nb\n' },
  { name: 'an end-of-file change whose only old line is blank inserts after its label', format: 'codex', before: 'a\nb\nc\n', patch: '@@ a\n-\n+new\n*** End of File', expected: 'a\nnew\nb\nc\n' },
  { name: 'blank context and an addition at the end of the file insert at the cursor', format: 'codex', before: 'a\nb\n', patch: '@@\n \n+NEW\n*** End of File', expected: '\nNEW\na\nb\n' },
  { name: 'an @@ label keeps a trailing U+FEFF, which Rust does not trim', format: 'codex', before: 'header\nold\nheader\uFEFF\nold\n', patch: '@@ header\uFEFF\n-old\n+new', expected: 'header\nold\nheader\uFEFF\nnew\n' },
  { name: 'an @@ label loses a trailing U+0085, which Rust trims', format: 'codex', before: 'header\nold\nheader\u0085\nold\n', patch: '@@ header\u0085\n-old\n+new', expected: 'header\nnew\nheader\u0085\nold\n' },
  { name: '"@@" followed by U+0085 is a bare @@ line', format: 'codex', before: 'a\nold\n', patch: '@@\u0085\n-old\n+new', expected: 'a\nnew\n' },
  { name: '"*** End of File" followed by U+0085 is the marker', format: 'codex', before: 'a\nold\n', patch: '@@\n-old\n+new\n*** End of File\u0085', expected: 'a\nnew\n' },
  { name: 'a U+FEFF at the start of the text belongs to the first line', format: 'codex', before: '\uFEFFfirst\nold\nfirst\nold\n', patch: '@@ first\n-old\n+new', expected: '\uFEFFfirst\nold\nfirst\nnew\n' },

  { name: 'a hunk at line 1 with leading context must start at the beginning', format: 'unified', before: 'p\np\np\nA\nold\nB\n', patch: git('@@ -1,3 +1,3 @@\n A\n-old\n+new\n B\n'), expected: { error: 'start at the beginning of the file', code: 'PATCH_CONFLICT' } },
  { name: 'a hunk without trailing context must end at the end of the file', format: 'unified', before: 'q\na\nX\nb\n', patch: git('@@ -2,2 +2,2 @@\n a\n-X\n+Y\n'), expected: { error: 'end at the end of the file', code: 'PATCH_CONFLICT' } },
  { name: 'a hunk without context away from its header line is refused', format: 'unified', before: 'a\nX\nq\na\nX\n', patch: git('@@ -2,1 +2,1 @@\n-X\n+Y\n'), expected: { error: 'no context lines', code: 'PATCH_CONFLICT' }, stricter: true },
  { name: 'a hunk without context at the end of the file', format: 'unified', before: 'a\nX\nq\na\nX\n', patch: git('@@ -5,1 +5,1 @@\n-X\n+Y\n'), expected: 'a\nX\nq\na\nY\n' },
  { name: 'a -U0 insertion inside the file is refused', format: 'unified', before: '1\n2\n3\n', patch: git('@@ -2,0 +3 @@\n+X\n'), expected: { error: 'no context lines', code: 'PATCH_CONFLICT' }, stricter: true },
  { name: 'a -U0 insertion at the end of the file', format: 'unified', before: '1\n2\n3\n', patch: git('@@ -3,0 +4 @@\n+X\n'), expected: '1\n2\n3\nX\n' },
  { name: 'a -U0 insertion at line 1 needs an empty file', format: 'unified', before: 'a\nb\nc\n', patch: git('@@ -1,0 +3,1 @@\n+X\n'), expected: { error: 'cover the whole file', code: 'PATCH_CONFLICT' } },
  { name: 'a -U0 deletion of the last line', format: 'unified', before: 'a\nb\nc\n', patch: git('@@ -3 +2,0 @@\n-c\n'), expected: 'a\nb\n' },
  { name: 'a -U0 deletion inside the file is refused', format: 'unified', before: 'a\nb\nc\n', patch: git('@@ -2 +1,0 @@\n-b\n'), expected: { error: 'end at the end of the file', code: 'PATCH_CONFLICT' } },
  { name: 'the newline marker removes the LF of the line it follows', format: 'unified', before: 'old\n', patch: git('@@ -1,1 +1,2 @@\n-old\n+new\n\\ No newline at end of file\n+tail\n'), expected: 'newtail\n' },
  { name: 'the newline marker after an inner added line joins it to the next', format: 'unified', before: 'a\nb\n', patch: git('@@ -1,2 +1,3 @@\n a\n+x\n\\ No newline at end of file\n b\n'), expected: 'a\nxb\n' },
  {
    name: 'a later hunk may apply before an earlier one, nearest to its header line', format: 'unified',
    before: 'k\nX\nk\nA\nold\nB\nz\nz\nz\nz\nz\nk\nX\nk\nw\n', patch: git('@@ -4,3 +4,3 @@\n A\n-old\n+new\n B\n@@ -2,3 +4,3 @@\n k\n-X\n+Y\n k\n'),
    expected: 'k\nY\nk\nA\nnew\nB\nz\nz\nz\nz\nz\nk\nX\nk\nw\n',
  },
  {
    name: 'lines of an applied hunk, its context included, are not matched again', format: 'unified',
    before: 'p\nA\nold\nB\nold2\nC\nz\n', patch: git('@@ -2,3 +2,3 @@\n A\n-old\n+new\n B\n@@ -4,3 +4,3 @@\n B\n-old2\n+new2\n C\n'), expected: { error: 'Could not find', code: 'PATCH_CONFLICT' },
  },
]
