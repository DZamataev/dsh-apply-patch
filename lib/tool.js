/**
 * The model-facing `apply_patch` tool.
 * @module dsh-apply-patch/tool
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { commitPatch, preparePatch } from './apply/engine.js';
import { detectFormat } from './detect.js';
import { compactDiff } from './diff.js';
import { PatchError } from './errors.js';
import { parseCodexPatch } from './parse/codex.js';
import { parseUnifiedDiff } from './parse/unified.js';
const CODEX_FORMAT = `Edit files with a patch in this format:

*** Begin Patch
*** Update File: path/to/file.py
@@ def greet():
-    print("Hi")
+    print("Hello")
*** Add File: path/to/new.py
+print("new file")
*** Delete File: path/to/old.py
*** End Patch

- "*** Update File:" may be followed by "*** Move to: new/path" to rename the file.
- Each change starts with "@@", optionally followed by a line of the file (a class or function header) that comes before the change; repeat "@@ line" to narrow it further. Then list about 3 unchanged lines before and after the change with a leading space, removed lines with "-", added lines with "+".
- "*** End of File" after a change pins it to the end of the file, unless all its unchanged and removed lines are blank (then it is inserted at the current position). A change with only "+" lines is added at the end of the file; to insert elsewhere, include an unchanged line before it.
- Every line of an added file starts with "+".
- Paths are relative to the working directory, or absolute.
- Read a file with the read tool before updating, moving or deleting it.
- The whole patch is checked before anything is written. If a step still fails, the earlier changes of the same patch are undone; the error names every file that could not be put back (for example because something else changed it meanwhile) or whose state is unknown.`;
/**
 * Build the tool definition.
 * @param ctx - plugin context; execution uses its services.
 * @param cfg - resolved configuration.
 * @returns the tool definition.
 */
export function buildApplyPatchTool(ctx, cfg) {
    const formats = [cfg.allowCodexPatch ? 'Codex patch' : null, cfg.allowUnifiedDiff ? 'git unified diff' : null].filter(Boolean).join(' or ');
    const description = cfg.allowCodexPatch
        ? `${CODEX_FORMAT}${cfg.allowUnifiedDiff ? '\n- A git unified diff is accepted too.' : ''}`
        : 'Edit files with a git unified diff, with unchanged context lines around each change as git diff writes them by default (a hunk without context applies only at the end of the file). Read a file with the read tool before updating, moving or deleting it. The whole diff is checked before anything is written; if a step still fails, the earlier changes are undone and the error names every file that could not be put back.';
    return defineTool({
        name: cfg.toolName,
        description,
        parameters: {
            input: { type: 'string', required: true, description: `The whole ${formats}.` },
            dry_run: { type: 'boolean', description: 'Check the patch against the files without writing.' },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    applied: { type: 'boolean', required: true },
                    summary: { type: 'string', required: true },
                    files: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                path: { type: 'string', required: true },
                                action: { type: 'string', required: true, enum: ['added', 'modified', 'deleted'] },
                                from: { type: 'string' },
                            },
                        },
                    },
                    diffs: {
                        type: 'array',
                        required: true,
                        items: {
                            type: 'object',
                            additionalProperties: false,
                            properties: {
                                path: { type: 'string', required: true },
                                oldText: { required: true, oneOf: [{ type: 'string' }, { type: 'null' }] },
                                newText: { type: 'string', required: true },
                                truncated: { type: 'boolean' },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => [{ type: 'text', text: formatResult(value) }],
            presentationMeta: (_args, value) => ({ diffs: value.diffs.map(diff => ({ ...diff })) }),
        },
        async execute(args, exec) {
            const text = args.input;
            if (text.trim() === '')
                throw new PatchError('PATCH_PARSE', '"input" is empty; pass the whole patch.');
            const bytes = Buffer.byteLength(text, 'utf8');
            if (bytes > cfg.maxPatchBytes) {
                throw new PatchError('PATCH_LIMIT', `The patch is ${bytes} bytes; the limit is ${cfg.maxPatchBytes}. Split it into several calls.`);
            }
            const format = detectFormat(text);
            if (format === 'codex' && !cfg.allowCodexPatch)
                throw new PatchError('PATCH_UNSUPPORTED', 'Codex patches are disabled here; send a git unified diff.');
            if (format === 'unified' && !cfg.allowUnifiedDiff)
                throw new PatchError('PATCH_UNSUPPORTED', 'Unified diffs are disabled here; use the "*** Begin Patch" format.');
            const parsed = format === 'codex' ? parseCodexPatch(text) : parseUnifiedDiff(text);
            const prepared = await preparePatch(ctx, exec, parsed, cfg);
            const applied = args.dry_run !== true;
            const notes = applied ? await commitPatch(ctx, exec, prepared) : [];
            return result(prepared.files, applied, cfg.maxDiffBytes, notes);
        },
        presentCall: (args) => ({ card: 'generic', title: 'Apply patch', kind: 'other', rawInput: args.input ?? '' }),
        presentResult: (_args, outcome) => {
            if (outcome.isError)
                return undefined;
            const diffs = diffsOf(outcome.meta);
            return diffs.length === 0 ? { card: 'generic', title: 'Apply patch' } : { card: 'diff', title: 'Apply patch', diffs };
        },
    });
}
function result(files, applied, maxDiffBytes, notes) {
    const count = (action) => files.filter(file => file.action === action).length;
    const lead = applied ? 'Applied patch' : 'Dry run, nothing written: the patch applies';
    return {
        applied,
        summary: [`${lead}: ${count('added')} added, ${count('modified')} modified, ${count('deleted')} deleted.`, ...notes.map(note => `Note: ${note}`)].join('\n'),
        files: files.map(file => ({ path: file.path, action: file.action, ...file.from === undefined ? {} : { from: file.from } })),
        diffs: files.map(file => compactDiff(file.path, file.before, file.after, maxDiffBytes)),
    };
}
/**
 * Model-facing text: the summary, then one `A`/`M`/`D` line per file.
 * @param value - the result value.
 * @returns the text.
 */
export function formatResult(value) {
    const letter = { added: 'A', modified: 'M', deleted: 'D' };
    return [value.summary, ...value.files.map(file => `${letter[file.action]} ${file.path}${file.from === undefined ? '' : ` (moved from ${file.from})`}`)].join('\n');
}
function diffsOf(meta) {
    const list = meta?.diffs;
    if (!Array.isArray(list))
        return [];
    return list.filter((item) => typeof item?.path === 'string' && typeof item.newText === 'string' && item.truncated !== true);
}
