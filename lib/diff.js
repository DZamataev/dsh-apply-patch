/**
 * Display diffs for DSH diff cards: one entry per changed region of a file
 * (a hunk with three context lines), as the native `write` and `edit` tools
 * report them, with byte caps per entry and per call.
 * @module dsh-apply-patch/diff
 */
/** Context lines on each side of a hunk; changes at most twice this far apart share a hunk. */
export const DIFF_CONTEXT = 3;
/** Work (diagonal steps and line comparisons) of the first Myers pass over a file's changed span. */
const FIRST_PASS_WORK = 4_000_000;
/** Work of all Myers passes of one file together. */
const FILE_WORK = 12_000_000;
/** Most line edits one Myers pass looks for; bounds its trace to about this squared. */
const MAX_EDITS = 2000;
/**
 * The display diffs of a patch, file by file and hunk by hunk.
 * An added file has one entry with `oldText: null`; a deleted file one entry with `newText: ''`
 * (none when its text is unknown or empty); a modified or moved file one entry per hunk
 * (none when its text is unchanged). An entry whose UTF-8 size (path, `oldText` and `newText`)
 * exceeds `maxBytes` keeps its path with empty texts and `truncated: true`; entries are kept in
 * order until the next one would bring the call over `maxTotalBytes`, and every later entry is
 * truncated too. Consecutive truncated entries of one file are merged into one.
 * @param files - the files in patch order.
 * @param maxBytes - UTF-8 byte cap of one entry.
 * @param maxTotalBytes - UTF-8 byte cap of all kept entries together.
 * @returns the entries.
 */
export function displayDiffs(files, maxBytes, maxTotalBytes) {
    const out = [];
    let total = 0;
    let full = false;
    for (const file of files) {
        for (const hunk of fileHunks(file)) {
            const size = Buffer.byteLength(file.path, 'utf8') + Buffer.byteLength(hunk.oldText ?? '', 'utf8') + Buffer.byteLength(hunk.newText, 'utf8');
            if (size <= maxBytes && !full && total + size <= maxTotalBytes) {
                out.push({ path: file.path, ...hunk });
                total += size;
                continue;
            }
            if (size <= maxBytes)
                full = true;
            const last = out.at(-1);
            if (last?.truncated === true && last.path === file.path)
                continue;
            out.push({ path: file.path, oldText: hunk.oldText === null ? null : '', newText: '', truncated: true });
        }
    }
    return out;
}
function fileHunks(file) {
    if (file.action === 'added') {
        const hunks = hunkTexts('', file.after ?? '');
        return hunks.length === 0 ? [{ oldText: null, newText: '' }] : hunks;
    }
    if (file.before === null)
        return [];
    return hunkTexts(file.before, file.after ?? '');
}
/**
 * The hunks between two texts, each with up to {@link DIFF_CONTEXT} unchanged lines on each side.
 * A line ends after LF. Its CRLF or LF counts when lines are compared, so a change of only the
 * line ending is a hunk, and is dropped when the line is shown; a lone CR stays in its line.
 * A leading byte order mark is not shown.
 * @param before - old text.
 * @param after - new text.
 * @returns the hunks in file order; empty when the texts are equal.
 */
