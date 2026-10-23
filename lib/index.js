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
import { resolveConfig } from './config.js';
import { buildApplyPatchTool } from './tool.js';
/** Cordis plugin name. */
export const name = 'dsh-apply-patch';
/** Services read on every call; `shell`, `sandboxPolicy` and `workingDirectory` are read with `ctx.get` when present. */
export const inject = ['tools', 'fs'];
export { Config } from './config.js';
/**
 * Register the tool for the mounting scope.
 * @param ctx - plugin context.
 * @param config - plugin configuration.
 */
export function apply(ctx, config) {
    const definition = buildApplyPatchTool(ctx, resolveConfig(config));
    ctx.effect(() => ctx.tools.register(definition), `${name}: ${definition.name} tool`);
}
