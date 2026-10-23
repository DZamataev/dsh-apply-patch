/**
 * Plugin configuration.
 * @module dsh-apply-patch/config
 */
import z from '@deepseek-ai/schemastery';
/** Loader schema. */
export const Config = z.object({
    toolName: z.string().default('apply_patch'),
    allowCodexPatch: z.boolean().default(true),
    allowUnifiedDiff: z.boolean().default(true),
    maxFiles: z.natural().min(1).default(50),
    maxPatchBytes: z.natural().min(1024).default(512 * 1024),
    maxDiffBytes: z.natural().min(256).default(16 * 1024),
});
/**
 * Apply defaults to a configuration the Loader did not normalize.
 * @param config - configuration as given.
 * @returns the configuration with every field set.
 */
export function resolveConfig(config) {
    return Config(config ?? {});
}