export function hunkTexts(before, after) {
    if (before === after)
        return [];
    // Skip the common head and tail by characters, at line starts, keeping context lines around the rest.
    const shorter = Math.min(before.length, after.length);
    let same = 0;
    while (same < shorter && before.charCodeAt(same) === after.charCodeAt(same))
        same += 1;
    const head = same === 0 ? 0 : before.lastIndexOf('\n', same - 1) + 1;
    let back = 0;
    while (back < shorter - head && before.charCodeAt(before.length - 1 - back) === after.charCodeAt(after.length - 1 - back))
        back += 1;
    // The first LF inside the common tail ends a line in both texts.
    const lf = back === 0 ? -1 : before.indexOf('\n', before.length - back);
    const tail = lf === -1 ? before.length : lf + 1;
    let from = head;
    for (let n = 0; n < DIFF_CONTEXT && from > 0; n += 1)
        from = from >= 2 ? before.lastIndexOf('\n', from - 2) + 1 : 0;
    let to = tail;
    for (let n = 0; n < DIFF_CONTEXT && to < before.length; n += 1) {
        const end = before.indexOf('\n', to);
        to = end === -1 ? before.length : end + 1;
    }
    const a = splitLines(before, from, to);
    const b = splitLines(after, from, after.length - (before.length - to));
    const show = (line, index) => {
        const text = line.endsWith('\r\n') ? line.slice(0, -2) : line.endsWith('\n') ? line.slice(0, -1) : line;
        return from === 0 && index === 0 && text.startsWith('\uFEFF') ? text.slice(1) : text;
    };
    const hunks = [];
    const changes = diffLines(a, b);
    for (let i = 0; i < changes.length;) {
        let j = i;
        while (j + 1 < changes.length && changes[j + 1].oldStart - changes[j].oldEnd <= 2 * DIFF_CONTEXT)
            j += 1;
        const first = changes[i];
        const last = changes[j];
        const lead = Math.min(DIFF_CONTEXT, first.oldStart - (i === 0 ? 0 : changes[i - 1].oldEnd));
        const trail = Math.min(DIFF_CONTEXT, a.length - last.oldEnd);
        const oldLines = a.slice(first.oldStart - lead, last.oldEnd + trail).map((line, k) => show(line, first.oldStart - lead + k));
        const newLines = b.slice(first.newStart - lead, last.newEnd + trail).map((line, k) => show(line, first.newStart - lead + k));
        hunks.push({ oldText: oldLines.length > 0 ? oldLines.join('\n') : null, newText: newLines.join('\n') });
        i = j + 1;
    }
    return hunks;
}
/** The lines of `text[from, to)`, each with its LF; `from` is a line start. */
function splitLines(text, from, to) {
    const lines = [];
    let start = from;
    while (start < to) {
        const end = text.indexOf('\n', start);
        const stop = end === -1 || end >= to ? to : end + 1;
        lines.push(text.slice(start, stop));
        start = stop;
    }
    return lines;
}
/**
 * A line diff of `a` and `b`: the shortest edit script (Myers) while it is cheap, otherwise
 * lines unique to both sides (patience) split the work into parts that are diffed the same way,
 * and a part that is still too costly becomes one change. Every result turns `a` into `b`.
 * @param a - old lines.
 * @param b - new lines.
 * @returns the changed runs in order, separated by at least one equal line.
 */
export function diffLines(a, b) {
    let lo = 0;
    while (lo < a.length && lo < b.length && a[lo] === b[lo])
        lo += 1;
    let aHi = a.length;
    let bHi = b.length;
    while (aHi > lo && bHi > lo && a[aHi - 1] === b[bHi - 1]) {
        aHi -= 1;
        bHi -= 1;
    }
    if (lo === aHi || lo === bHi)
        return lo < aHi || lo < bHi ? [{ oldStart: lo, oldEnd: aHi, newStart: lo, newEnd: bHi }] : [];
    const first = { left: FIRST_PASS_WORK };
    const found = myers(a, lo, aHi, b, lo, bHi, first);
    if (found !== undefined)
        return found;
    const budget = { left: FILE_WORK - (FIRST_PASS_WORK - first.left) };
    const out = [];
    let aAt = lo;
    let bAt = lo;
    for (const [i, j] of uniqueAnchors(a, lo, aHi, b, lo, bHi)) {
        part(a, aAt, i, b, bAt, j, budget, out);
        aAt = i + 1;
        bAt = j + 1;
    }
    part(a, aAt, aHi, b, bAt, bHi, budget, out);
    return out;
}
/** Diff one part between anchors into `out`: trimmed, then Myers, else one change. */
function part(a, aLo, aHi, b, bLo, bHi, budget, out) {
    while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) {
        aLo += 1;
        bLo += 1;
    }
    while (aHi > aLo && bHi > bLo && a[aHi - 1] === b[bHi - 1]) {
        aHi -= 1;
        bHi -= 1;
    }
    if (aLo === aHi && bLo === bHi)
        return;
    const found = aLo === aHi || bLo === bHi || budget.left <= 0 ? undefined : myers(a, aLo, aHi, b, bLo, bHi, budget);
    if (found !== undefined)
        out.push(...found);
    else
        out.push({ oldStart: aLo, oldEnd: aHi, newStart: bLo, newEnd: bHi });
}
/**
 * Myers' greedy shortest edit script of `a[aLo, aHi)` and `b[bLo, bHi)`.
 * @returns the changed runs, or `undefined` when the work in `budget` (decremented) or {@link MAX_EDITS} ran out.
 */
