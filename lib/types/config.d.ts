/**
 * Plugin configuration.
 * @module dsh-apply-patch/config
 */
import z from '@deepseek-ai/schemastery';
/** Deployment configuration of the `apply_patch` tool. */
export interface Config {
    /** Model-facing tool name. Registration fails when an Agent already has a tool with this name. */
    toolName?: string;
    /** Accept Codex `*** Begin Patch` patches. */
    allowCodexPatch?: boolean;
    /** Accept git and unified diffs. */
    allowUnifiedDiff?: boolean;
    /** Maximum file operations per patch. */
    maxFiles?: number;
    /** Maximum patch size in UTF-8 bytes. */
    maxPatchBytes?: number;
    /** Maximum UTF-8 bytes of one file's display diff in the result metadata. */
    maxDiffBytes?: number;
}
/** Configuration with every default applied. */
export type ResolvedConfig = Required<Config>;
/** Loader schema. */
export declare const Config: z<Config, ResolvedConfig>;
/**
 * Apply defaults to a configuration the Loader did not normalize.
 * @param config - configuration as given.
 * @returns the configuration with every field set.
 */
export declare function resolveConfig(config: Config | undefined): ResolvedConfig;
