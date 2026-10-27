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
 * none, as git reads them with `-p1`. Names of a bare `---`/`+++` pair are
 * read as `parse_traditional_patch` reads them ({@link bareNames}): with
 * `-p1`, or `-p0` where git guesses it from names without a directory, and
 * without a trailing timestamp; after a guessed `-p0`, which git keeps for the
 * rest of the patch, a later `diff --git` line or a later name with a
 * directory is refused.
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
 * - `@@ @@` headers without line numbers are accepted where git rejects the whole patch: git skips such a hunk as text, so a patch that also has a numbered hunk or a new file, deletion or rename section (which git would apply) is rejected. Such a hunk ends at the first line that is not ` `, `-`, `+` or `\`, or at a `---`/`+++` pair;
 * - the last line of the text may lack its LF (git rejects such a diff as corrupt);
 * - a path ends at a TAB (git writes one after a path ending in a space; `diff -u` puts a timestamp after it), a CR or the end of the line; spaces around it are part of the path, except before a timestamp ending a bare `---`/`+++` line. Quoted C-style paths are decoded as git `unquote_c_style` decodes them; text after the closing quote is ignored.
 *
 * In a `diff --git` section the file moves when its old and new names differ
 * (`rename from`/`rename to`, or differing `---`/`+++` names), as with git;
 * `---`/`+++ /dev/null` there needs the `new file mode`/`deleted file mode`
 * line. A bare pair creates (`--- /dev/null`, or an epoch `---` timestamp)
 * or deletes (`+++ /dev/null`, or an epoch `+++` timestamp) a file only with
 * hunks; without hunks it is text
 * git skips, so an empty file is created or deleted only by a `diff --git`
 * section with `new file mode` or `deleted file mode`.
 * @module dsh-apply-patch/parse/unified
 */
import { applyChunks } from '../apply/content.js';
import { PatchError, parseError } from '../errors.js';
import { gitPathProblem, hasLoneSurrogate } from './gitpath.js';
const HUNK = /^@@(?: -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))?)? ?@@/;
/**
 * Parse a git or unified diff.
 * @param text - the diff text.
 * @returns the parsed patch.
 * @throws {@link PatchError} `PATCH_PARSE` with the failing line,
 * `PATCH_UNSUPPORTED` for a header that would change or set a file mode or
 * patch anything but a regular file, `PATCH_CONFLICT` for hunks of a new file
 * that git would not place.
 */
export function parseUnifiedDiff(text) {
    const lines = text.split('\n');
    const sections = [];
    let current;
    /** Line number of the first text after a bare `+++` header that is not an `@@` hunk header. */
    let stray;
    /** Line of the bare pair from whose names git guessed `-p0` (`guess_p_value`); git reads every later section with it. */
    let guessedAt;
    /** Line of the first `@@ @@` hunk without line numbers, which git skips as text. */
    let unnumberedAt;
    /** Line of the first numbered hunk or new file, deletion or rename `diff --git` section: something git reads. */
    let gitReadsAt;
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (line.startsWith('diff --git ')) {
            if (guessedAt !== undefined) {
                throw parseError(i + 1, `git apply guessed "-p0" from the names without a directory of the "---"/"+++" pair at line ${guessedAt} and reads this "diff --git" section with it too, keeping "a/" and "b/" in its names (or failing). Write the earlier pair as "--- a/<path>" and "+++ b/<path>", or send it as a "diff --git" section`);
            }
            const header = parseGitHeader(lines, i);
            stray = undefined;
            const next = header.next < lines.length ? withoutCr(lines[header.next]) : undefined;
            if (next !== undefined && (next.startsWith('Binary files ') || next === 'GIT binary patch'))
                throw parseError(header.next + 1, 'binary patches are not supported');
            if (header.next === i + 1) {
                // Without header lines git reads the "diff --git" line as text; a hunk right after it has no file header.
                current = undefined;
                i += 1;
                continue;
            }
            sections.push(current = header.section);
            // git applies a new file, deletion or rename even where its hunks are unnumbered and skipped.
            if (header.metadata)
                gitReadsAt ??= header.section.start;
            i = header.next;
            if (next !== undefined && HUNK.test(next))
                continue;
            if (!header.metadata) {
                throw header.section.newPath !== null
                    ? parseError(i + 1, 'text between the "+++" header and the first "@@" hunk header; git apply rejects it. Put the "@@" line right after the "+++" line')
                    : parseError(i < lines.length ? i + 1 : header.section.start, `the "diff --git" section at line ${header.section.start} has no "@@" hunk right after its header lines and no new file, deleted file or rename line; git apply rejects it`);
            }
            // A section without hunks (a rename, a new or deleted empty file) ends with its header lines.
            current = undefined;
            continue;
        }
        if (isFileHeader(lines, i)) {
            const bare = { first: line.slice(4), second: lines[i + 1].slice(4), p: guessedAt === undefined ? 1 : 0, guessedAt };
            const next = i + 2 < lines.length ? HUNK.exec(lines[i + 2]) : null;
            if (next !== null && guessedAt === undefined && guessPair(bare.first, bare.second) === 0) {
                bare.p = 0;
                // git guesses only for a pair followed by "@@ -"; an unnumbered hunk (an extra) is read as if numbered, without changing later sections.
                if (next[1] !== undefined)
                    guessedAt = i + 1;
            }
            current = { start: i + 1, git: false, bare, newFile: false, deletedFile: false, chunks: [] };
            sections.push(current);
            stray = i + 2 < lines.length && HUNK.test(lines[i + 2]) ? undefined : i + 3;
            i += 2;
            continue;
        }
        const hunk = HUNK.exec(line);
        if (hunk !== null) {
            if (stray !== undefined)
                throw parseError(stray, 'text between the "+++" header and the first "@@" hunk header; git apply rejects it. Put the "@@" line right after the "+++" line');
            if (current === undefined)
                throw parseError(i + 1, 'the "@@" hunk has no file header; put "--- a/<path>" and "+++ b/<path>" lines (or "diff --git" header lines) right before it');
            const parsed = parseHunk(lines, i, hunk);
            if (hunk[1] === undefined)
                unnumberedAt ??= i + 1;
            else
                gitReadsAt ??= i + 1;
            current.chunks.push(parsed.chunk);
            i = parsed.next;
            continue;
        }
        // Anything else outside a git header (prose, fences, blank separators, git header lines after a hunk) is skipped, as git skips it.
        i += 1;
    }
    if (unnumberedAt !== undefined && gitReadsAt !== undefined) {
        throw parseError(unnumberedAt, `the "@@" hunk header has no line numbers, and git apply skips such a hunk as text and reads the rest of this patch (from line ${gitReadsAt}) without it. Add line numbers to every "@@" header ("@@ -<old start>,<count> +<new start>,<count> @@"), or use the Codex format`);
    }
    const ops = sections.map(toOp).filter((op) => op !== null);
    if (ops.length === 0)
        throw parseError(0, 'the diff contains no file changes');
    return { format: 'unified', ops };
}
/**
 * Read the header lines of a `diff --git` section as `apply.c`
 * `parse_git_diff_header` does: they end at `@@ -` or at the first line that is
 * not a git header line. `---`/`+++` names must agree with the names earlier
 * lines gave; a new or deleted file takes the `diff --git` name and needs
 * `/dev/null` on its other side; a rename needs both its names.
 * @returns the section without hunks, the index of the line after the header
 * lines, and whether the header is a new file, a deletion or a rename (git
 * accepts only such a section, or a mode change, without hunks).
 * @throws {@link PatchError} `PATCH_PARSE` for a header git rejects,
 * `PATCH_UNSUPPORTED` for one that would change or set a mode, or names an
 * old mode that is not a regular file.
 */
function parseGitHeader(lines, at) {
    const defaultName = gitHeaderName(lines[at].slice('diff --git '.length));
    let oldName;
    let newName;
    let isNew = false;
    let isDelete = false;
    let isRename = false;
    let oldMode;
    let newMode;
    /** Line of the last `new mode` or `new file mode` line. */
    let newModeLine = 0;
    /** Line of the last line that set the old mode (`old mode`, `deleted file mode`, an `index` line). */
    let oldModeLine = 0;
    let extensionLine;
    let j = at + 1;
    for (; j < lines.length; j += 1) {
        const line = lines[j];
        const lineNo = j + 1;
        const after = (prefix) => line.startsWith(prefix) ? line.slice(prefix.length) : undefined;
        let rest;
        if (line.startsWith('@@ -'))
            break;
        else if ((rest = after('--- ')) !== undefined)
            oldName = verifyName(lineNo, rest, isNew, oldName, 'old');
        else if ((rest = after('+++ ')) !== undefined)
            newName = verifyName(lineNo, rest, isDelete, newName, 'new');
        else if ((rest = after('old mode ')) !== undefined) {
            oldMode = parseMode(lineNo, rest);
            oldModeLine = lineNo;
        }
        else if ((rest = after('new mode ')) !== undefined) {
            newMode = parseMode(lineNo, rest);
            newModeLine = lineNo;
        }
        else if ((rest = after('deleted file mode ')) !== undefined) {
            isDelete = true;
            oldName = defaultName;
            oldMode = parseMode(lineNo, rest);
            oldModeLine = lineNo;
        }
        else if ((rest = after('new file mode ')) !== undefined) {
            isNew = true;
            newName = defaultName;
            newMode = parseMode(lineNo, rest);
            newModeLine = lineNo;
        }
        else if (line.startsWith('copy from ') || line.startsWith('copy to '))
            throw parseError(lineNo, 'git copy headers are not supported; write the new file with "+" lines instead');
        else if ((rest = after('rename old ') ?? after('rename from ')) !== undefined) {
            isRename = true;
            oldName = findName(rest, 0, TERM_NONE) ?? undefined;
        }
        else if ((rest = after('rename new ') ?? after('rename to ')) !== undefined) {
            isRename = true;
            newName = findName(rest, 0, TERM_NONE) ?? undefined;
        }
        else if (line.startsWith('similarity index ') || line.startsWith('dissimilarity index ')) { /* a score; git ignores a bad one */ }
        else if ((rest = after('index ')) !== undefined) {
            const mode = indexMode(rest);
            if (mode !== undefined) {
                oldMode = parseMode(lineNo, mode);
                oldModeLine = lineNo;
            }
        }
        else
            break;
        if (Number(isNew) + Number(isDelete) + Number(isRename) > 1)
            throw parseError(lineNo, `inconsistent header lines ${extensionLine} and ${lineNo}: a "diff --git" section is only one of a new file, a deleted file or a rename`);
        if ((isNew || isDelete || isRename) && extensionLine === undefined)
            extensionLine = lineNo;
    }
    if (oldName === undefined && newName === undefined) {
        if (defaultName === undefined)
            throw parseError(at + 1, 'the "diff --git" line names two different files and no "---"/"+++" or "rename from"/"rename to" lines name them; git apply rejects it');
        oldName = newName = defaultName;
    }
    if ((newName === undefined && !isDelete) || (oldName === undefined && !isNew)) {
        throw parseError(at + 1, `the "diff --git" section lacks its ${newName === undefined ? 'new' : 'old'} file name; a rename needs both "rename from" and "rename to", as for git apply`);
    }
    if (isNew && newMode !== 0o100644) {
        throw unsupported(newModeLine, `"new file mode ${newMode?.toString(8)}" asks for ${newMode === 0o100755 ? 'an executable file' : newMode === 0o120000 ? 'a symbolic link' : 'a directory or submodule entry'}, and apply_patch creates only regular files with the default mode; file modes are not supported. Send the file with "new file mode 100644" and change its mode with the shell afterwards`);
    }
    if (!isNew && oldMode !== undefined && oldMode !== 0o100644 && oldMode !== 0o100755) {
        throw unsupported(oldModeLine, `the old mode ${oldMode.toString(8)} says that "${oldName ?? newName}" is ${oldMode === 0o120000 ? 'a symbolic link' : oldMode === 0o40000 ? 'a directory' : 'a submodule entry'}; apply_patch patches only regular files (symbolic links, submodules and directories cannot be patched), and git apply rejects this mode for a regular file ("wrong type"). Send the content change without mode lines`);
    }
    if (!isNew && newMode !== undefined && newMode !== oldMode) {
        throw unsupported(newModeLine, `mode changes ("old mode"/"new mode" lines) are not supported, and git apply would change the mode of "${newName ?? oldName}" to ${newMode.toString(8)}; apply_patch writes file contents only. Change the mode with the shell and send the content change without the mode lines`);
    }
    const section = { start: at + 1, git: true, oldPath: oldName ?? null, newPath: newName ?? null, newFile: isNew, deletedFile: isDelete, chunks: [] };
    return { section, next: j, metadata: isNew || isDelete || isRename };
}
/** `PATCH_UNSUPPORTED` for a header line of a valid diff that asks for more than file contents; nothing has been written. */
function unsupported(lineNo, why) {
    return new PatchError('PATCH_UNSUPPORTED', `Unsupported patch at line ${lineNo}: ${why}.`);
}
/**
 * Check a `---`/`+++` name of a git header against what earlier header lines
 * said (`apply.c` `gitdiff_verify_name`).
 * @param absent - the file does not exist on this side (`new file mode` for `---`, `deleted file mode` for `+++`).
 * @returns the name of this side, `undefined` for `/dev/null`.
 */
function verifyName(lineNo, raw, absent, known, side) {
    const header = side === 'old' ? '---' : '+++';
    const kind = side === 'old' ? 'new file mode' : 'deleted file mode';
    if (known === undefined && !absent) {
        if (isDevNull(raw))
            throw parseError(lineNo, `"${header} /dev/null" in a "diff --git" section needs a "${kind} 100644" line before it; without it git apply reads the file "dev/null"`);
        // A name git cannot find (no "/" to remove) leaves this side unnamed, as in git.
        return findName(raw, 1, TERM_TAB) ?? undefined;
    }
    if (known !== undefined) {
        if (absent)
            throw parseError(lineNo, `expected "${header} /dev/null" after "${kind}", got "${known}"`);
        const name = findName(raw, 1, TERM_TAB);
        if (name !== known)
            throw parseError(lineNo, `inconsistent ${side} file name: "${header}" names ${name === null ? `no file git can read (${JSON.stringify(raw)})` : JSON.stringify(name)}, but an earlier line of this "diff --git" section names "${known}"`);
        return known;
    }
    if (!isDevNull(raw))
        throw parseError(lineNo, `expected "${header} /dev/null" after "${kind}"`);
    return undefined;
}
/**
 * A git mode as `apply.c` `parse_mode_line` reads it with `strtoul(line, &end, 8)`
 * into an `unsigned int`: optional leading whitespace, an optional sign, octal
 * digits, then a space, TAB, CR (git's `isspace`) or the end of the line. A value beyond 64 bits
 * saturates, a negative one wraps around, and the low 32 bits are kept. The
 * result is canonicalized as git `canon_mode` does (a regular file is `100755`
 * with the owner execute bit, otherwise `100644`; a symbolic link `120000`; a
 * directory `40000`; anything else a submodule entry `160000`).
 * @throws {@link PatchError} `PATCH_PARSE` for a mode git rejects as invalid,
 * `PATCH_UNSUPPORTED` for a negative mode, which git wraps around to another mode.
 */
function parseMode(lineNo, text) {
    const match = /^[\t\v\f\r ]*([+-]?)([0-7]+)(?:[\t\r ]|$)/.exec(text);
    if (match === null)
        throw parseError(lineNo, `invalid mode "${text}"; a git mode is an octal number such as 100644`);
    const ulongMax = (1n << 64n) - 1n;
    let value = BigInt(`0o${match[2]}`);
    if (value > ulongMax)
        value = ulongMax;
    else if (match[1] === '-')
        value = BigInt.asUintN(64, -value);
    const mode = canonMode(Number(BigInt.asUintN(32, value)));
    if (match[1] === '-')
        throw unsupported(lineNo, `negative mode "${text.trim()}": git apply reads it as mode ${mode.toString(8)}, and file modes are not supported; apply_patch writes file contents only. Send the change without mode lines or with an unsigned mode such as 100644`);
    return mode;
}
/** git `canon_mode` of a 32-bit mode value. */
function canonMode(mode) {
    switch (mode & 0o170000) {
        case 0o100000: return (mode & 0o100) !== 0 ? 0o100755 : 0o100644;
        case 0o120000: return 0o120000;
        case 0o040000: return 0o040000;
        default: return 0o160000;
    }
}
/** The mode after the object names of an `index <old>..<new> <mode>` line, when git reads one (`apply.c` `gitdiff_index`). */
function indexMode(rest) {
    const dots = rest.indexOf('.');
    if (dots < 0 || rest[dots + 1] !== '.' || dots > 40)
        return undefined;
    const names = rest.slice(dots + 2);
    const space = names.indexOf(' ');
    if ((space < 0 ? names.length : space) > 40)
        return undefined;
    return space < 0 ? undefined : names.slice(space + 1);
}
function withoutCr(line) {
    return line.endsWith('\r') ? line.slice(0, -1) : line;
}
/** Characters that end an unquoted `---`/`+++` name (`apply.c` `TERM_TAB`: a TAB and git's other non-space whitespace). */
const TERM_TAB = '\t\r';
/** Characters that end an unquoted `rename from`/`rename to` name. */
const TERM_NONE = '\r';
/**
 * A name as `apply.c` `find_name` reads it without a default name: a C-quoted
 * name that `unquote_c_style` accepts is decoded and the rest of the line is
 * ignored; otherwise the name runs up to the first terminator (a CR always
 * ends it, so a CRLF line yields the name without its CR). `p` leading path
 * components are removed; runs of `/` are squashed.
 * @param line - the line after its prefix (`--- `, `rename from `), without its LF.
 * @param p - leading components to remove: 1 for `---`/`+++`, 0 for rename lines.
 * @param terminators - characters besides the LF that end an unquoted name.
 * @returns the name, or `null` where git finds none (fewer than `p` slashes, or nothing after them).
 */
function findName(line, p, terminators) {
    if (line.startsWith('"')) {
        const quoted = quotedName(line, p);
        if (quoted !== null)
            return quoted;
    }
    return commonName(line, null, p, terminators);
}
/**
 * `apply.c` `find_name_gnu`: a C-quoted name that `unquote_c_style` accepts,
 * without `p` leading path components; `null` when it is not one or has fewer
 * than `p` slashes. Text after the closing quote is ignored.
 */
function quotedName(line, p) {
    const quoted = unquoteC(line, 0);
    if (quoted === undefined)
        return null;
    let name = quoted.value;
    for (let left = p; left > 0; left -= 1) {
        const slash = name.indexOf('/');
        if (slash < 0)
            return null;
        name = name.slice(slash + 1);
    }
    return squashSlash(name);
}
/**
 * `apply.c` `find_name_common`: the name up to `end`, or without `end` up to
 * the first terminator, without `p` leading path components. Where that
 * leaves nothing (fewer than `p` slashes, or nothing after them) the result is
 * `def`; a `def` that is a shorter prefix of the name is preferred.
 */
function commonName(line, def, p, terminators, end) {
    let start = p === 0 ? 0 : -1;
    let left = p;
    let i = 0;
    for (const limit = end ?? line.length; i < limit && (end !== undefined || !terminators.includes(line[i])); i += 1) {
        if (line[i] === '/' && (left -= 1) === 0)
            start = i + 1;
    }
    if (start < 0 || i === start)
        return def;
    const name = line.slice(start, i);
    if (def !== null && def.length < name.length && name.startsWith(def))
        return def;
    return squashSlash(name);
}
function squashSlash(name) {
    return name.replace(/\/{2,}/g, '/');
}
/** git `is_dev_null`: `/dev/null` followed by whitespace or the end of the line. */
function isDevNull(rest) {
    return rest.startsWith('/dev/null') && (rest.length === 9 || ' \t\r'.includes(rest[9]));
}
/** A `--- ` line directly followed by a `+++ ` line. */
function isFileHeader(lines, i) {
    return lines[i].startsWith('--- ') && lines[i + 1]?.startsWith('+++ ') === true;
}
/** Parse one hunk starting at its header; returns the chunk and the index of the first line after it. */
function parseHunk(lines, at, header) {
    const chunk = { labels: [], oldLines: [], newLines: [], context: [], endOfFile: false };
    const counted = header[1] !== undefined;
    let oldLeft = Infinity;
    let newLeft = Infinity;
    if (counted) {
        chunk.oldStart = Number(header[1]);
        chunk.oldCount = oldLeft = header[2] === undefined ? 1 : Number(header[2]);
        chunk.newStart = Number(header[3]);
        chunk.newCount = newLeft = header[4] === undefined ? 1 : Number(header[4]);
    }
    const declared = `"${header[0]}" at line ${at + 1}`;
    let last;
    let blankTail = 0;
    /** Line index of the first of the trailing blank lines. */
    let blankTailStart = 0;
    /** Line indices of lines holding only a CR; git rejects them inside a hunk, they are kept only as trailing separators of a hunk that ends early. */
    const crOnly = [];
    let swallowedHeader = false;
    let i = at + 1;
    for (; i < lines.length; i += 1) {
        const line = lines[i];
        const after = oldLeft === 0 && newLeft === 0;
        if (line.startsWith('\\')) {
            if (!isMarker(lines, i, after)) {
                if (after)
                    break;
                throw parseError(i + 1, `${JSON.stringify(line.slice(0, 60))} is not a "\\ No newline at end of file" line; inside a hunk a line starting with "\\" must be that marker`);
            }
            if (last !== undefined && last !== '+')
                unterminated(chunk, 'oldUnterminated', chunk.oldLines.length - 1);
            if (last !== undefined && last !== '-')
                unterminated(chunk, 'newUnterminated', chunk.newLines.length - 1);
            if (after) {
                i += 1;
                break;
            }
            continue;
        }
        if (after)
            break;
        if (!counted && isFileHeader(lines, i))
            break;
        const blank = line === '' || line === '\r';
        const kind = blank ? ' ' : line.charAt(0);
        if (kind === ' ' || kind === '-' || kind === '+') {
            if (blank && !counted)
                break;
            if ((kind !== '+' && oldLeft === 0) || (kind !== '-' && newLeft === 0)) {
                if (blank)
                    break;
                throw parseError(i + 1, `the hunk ${declared} has more ${kind === '+' ? 'new' : 'old'} lines than its header declares; make the "@@" counts match the lines`);
            }
            if (counted && isFileHeader(lines, i))
                swallowedHeader = true;
            const body = blank ? line : line.slice(1);
            if (kind === ' ')
                chunk.context.push([chunk.oldLines.length, chunk.newLines.length]);
            if (kind !== '+') {
                chunk.oldLines.push(body);
                oldLeft -= 1;
            }
            if (kind !== '-') {
                chunk.newLines.push(body);
                newLeft -= 1;
            }
            last = kind;
            if (blank && blankTail === 0)
                blankTailStart = i;
            blankTail = blank ? blankTail + 1 : 0;
            if (line === '\r')
                crOnly.push(i);
            continue;
        }
        if (!counted || HUNK.test(line) || line.startsWith('diff --git '))
            break;
        throw parseError(i + 1, `${JSON.stringify(line.slice(0, 60))} is not a hunk line, but the hunk ${declared} still expects ${oldLeft} old and ${newLeft} new line(s). Start every hunk line with " ", "-" or "+", and make the "@@" counts match the lines.`);
    }
    if (counted && (oldLeft > 0 || newLeft > 0)) {
        if (swallowedHeader)
            throw parseError(at + 1, `the counts of the hunk ${declared} do not match its lines, and its lines contain a "---"/"+++" pair that may be the next file's header; make the "@@" counts match the lines`);
        // A hunk that ends early: its trailing blank lines are separators.
        if (blankTail > 0)
            crOnly.length -= crOnly.filter(index => index >= blankTailStart).length;
        chunk.oldLines.length -= blankTail;
        chunk.newLines.length -= blankTail;
        chunk.context.length -= blankTail;
        chunk.oldUnterminated = chunk.oldUnterminated?.filter(index => index < chunk.oldLines.length);
        chunk.newUnterminated = chunk.newUnterminated?.filter(index => index < chunk.newLines.length);
        if (chunk.oldUnterminated?.length === 0)
            delete chunk.oldUnterminated;
        if (chunk.newUnterminated?.length === 0)
            delete chunk.newUnterminated;
    }
    else if (counted && i < lines.length && /^[-+]/.test(lines[i]) && !isFileHeader(lines, i)) {
        throw parseError(i + 1, `more change lines follow the hunk ${declared} than its header declares; make the "@@" counts match the lines`);
    }
    if (crOnly.length > 0)
        throw parseError(crOnly[0] + 1, 'a line holding only a CR is not a hunk line (git apply: "corrupt patch"); an empty context line of a CRLF file is a space followed by the CR');
    if (chunk.oldLines.length === 0 && chunk.newLines.length === 0)
        throw parseError(at + 1, 'the hunk has no lines');
    return { chunk, next: i };
}
/**
 * Whether the line at `i`, which starts with `\`, is a newline marker as git
 * reads it (`apply.c` `parse_fragment`): it starts with `\ ` (the rest is
 * localized) and, inside a hunk, is at least 12 bytes long with its LF; after
 * the hunk's counts are reached, more than 12 bytes of the diff remain from its
 * start. git takes one marker after a hunk and skips any other such line.
 */
