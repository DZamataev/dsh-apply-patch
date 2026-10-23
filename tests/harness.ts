/**
 * Real DSH composition for integration tests: tool runtime, fs-local,
 * fs-observation-policy and a local bash shell over a temp directory.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { FileSystem } from '@deepseek-ai/dsh-fs'
import * as FsLocal from '@deepseek-ai/dsh-fs-local'
import * as Observation from '@deepseek-ai/dsh-fs-observation-policy'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import Bash from '@deepseek-ai/dsh-bash-local'
import * as Plugin from '../src/index.js'
import type { Config } from '../src/config.js'

export interface Harness {
  ctx: Context
  dir: string
  /** A stand-in Agent: the observation policy keys state by `agent.session`. */
  agent: { session: { id: string; header: { cwd: string } } }
  fs: FileSystem
  /** Record a `read` of `path`, as the native read tool does. */
  observe(path: string): Promise<void>
  /** Run `apply_patch` for the stand-in Agent. */
  run(input: string, extra?: { dry_run?: boolean }): Promise<unknown>
  /** Run `apply_patch` through the tool runtime without an Agent. */
  execute(input: string): Promise<ToolExecutionResult>
  /** Dispose only the plugin under test. */
  disposePlugin(): Promise<void>
  dispose(): Promise<void>
}

/**
 * Mount the composition over a fresh temp directory.
 * @param options - plugin config and whether to mount a shell.
 * @returns the harness.
 */
export async function harness(options: { config?: Config; shell?: boolean; extra?: (ctx: Context) => Promise<void> } = {}): Promise<Harness> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-apply-patch-')))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(FsLocal.default ?? FsLocal, { cwd: dir })
  await ctx.plugin(Observation)
  if (options.shell !== false) {
    await ctx.plugin(LocalSubprocess)
    await ctx.plugin(Bash)
  }
  if (options.extra !== undefined) await options.extra(ctx)
  const fiber = await ctx.plugin(Plugin, options.config ?? {})
  await new Promise(resolve => setTimeout(resolve, 50))
  const fs = ctx.get('fs') as FileSystem
  const agent = { session: { id: 'session-test', header: { cwd: dir } } }
  let call = 0
  const tool = () => {
    const definition = ctx.tools.get('apply_patch')
    if (definition === undefined) throw new Error('apply_patch is not registered')
    return definition
  }
  return {
    ctx, dir, agent, fs,
    async observe(path) {
      const target = await fs.resolve(path, { cwd: dir })
      const info = await fs.stat(target)
      if (info === undefined) throw new Error(`no ${path}`)
      ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, { agent })
    },
    async run(input, extra = {}) {
      call += 1
      const exec = {
        callId: `call-${call}`, rootCallId: `call-${call}`, name: 'apply_patch', arguments: { input, ...extra },
        agent, signal: new AbortController().signal, token: Symbol('t'), deferContext: () => undefined,
      } as unknown as ToolRunContext
      return tool().execute({ input, ...extra }, exec)
    },
    async execute(input) {
      call += 1
      return ctx.tools.execute({ callId: `call-${call}` as never, name: 'apply_patch', arguments: { input }, signal: new AbortController().signal })
    },
    async disposePlugin() {
      await fiber.dispose()
    },
    async dispose() {
      await ctx.fiber.dispose()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