function myers(a, aLo, aHi, b, bLo, bHi, budget) {
    const n = aHi - aLo;
    const m = bHi - bLo;
    const limit = Math.min(n + m, MAX_EDITS);
    const off = limit + 1;
    const v = new Int32Array(2 * limit + 3);
    const trace = [];
    for (let d = 0; d <= limit; d += 1) {
        for (let k = -d; k <= d; k += 2) {
            let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
            const start = x;
            let y = x - k;
            while (x < n && y < m && a[aLo + x] === b[bLo + y]) {
                x += 1;
                y += 1;
            }
            budget.left -= 1 + x - start;
            v[off + k] = x;
            if (x >= n && y >= m) {
                trace.push(v.slice(off - d, off + d + 1));
                return backtrack(trace, n, m, aLo, bLo);
            }
        }
        trace.push(v.slice(off - d, off + d + 1));
        if (budget.left < 0)
            return undefined;
    }
    return undefined;
}
/** Walk the Myers trace back from `(n, m)` and collect the runs between the equal diagonals. */
function backtrack(trace, n, m, aLo, bLo) {
    const snakes = [];
    let x = n;
    let y = m;
    for (let d = trace.length - 1; d > 0; d -= 1) {
        const prev = trace[d - 1];
        const at = (k) => prev[k + d - 1];
        const k = x - y;
        const down = k === -d || (k !== d && at(k - 1) < at(k + 1));
        const prevK = down ? k + 1 : k - 1;
        const prevX = at(prevK);
        const startX = down ? prevX : prevX + 1;
        if (x > startX)
            snakes.push([startX, startX - k, x - startX]);
        x = prevX;
        y = prevX - prevK;
    }
    if (x > 0)
        snakes.push([0, 0, x]);
    snakes.reverse();
    snakes.push([n, m, 0]);
    const changes = [];
    let ax = 0;
    let by = 0;
    for (const [sx, sy, len] of snakes) {
        if (sx > ax || sy > by)
            changes.push({ oldStart: aLo + ax, oldEnd: aLo + sx, newStart: bLo + by, newEnd: bLo + sy });
        ax = sx + len;
        by = sy + len;
    }
    return changes;
}
/**
 * Lines that occur exactly once in `a[aLo, aHi)` and once in `b[bLo, bHi)`, reduced to their
 * longest run increasing on both sides (patience sorting).
 * @returns `[indexInA, indexInB]` pairs in order.
 */
function uniqueAnchors(a, aLo, aHi, b, bLo, bHi) {
    const seen = new Map();
    for (let i = aLo; i < aHi; i += 1) {
        const entry = seen.get(a[i]);
        if (entry === undefined)
            seen.set(a[i], { inA: 1, inB: 0, atB: -1 });
        else
            entry.inA += 1;
    }
    for (let j = bLo; j < bHi; j += 1) {
        const entry = seen.get(b[j]);
        if (entry !== undefined) {
            entry.inB += 1;
            entry.atB = j;
        }
    }
    const pairs = [];
    for (let i = aLo; i < aHi; i += 1) {
        const entry = seen.get(a[i]);
        if (entry !== undefined && entry.inA === 1 && entry.inB === 1)
            pairs.push([i, entry.atB]);
    }
    // tails[len] is the pair ending the best increasing run of length len + 1; before[p] links runs back.
    const tails = [];
    const before = new Int32Array(pairs.length);
    for (let p = 0; p < pairs.length; p += 1) {
        let lo = 0;
        let hi = tails.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (pairs[tails[mid]][1] < pairs[p][1])
                lo = mid + 1;
            else
                hi = mid;
        }
        before[p] = lo === 0 ? -1 : tails[lo - 1];
        tails[lo] = p;
    }
    const run = [];
    for (let p = tails.length === 0 ? -1 : tails[tails.length - 1]; p !== -1; p = before[p])
        run.push(pairs[p]);
    return run.reverse();
}