function isMarker(lines, i, after) {
    if (!lines[i].startsWith('\\ '))
        return false;
    if (!after)
        return Buffer.byteLength(lines[i]) + 1 >= 12;
    let rest = -1;
    for (let j = i; j < lines.length && rest <= 12; j += 1)
        rest += Buffer.byteLength(lines[j]) + 1;
    return rest > 12;
}
/** Record that the line at `index` of one side has no LF. */
function unterminated(chunk, key, index) {
    const indices = chunk[key] ?? (chunk[key] = []);
    if (indices.at(-1) !== index)
        indices.push(index);
}
/**
 * Build the file operation of one section, or `null` for a bare `---`/`+++`
 * pair without hunks, `/dev/null` on either side included: git reads such a
 * pair as text (alone it is "No valid patches in input"), so only a
 * `diff --git` header creates or deletes a file without hunks.
 */
function toOp(section) {
    if (!section.git && section.chunks.length === 0)
        return null;
    const { oldPath, newPath } = section.bare === undefined ? section : bareNames(section.bare, section.start);
    const op = buildOp(section, oldPath ?? null, newPath ?? null);
    if (op !== null)
        checkNames(op, section.start);
    return op;
}
/**
 * Refuse a name git refuses ({@link gitPathProblem}: git checks the old name
 * of a deletion or update and the new name of anything but a deletion, which
 * are the names of the operation) or that is not valid UTF-8.
 * @throws {@link PatchError} `PATCH_PARSE` "invalid path" for a name git refuses, `PATCH_UNSUPPORTED` for a name that is not UTF-8.
 */
