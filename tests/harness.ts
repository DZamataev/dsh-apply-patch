/**
 * Real DSH composition for integration tests: tool runtime, fs-local (or the
 * sandboxing fs-sandbox with sandbox-policy), fs-observation-policy and a
 * local bash shell over a temp directory. Hooks interpose on the mounted
 * `fs` and `shell` instances to simulate external changes and failures.
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
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { ShellResult } from '@deepseek-ai/dsh-shell'
import * as Observation from '@deepseek-ai/dsh-fs-observation-policy'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import Bash from '@deepseek-ai/dsh-bash-local'
import * as Plugin from '../src/index.js'
import type { Config } from '../src/config.js'

type FsMethod = 'stat' | 'readText' | 'writeText'

export interface Harness {
  ctx: Context
  dir: string
  /** A stand-in Agent: the observation policy keys state by `agent.session`. */
  agent: { session: { id: string; header: { cwd: string } } }
  fs: FileSystem
  /** Record a `read` of `path`, as the native read tool does. */
  observe(path: string): Promise<void>
  /** Run `apply_patch` for the stand-in Agent. */
  run(input: string, extra?: { dry_run?: boolean }, signal?: AbortSignal): Promise<unknown>
  /** Run `apply_patch` through the tool runtime without an Agent. */
  execute(input: string): Promise<ToolExecutionResult>
  /**
   * Run `action` around the `nth` (1-based) call of `fs[method]` made after this
   * call: `before` runs before the call starts, `after` once it has settled.
   */
  onFs(method: FsMethod, nth: number, action: () => void, when?: 'before' | 'after'): void
  /** Replace the result of every later shell command with `map(result, n)`, `n` counting from 1. */
  mapShell(map: (result: ShellResult, n: number) => ShellResult): void
  /** Dispose only the plugin under test. */
  disposePlugin(): Promise<void>
  dispose(): Promise<void>
}

/**
 * Mount the composition over a fresh temp directory.
 * @param options - plugin config, whether to mount a shell, an fs sandbox mode, extra services.
 * @returns the harness.
 */
export async function harness(options: { config?: Config; shell?: boolean; sandbox?: SandboxMode; extra?: (ctx: Context) => Promise<void> } = {}): Promise<Harness> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-apply-patch-')))
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  if (options.sandbox === undefined) {
    await ctx.plugin(FsLocal.default ?? FsLocal, { cwd: dir })
  } else {
    // The policy service registers a session projection; the stand-in session has no log, so no override.
    ctx.provide('sessionProjections')
    ctx.set('sessionProjections', { register: () => () => undefined, stateOf: () => undefined })
    await ctx.plugin(SandboxPolicyService, { mode: options.sandbox, workspaceRoot: dir })
    await ctx.plugin(SandboxedFileSystem, { cwd: dir })
  }
  await ctx.plugin(Observation)
  if (options.shell !== false) {
    await ctx.plugin(LocalSubprocess)
    await ctx.plugin(Bash)
  }
  if (options.extra !== undefined) await options.extra(ctx)
  const fiber = await ctx.plugin(Plugin, options.config ?? {})
  await new Promise(resolve => setTimeout(resolve, 50))
  const fs = ctx.get('fs') as FileSystem
  if (options.sandbox !== undefined && fs.sandboxMode !== options.sandbox) throw new Error('the sandboxed fs is not mounted')
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
    async run(input, extra = {}, signal = new AbortController().signal) {
      call += 1
      const exec = {
        callId: `call-${call}`, rootCallId: `call-${call}`, name: 'apply_patch', arguments: { input, ...extra },
        agent, signal, token: Symbol('t'), deferContext: () => undefined,
      } as unknown as ToolRunContext
      return tool().execute({ input, ...extra }, exec)
    },
    async execute(input) {
      call += 1
      return ctx.tools.execute({ callId: `call-${call}` as never, name: 'apply_patch', arguments: { input }, signal: new AbortController().signal })
    },
    onFs(method, nth, action, when = 'after') {
      const original = (fs[method] as (...args: unknown[]) => Promise<unknown>).bind(fs)
      let count = 0
      Object.assign(fs, {
        [method]: async (...args: unknown[]) => {
          count += 1
          if (count !== nth) return original(...args)
          if (when === 'before') action()
          try {
            return await original(...args)
          } finally {
            if (when === 'after') action()
          }
        },
      })
    },
    mapShell(map) {
      const shell = ctx.get('shell') as { execute(spec: unknown): Promise<{ result(): Promise<ShellResult> }> }
      const original = shell.execute.bind(shell)
      let count = 0
      Object.assign(shell, {
        execute: async (spec: unknown) => {
          const running = await original(spec)
          const n = ++count
          return { ...running, result: async () => map(await running.result(), n) }
        },
      })
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
