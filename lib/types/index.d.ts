/**
 * `dsh-apply-patch`: a Codex-style `apply_patch` tool for DeepSeek Harness.
 *
 * Mount it as a row inside an Agent Preset: the tool is registered in the
 * mounting scope, so only Agents of that preset see it. A second tool with
 * the same name in that scope makes the row fail to load instead of renaming.
 * The package declares no `dsh.bundle`, so it cannot be enabled for every
 * Agent from the Plugins page.
 * @module dsh-apply-patch
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Config as PluginConfig } from './config.js';
/** Cordis plugin name. */
export declare const name = "dsh-apply-patch";
/** Services read on every call; `shell`, `sandboxPolicy` and `workingDirectory` are read with `ctx.get` when present. */
export declare const inject: string[];
export { Config } from './config.js';
/**
 * Register the tool for the mounting scope.
 * @param ctx - plugin context.
 * @param config - plugin configuration.
 */
export declare function apply(ctx: Context, config?: PluginConfig): void;