function checkNames(op, start) {
    for (const name of op.kind === 'update' && op.moveTo !== undefined ? [op.path, op.moveTo] : [op.path]) {
        if (hasLoneSurrogate(name)) {
            throw unsupported(start, `the file name ${showName(name)} is not valid UTF-8; apply_patch names files with UTF-8 text only. Rename the file with the shell, or send a name that is valid UTF-8`);
        }
        const problem = gitPathProblem(name);
        if (problem !== undefined) {
            throw parseError(start, `invalid path ${showName(name)}: it has ${problem}, and git apply refuses such a name. Name the file relative to the working directory, without ".", ".." or ".git" components and without a leading or trailing "/"`);
        }
    }
}
/** A name for messages: JSON-quoted, with the bytes of a sequence that is not UTF-8 as octal escapes (`\377`). */
function showName(name) {
    return JSON.stringify(name).replace(/\\ud[c-f][0-9a-f]{2}/gi, escape => {
        const code = parseInt(escape.slice(2), 16);
        return code >= 0xDC80 && code <= 0xDCFF ? `\\${(code - 0xDC00).toString(8)}` : escape;
    });
}
/** The file operation of a section with hunks or git metadata, from its old and new names. */
function buildOp(section, oldPath, newPath) {
    if (section.newFile || (!section.git && oldPath === null && newPath != null)) {
        const path = requirePath(newPath, section);
        if (section.chunks.some(chunk => chunk.oldLines.length > 0)) {
            throw parseError(section.start, `the new file "${path}" has context or removed lines, and git apply rejects a new file that depends on old contents; every line of a new file starts with "+"`);
        }
        // Placed against an empty file as git places hunks (apply_fragments on an empty image).
        const content = applyChunks(path, '', section.chunks, 'unified');
        return { kind: 'add', path, content };
    }
    if (section.deletedFile || (!section.git && newPath === null && oldPath != null)) {
        return { kind: 'delete', path: requirePath(oldPath, section), chunks: section.chunks };
    }
    if (section.git && oldPath !== newPath) {
        return { kind: 'update', path: requirePath(oldPath, section), moveTo: requirePath(newPath, section), chunks: section.chunks };
    }
    if (section.chunks.length === 0)
        return null;
    return { kind: 'update', path: requirePath(newPath ?? oldPath, section), chunks: section.chunks };
}
function requirePath(path, section) {
    if (path === undefined || path === null || path === '')
        throw parseError(section.start, 'a file section has no usable path');
    return path;
}
/**
 * The old and new name of a bare `---`/`+++` pair with hunks, as
 * `apply.c` `parse_traditional_patch` finds them: `/dev/null` on one side
 * creates or deletes the file named on the other; otherwise the file is the
 * `+++` name, or the `---` name when that is a shorter prefix of it (`f` for
 * `f` and `f.orig`), and an epoch timestamp after a TAB on the `---` or `+++`
 * line creates or deletes it (`has_epoch_timestamp`). Names are read with
 * {@link traditionalName}.
 * @returns the old and new name; `null` is a side that does not exist.
 * @throws {@link PatchError} `PATCH_PARSE` where git finds no name, for
 * `/dev/null` on both sides (git creates a file `dev/null`), and for a name
 * with a directory read with a guessed `-p0` (git keeps `a/` and `b/` in it).
 */
