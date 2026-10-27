/**
 * Plugin configuration.
 * @module dsh-apply-patch/config
 */

import z from '@deepseek-ai/schemastery'

/** Deployment configuration of the `apply_patch` tool. */
export interface Config {
  /** Model-facing tool name. Registration fails when an Agent already has a tool with this name. */
  toolName?: string
  /** Accept Codex `*** Begin Patch` patches. */
  allowCodexPatch?: boolean
  /** Accept git and unified diffs. */
  allowUnifiedDiff?: boolean
  /** Maximum file operations per patch. */
  maxFiles?: number
  /** Maximum patch size in UTF-8 bytes. */
  maxPatchBytes?: number
  /** Maximum UTF-8 bytes (path and texts) of one display diff entry, a hunk, in the result metadata; a larger entry keeps only its path. */
  maxDiffBytes?: number
  /** Maximum UTF-8 bytes of all display diff entries of one call; later entries keep only their path. */
  maxDiffTotalBytes?: number
}

/** Configuration with every default applied. */
export type ResolvedConfig = Required<Config>

/** Loader schema. */
export const Config: z<Config, ResolvedConfig> = z.object({
  toolName: z.string().default('apply_patch'),
  allowCodexPatch: z.boolean().default(true),
  allowUnifiedDiff: z.boolean().default(true),
  maxFiles: z.natural().min(1).default(50),
  maxPatchBytes: z.natural().min(1024).default(512 * 1024),
  maxDiffBytes: z.natural().min(256).default(16 * 1024),
  maxDiffTotalBytes: z.natural().min(1024).default(128 * 1024),
})

/**
 * Apply defaults to a configuration the Loader did not normalize.
 * @param config - configuration as given.
 * @returns the configuration with every field set.
 */
export function resolveConfig(config: Config | undefined): ResolvedConfig {
  return Config(config ?? {})
}
