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
/** Which of git's platform-dependent checks apply. */
export interface PathRules {
    hfs: boolean;
    windows: boolean;
}
/** git's defaults on this platform. */
export declare const PLATFORM_RULES: PathRules;
/** Whether `name` holds a lone surrogate (a byte that is not UTF-8, or a broken code point of the patch text). */
export declare function hasLoneSurrogate(name: string): boolean;
/**
 * Why git would refuse `name`, or `undefined` when it accepts it.
 * @param name - the name after git removed its leading components.
 * @param rules - the platform-dependent checks.
 * @returns a short reason such as `a ".." component`.
 */
export declare function gitPathProblem(name: string, rules?: PathRules): string | undefined;