function bareNames(pair, start) {
    const { first, second, p } = pair;
    if (isDevNull(first) && isDevNull(second))
        throw parseError(start, 'both names of the "---"/"+++" pair are "/dev/null"; git apply would create a file named "dev/null". Name the file on the "+++" line to create it, or on the "---" line to delete it');
    let oldPath;
    let newPath;
    let name;
    if (isDevNull(first)) {
        name = traditionalName(second, null, p);
        oldPath = null;
        newPath = name;
    }
    else if (isDevNull(second)) {
        name = traditionalName(first, null, p);
        oldPath = name;
        newPath = null;
    }
    else {
        name = traditionalName(second, traditionalName(first, null, p), p);
        oldPath = hasEpochTimestamp(first) ? null : name;
        newPath = oldPath !== null && hasEpochTimestamp(second) ? null : name;
    }
    if (name === null) {
        throw parseError(start, 'git apply finds no file name in this "---"/"+++" pair: it removes the first path component of each name ("-p1"), unless both names lack a directory, and a name without a "/" then names nothing. Write the names as "--- a/<path>" and "+++ b/<path>"');
    }
    if (p === 0 && name.includes('/')) {
        throw parseError(start, `git apply guessed "-p0" from the names without a directory of the "---"/"+++" pair at line ${pair.guessedAt} and reads this pair with it too, so it would patch "${name}". Write the earlier pair as "--- a/<path>" and "+++ b/<path>", or send the sections as "diff --git" sections`);
    }
    return { oldPath, newPath };
}
/**
 * `apply.c` `guess_p_value` for a pair, run where git runs it from the top of
 * the tree: 0 when both names (read with `-p0`) lack a `/`, or one is
 * `/dev/null` and the other `+++` name lacks one; otherwise -1, and git keeps
 * `-p1`.
 */
