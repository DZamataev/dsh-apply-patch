/**
 * Typed failures and model-facing messages. `PatchError` extends DSH's
 * `HarnessError`, so the tool runtime reports `{ name, code }` on the result.
 * @module dsh-apply-patch/errors
 */
import { HarnessError } from '@deepseek-ai/dsh-llm';
/** Stable failure codes. */
export type PatchErrorCode = 
/** The text is not a patch in an accepted format. */
'PATCH_PARSE'
/** The patch does not match the files (missing file, existing file, context not found). */
 | 'PATCH_CONFLICT'
/** A file must be read with the read tool before the patch may change it. */
 | 'PATCH_NOT_OBSERVED'
/** A file changed after the session read it. */
 | 'PATCH_STALE'
/** The sandbox mode forbids the write. */
 | 'PATCH_SANDBOX'
/** A filesystem or shell operation failed. */
 | 'PATCH_IO'
/** The operation is not available in this composition. */
 | 'PATCH_UNSUPPORTED'
/** A configured limit was exceeded. */
 | 'PATCH_LIMIT';
/** Typed patch failure. */
export declare class PatchError extends HarnessError {
    readonly code: PatchErrorCode;
    constructor(code: PatchErrorCode, message: string, options?: ErrorOptions);
}
/** A minimal Codex example appended to parse errors so the model can retry. */
export declare const CODEX_EXAMPLE: string;
/**
 * PARSE error with a 1-based line of the patch text.
 * @param lineNo - line of the patch text, or 0 for the whole text.
 * @param why - what is wrong.
 * @returns the error.
 */
export declare function parseError(lineNo: number, why: string): PatchError;
/**
 * PARSE error for text in neither accepted format.
 * @returns the error, with a Codex example.
 */
export declare function unrecognizedError(): PatchError;
/**
 * Quote one file line for a message, keeping whitespace visible.
 * @param line - the line.
 * @returns the JSON-quoted line, shortened to 200 characters.
 */
export declare function quote(line: string): string;
