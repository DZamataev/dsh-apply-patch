/**
 * File names of unified diffs checked as plain `git apply` checks them before
 * it writes anything (`apply.c` `check_unsafe_path`, `read-cache.c`
 * `verify_path` for a regular file), with git's defaults: `core.protectNTFS`
 * on, `core.protectHFS` on macOS only. A name is refused when it is empty,
 * starts or ends with `/`, has an empty, `.` or `..` component, or a component
 * that is `.git` in any case; with NTFS protection also `.git` followed by
 * dots, spaces or `:`, the short name `git~1`, or such a name after a
 * backslash; with HFS+ protection also `.git` with code points HFS+ ignores
 * (zero-width and directional marks, U+FEFF). On Windows a drive prefix and
 * any backslash are refused too; the other Windows name rules of git
 * (`is_valid_win32_path`) are left to the file system.
 *
 * A name must also be valid UTF-8, since files are named by strings: C-quoted
 * names are decoded so that bytes that are not UTF-8 become lone surrogates
 * (see `unquoteC` in the parser), and a lone surrogate in the patch text
 * itself names no file either.
 * @module dsh-apply-patch/parse/gitpath
 */
/** Code points HFS+ ignores in names (`utf8.c` `next_hfs_char`). */
const HFS_IGNORED = new Set([0x200C, 0x200D, 0x200E, 0x200F, 0x202A, 0x202B, 0x202C, 0x202D, 0x202E, 0x206A, 0x206B, 0x206C, 0x206D, 0x206E, 0x206F, 0xFEFF]);
/** git's defaults on this platform. */
export const PLATFORM_RULES = { hfs: process.platform === 'darwin', windows: process.platform === 'win32' };
/** Whether `name` holds a lone surrogate (a byte that is not UTF-8, or a broken code point of the patch text). */
export function hasLoneSurrogate(name) {
    return /\p{Surrogate}/u.test(name);
}
/**
 * Why git would refuse `name`, or `undefined` when it accepts it.
 * @param name - the name after git removed its leading components.
 * @param rules - the platform-dependent checks.
 * @returns a short reason such as `a ".." component`.
 */
export function gitPathProblem(name, rules = PLATFORM_RULES) {
    const sep = (c) => c === '/' || (rules.windows && c === '\\');
    if (rules.windows && /^[A-Za-z]:/.test(name))
        return 'a drive prefix';
    if (rules.windows && name.includes('\\'))
        return 'a backslash';
    const dotGit = 'a ".git" component';
    for (let i = 0;;) {
        // i is the start of a component.
        if (rules.hfs && isHfsDotGit(name, i, sep))
            return dotGit;
        if (isNtfsDotGit(name, i))
            return dotGit;
        const c = name[i];
        if (c === undefined)
            return i === 0 ? 'no name' : 'a trailing "/"';
        if (sep(c))
            return i === 0 ? 'a leading "/" (an absolute name)' : 'an empty component';
        if (c === '.') {
            const problem = dotFile(name, i + 1, sep);
            if (problem !== undefined)
                return problem;
        }
        for (i += 1; i < name.length && !sep(name[i]); i += 1) {
            if (name[i] === '\\' && isNtfsDotGit(name, i + 1))
                return dotGit;
        }
        if (i === name.length)
            return undefined;
        i += 1;
    }
}
/** `read-cache.c` `verify_dotfile` for a regular file: the component at `at` follows a `.`. */
function dotFile(name, at, sep) {
    const end = (j) => j >= name.length || sep(name[j]);
    if (end(at))
        return 'a "." component';
    if (/^[gG][iI][tT]$/.test(name.slice(at, at + 3)) && end(at + 3))
        return 'a ".git" component';
    if (name[at] === '.' && end(at + 1))
        return 'a ".." component';
    return undefined;
}
/** `path.c` `is_ntfs_dotgit` at `at`: `.git` or `git~1`, then only dots and spaces up to `/`, `\`, `:` or the end. */
function isNtfsDotGit(name, at) {
    const head = name.slice(at, at + 5);
    let j;
    if (/^\.[gG][iI][tT]/.test(head))
        j = at + 4;
    else if (/^[gG][iI][tT]~1$/.test(head))
        j = at + 5;
    else
        return false;
    for (;; j += 1) {
        const c = name[j];
        if (c === undefined || c === '/' || c === '\\' || c === ':')
            return true;
        if (c !== '.' && c !== ' ')
            return false;
    }
}
/** `utf8.c` `is_hfs_dotgit` at `at`: `.git` in any case, ignoring {@link HFS_IGNORED}, then a separator or the end. */
function isHfsDotGit(name, at, sep) {
    const points = name.slice(at)[Symbol.iterator]();
    const next = () => {
        for (let r = points.next(); !r.done; r = points.next())
            if (!HFS_IGNORED.has(r.value.codePointAt(0)))
                return r.value;
        return undefined;
    };
    if (next() !== '.')
        return false;
    for (const want of 'git') {
        const c = next();
        if (c === undefined || c.charCodeAt(0) > 127 || c.toLowerCase() !== want)
            return false;
    }
    const after = next();
    return after === undefined || sep(after);
}