function guessPair(first, second) {
    const guess = (line) => {
        if (isDevNull(line))
            return -1;
        const name = traditionalName(line, null, 0);
        return name === null || name.includes('/') ? -1 : 0;
    };
    const q = guess(second);
    const p = guess(first) < 0 ? q : 0;
    return p >= 0 && p === q ? p : -1;
}
/**
 * A `---`/`+++` name of a bare pair as `apply.c` `find_name_traditional`
 * reads it: a C-quoted name as {@link findName} reads it; otherwise, when the
 * line ends in a timestamp ({@link timestampLength}), the name is everything
 * before it, spaces and TABs included, else it ends at a TAB or CR.
 * @param def - the `---` name when reading the `+++` name: returned when no name is found, or when it is a shorter prefix of the name found.
 * @param p - leading path components to remove.
 */
function traditionalName(line, def, p) {
    if (line.startsWith('"')) {
        const quoted = quotedName(line, p);
        if (quoted !== null)
            return quoted;
    }
    const stamp = timestampLength(line);
    return stamp === 0 ? commonName(line, def, p, TERM_TAB) : commonName(line, def, p, '', line.length - stamp);
}
/**
 * `apply.c` `has_epoch_timestamp`: the text after the last TAB is a time of
 * 1969-12-31 or 1970-01-01 with whole minutes, `:00` seconds, an optional zero
 * fraction and a zone, up to the end of the line (a CR prevents it), that is
 * the epoch in that zone. GNU diff writes it for a created or deleted file.
 */
function hasEpochTimestamp(line) {
    const tab = line.lastIndexOf('\t');
    if (tab < 0)
        return false;
    const stamp = /^(1969-12-31|1970-01-01) ([0-2][0-9]):([0-5][0-9]):00(?:\.0+)? ([-+])([0-2][0-9]):?([0-5][0-9])$/.exec(line.slice(tab + 1));
    if (stamp === null)
        return false;
    const zone = (stamp[4] === '-' ? -1 : 1) * (Number(stamp[5]) * 60 + Number(stamp[6]));
    return Number(stamp[2]) * 60 + Number(stamp[3]) - zone === (stamp[1] === '1969-12-31' ? 24 * 60 : 0);
}
const isDigit = (ch) => ch !== undefined && ch >= '0' && ch <= '9';
/** Whether `line` has `pattern` at `at`: `9` a digit, any other character itself. */
function hasPattern(line, at, pattern) {
    if (at < 0)
        return false;
    for (let j = 0; j < pattern.length; j += 1) {
        if (pattern[j] === '9' ? !isDigit(line[at + j]) : line[at + j] !== pattern[j])
            return false;
    }
    return true;
}
/**
 * Length of the timestamp at the end of `line` as `apply.c`
 * `diff_timestamp_len` finds it, 0 when there is none: a date
 * (`2010-07-05` or `10-07-05`), optionally a time (`19:41:17`, with a
 * fraction), optionally a zone (`-0500`, `+08:00`), after a TAB, or after
 * spaces, which belong to the timestamp.
 */
function timestampLength(line) {
    const len = line.length;
    if (!isDigit(line[len - 1]))
        return 0;
    let end = len;
    end -= hasPattern(line, end - 6, ' +9999') || hasPattern(line, end - 6, ' -9999') ? 6 : hasPattern(line, end - 7, ' +99:99') || hasPattern(line, end - 7, ' -99:99') ? 7 : 0;
    if (hasPattern(line, end - 9, ' 99:99:99'))
        end -= 9;
    else if (isDigit(line[end - 1])) {
        let dot = end - 1;
        while (dot > 0 && isDigit(line[dot]))
            dot -= 1;
        if (line[dot] === '.' && hasPattern(line, dot - 9, ' 99:99:99'))
            end = dot - 9;
    }
    if (!hasPattern(line, end - 8, '99-99-99'))
        return 0;
    end -= 8;
    if (end >= 2 && isDigit(line[end - 1]) && isDigit(line[end - 2]))
        end -= 2;
    if (end === 0)
        return 0;
    if (line[end - 1] === '\t')
        return len - end + 1;
    if (line[end - 1] !== ' ')
        return 0;
    while (end > 0 && line[end - 1] === ' ')
        end -= 1;
    return len - end;
}
/** git `isspace`: space, TAB, LF and CR only. */
function isGitSpace(ch) {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}
/** git `skip_tree_prefix` with one component: the text after the first `/`, or `undefined` when there is none or it comes first. */
function skipTreePrefix(text) {
    const slash = text.indexOf('/');
    return slash <= 0 ? undefined : slash + 1;
}
/**
 * The default name of a `diff --git` line, as `apply.c` `git_header_name`
 * finds it: the name both sides give after their first path component, or
 * `undefined` when git finds none (then only `---`/`+++` or rename lines name
 * the file). Two unquoted names must be the same bytes up to the LF, separated
 * by one space or TAB; a CR before the LF belongs to the second name, so a
 * CRLF line `diff --git a/f b/f` names `f` and `f\r` and has no default name,
 * as for git. A quoted name ends at its closing quote.
 * @param rest - the line after `diff --git `, without its LF.
 */
function gitHeaderName(rest) {
    const line = `${rest}\n`;
    if (line.startsWith('"')) {
        const first = unquoteC(line, 0);
        if (first === undefined)
            return undefined;
        const cut = skipTreePrefix(first.value);
        if (cut === undefined)
            return undefined;
        const name = first.value.slice(cut);
        let second = first.end;
        while (second < line.length && isGitSpace(line[second]))
            second += 1;
        if (second >= line.length)
            return undefined;
        if (line[second] === '"') {
            const other = unquoteC(line, second);
            const otherCut = other === undefined ? undefined : skipTreePrefix(other.value);
            return other !== undefined && otherCut !== undefined && other.value.slice(otherCut) === name ? name : undefined;
        }
        // git compares the unquoted second name including its LF, so this only matches a first name that ends in an escaped LF.
        const tail = line.slice(second);
        const tailCut = skipTreePrefix(tail);
        return tailCut !== undefined && tail.slice(tailCut) === name ? name : undefined;
    }
    const nameCut = skipTreePrefix(line.slice(0, -1));
    if (nameCut === undefined)
        return undefined;
    const quote = line.indexOf('"', nameCut);
    if (quote >= 0) {
        // A quote after an unquoted first name starts the second name.
        const other = unquoteC(line, quote);
        const otherCut = other === undefined ? undefined : skipTreePrefix(other.value);
        if (other === undefined || otherCut === undefined)
            return undefined;
        const name = other.value.slice(otherCut);
        return name.length < quote - nameCut && line.startsWith(name, nameCut) && isGitSpace(line[nameCut + name.length]) ? name : undefined;
    }
    const end = line.length - 1;
    for (let len = 0; nameCut + len < end; len += 1) {
        const ch = line[nameCut + len];
        if (ch !== ' ' && ch !== '\t')
            continue;
        const secondStart = nameCut + len + 1;
        const secondCut = skipTreePrefix(line.slice(secondStart, end));
        if (secondCut === undefined)
            continue;
        const second = secondStart + secondCut;
        if (line[second + len] === '\n' && line.slice(second, second + len) === line.slice(nameCut, nameCut + len))
            return line.slice(nameCut, nameCut + len);
    }
    return undefined;
}
/**
 * Decode a C-quoted name as git `unquote_c_style` does: `\a \b \f \n \r \t \v \\ \"`
 * and three-digit octal escapes up to `\377`, decoded as UTF-8 by
 * {@link decodeName}; any other escape, or a missing closing quote, fails.
 * @param text - the text holding the name.
 * @param at - index of the opening quote.
 * @returns the decoded name and the index after the closing quote, or `undefined`.
 */
function unquoteC(text, at) {
    if (text[at] !== '"')
        return undefined;
    const simple = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '\\': 92, '"': 34 };
    const bytes = [];
    for (let i = at + 1; i < text.length;) {
        const ch = text[i];
        if (ch === '"')
            return { value: decodeName(bytes), end: i + 1 };
        if (ch !== '\\') {
            const point = String.fromCodePoint(text.codePointAt(i));
            bytes.push(...Buffer.from(point, 'utf8'));
            i += point.length;
            continue;
        }
        const next = text[i + 1];
        if (next !== undefined && next in simple) {
            bytes.push(simple[next]);
            i += 2;
        }
        else if (/^[0-3][0-7][0-7]$/.test(text.slice(i + 1, i + 4))) {
            bytes.push(parseInt(text.slice(i + 1, i + 4), 8));
            i += 4;
        }
        else {
            return undefined;
        }
    }
    return undefined;
}
const utf8 = new TextDecoder('utf-8', { fatal: true });
/**
 * The bytes of a name as a string: valid UTF-8 as its characters, and each
 * byte of a sequence that is not UTF-8 as the lone surrogate U+DC80 to U+DCFF,
 * so that distinct bytes stay distinct names (git compares names as bytes) and
 * the name is refused where it would name a file ({@link checkNames}).
 */
function decodeName(bytes) {
    const all = Uint8Array.from(bytes);
    try {
        return utf8.decode(all);
    }
    catch {
        // Not UTF-8 as a whole: decode each sequence, escaping the bytes of the invalid ones.
    }
    let out = '';
    for (let i = 0; i < all.length;) {
        const length = sequenceLength(all, i);
        out += length === 0 ? String.fromCharCode(0xDC00 + all[i]) : utf8.decode(all.subarray(i, i + length));
        i += length === 0 ? 1 : length;
    }
    return out;
}
/** Length of the valid UTF-8 sequence at `i` (no overlong forms, surrogates or values above U+10FFFF), 0 when there is none. */
function sequenceLength(bytes, i) {
    const b = bytes[i];
    if (b < 0x80)
        return 1;
    const length = b >= 0xC2 && b <= 0xDF ? 2 : b >= 0xE0 && b <= 0xEF ? 3 : b >= 0xF0 && b <= 0xF4 ? 4 : 0;
    if (length === 0 || i + length > bytes.length)
        return 0;
    const second = bytes[i + 1];
    const low = b === 0xE0 ? 0xA0 : b === 0xF0 ? 0x90 : 0x80;
    const high = b === 0xED ? 0x9F : b === 0xF4 ? 0x8F : 0xBF;
    if (second < low || second > high)
        return 0;
    for (let j = 2; j < length; j += 1)
        if (bytes[i + j] < 0x80 || bytes[i + j] > 0xBF)
            return 0;
    return length;
}
/**
 * Decode a git C-quoted path as `unquote_c_style` does, including octal UTF-8 escapes.
 * @param text - a whole quoted path (`"…"`), or an unquoted path.
 * @returns the decoded path; text that is not one valid quoted name is returned unchanged, spaces included.
 */
export function unquote(text) {
    const quoted = unquoteC(text, 0);
    return quoted !== undefined && quoted.end === text.length ? quoted.value : text;
}
