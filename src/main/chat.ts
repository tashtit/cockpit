import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import type { BusySession, ChatEvent, ChatRequest, ModelEndpoint, Provider } from '../shared/types'
import { endpointEnv, endpointSupports } from '../shared/endpoints'
import { contentToText, toolPreview, truncate } from './parsers/util'
import { cliEnv } from './env'

type Emit = (ev: ChatEvent) => void
type ResolveEndpoint = (id: string) => ModelEndpoint | undefined
/** Decrypts the endpoint's stored API key (index.ts wires this to the keychain store). */
type ResolveKey = (ep: ModelEndpoint) => string | undefined

/**
 * Session ids are parsed out of provider log files that other tools write — treat them
 * as semi-untrusted and never let one become a CLI flag (e.g. "--dangerously-...").
 */
export function isValidNativeId(id: string): boolean {
  return /^[A-Za-z0-9._-]{1,128}$/.test(id) && !id.startsWith('-')
}

/** Model names are renderer-supplied free text — keep them argv-safe. */
export function isValidModel(model: string): boolean {
  return /^[A-Za-z0-9._:\/-]{1,64}$/.test(model) && !model.startsWith('-')
}

const CODEX_SANDBOXES = new Set(['read-only', 'workspace-write', 'danger-full-access'])

/**
 * Fold attached images into the prompt as file references. All three CLIs view a
 * referenced image through their own file-reading tools, and it is the one mechanism
 * that works everywhere (codex `exec resume` accepts no --image flag). An image-only
 * turn still produces a non-empty prompt. Exported for tests.
 */
export function promptWithImages(req: ChatRequest): string {
  const images = req.images ?? []
  if (images.length === 0) return req.prompt
  const refs = images.map((p) => `[Attached image — view the file at ${p}]`).join('\n')
  return req.prompt ? `${req.prompt}\n\n${refs}` : refs
}

/** Build argv for each provider's headless one-turn invocation. */
export function buildCommand(req: ChatRequest): { cmd: string; args: string[] } {
  const model = req.options?.model && isValidModel(req.options.model) ? req.options.model : null
  switch (req.provider) {
    case 'claude': {
      const args = ['-p', '--output-format', 'stream-json', '--verbose']
      if (model) args.push('--model', model)
      if (req.permissionMode === 'auto-edit') args.push('--permission-mode', 'acceptEdits')
      if (req.permissionMode === 'yolo') args.push('--dangerously-skip-permissions')
      if (req.resumeNativeId) args.push('--resume', req.resumeNativeId)
      args.push(promptWithImages(req))
      return { cmd: 'claude', args }
    }
    case 'codex': {
      const resume = req.resumeNativeId
      const args = resume ? ['exec', 'resume', resume, '--json'] : ['exec', '--json']
      if (model) args.push('--model', model)
      const requested = req.options?.codexSandbox
      // --full-auto was removed from `codex exec`; auto-edit maps to its old meaning
      const sandbox =
        requested && CODEX_SANDBOXES.has(requested)
          ? requested
          : req.permissionMode === 'auto-edit'
            ? 'workspace-write'
            : null
      if (sandbox && req.permissionMode !== 'yolo') {
        // `exec resume` accepts no --sandbox flag — only the -c config override form
        if (resume) args.push('-c', `sandbox_mode="${sandbox}"`)
        else args.push('--sandbox', sandbox)
      }
      if (req.permissionMode === 'yolo') args.push('--dangerously-bypass-approvals-and-sandbox')
      args.push(promptWithImages(req))
      return { cmd: 'codex', args }
    }
    case 'copilot': {
      const args = ['-p', promptWithImages(req)]
      if (model) args.push('--model', model)
      if (req.permissionMode !== 'safe') args.push('--allow-all-tools')
      if (req.resumeNativeId) args.push('--resume', req.resumeNativeId)
      return { cmd: 'copilot', args }
    }
  }
}

/** Parse one claude stream-json line into chat events. Exported for tests. */
export function parseClaudeStreamLine(turnId: string, line: any): ChatEvent[] {
  const out: ChatEvent[] = []
  if (line?.type === 'system' && line.subtype === 'init' && line.session_id) {
    out.push({ turnId, type: 'session', nativeSessionId: String(line.session_id) })
  } else if (line?.type === 'assistant') {
    const content = line.message?.content
    const text = contentToText(content)
    if (text) out.push({ turnId, type: 'text', text })
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b?.type === 'tool_use') {
          const preview = toolPreview(b.name ?? 'tool', b.input)
          out.push({
            turnId,
            type: 'tool',
            toolName: b.name ?? 'tool',
            detail: truncate(JSON.stringify(b.input ?? {}), 200),
            ...(preview ? { preview: truncate(preview, 200) } : {})
          })
        }
      }
    }
  } else if (line?.type === 'result') {
    if (line.session_id) out.push({ turnId, type: 'session', nativeSessionId: String(line.session_id) })
    out.push({ turnId, type: 'done', costUsd: typeof line.total_cost_usd === 'number' ? line.total_cost_usd : undefined })
  }
  return out
}

/** Parse one codex exec --json line into chat events. Handles old and new event shapes. Exported for tests. */
export function parseCodexStreamLine(turnId: string, line: any): ChatEvent[] {
  const out: ChatEvent[] = []
  // new shape: {type:"thread.started",thread_id} / {type:"item.completed",item:{...}} / {type:"turn.completed"}
  if (line?.thread_id && (line.type === 'thread.started' || line.type === 'session.created')) {
    out.push({ turnId, type: 'session', nativeSessionId: String(line.thread_id) })
  } else if (line?.type === 'item.completed' && line.item) {
    const it = line.item
    if ((it.type === 'agent_message' || it.item_type === 'assistant_message') && (it.text || it.message))
      out.push({ turnId, type: 'text', text: String(it.text ?? it.message) })
    if (it.type === 'command_execution')
      out.push({ turnId, type: 'tool', toolName: 'shell', detail: truncate(String(it.command ?? ''), 200) })
    if (it.type === 'file_change')
      out.push({ turnId, type: 'tool', toolName: 'edit', detail: truncate(JSON.stringify(it.changes ?? ''), 200) })
  } else if (line?.type === 'turn.completed') {
    out.push({ turnId, type: 'done' })
  }
  // old shape: {id, msg:{type:"agent_message",message}} / {msg:{type:"session_configured",session_id}}
  else if (line?.msg?.type) {
    const m = line.msg
    if (m.type === 'session_configured' && m.session_id)
      out.push({ turnId, type: 'session', nativeSessionId: String(m.session_id) })
    if (m.type === 'agent_message' && m.message)
      out.push({ turnId, type: 'text', text: String(m.message) })
    if (m.type === 'exec_command_begin' && m.command)
      out.push({ turnId, type: 'tool', toolName: 'shell', detail: truncate(Array.isArray(m.command) ? m.command.join(' ') : String(m.command), 200) })
    if (m.type === 'task_complete') out.push({ turnId, type: 'done' })
  }
  return out
}

/**
 * Validate a BYOK turn before spawning. Returns a human-readable refusal, or null when
 * the turn may proceed. `keyResolved` says whether the endpoint's stored key decrypted
 * successfully. Exported for tests.
 */
export function endpointPreflight(
  req: ChatRequest,
  ep: ModelEndpoint | undefined,
  keyResolved: boolean
): string | null {
  if (!req.options?.modelEndpoint) return null
  if (!ep) return 'Custom model provider is no longer configured — pick another in Settings.'
  if (!endpointSupports(req.provider, ep)) {
    return `Provider "${ep.label}" (${ep.type}) can't be used with ${req.provider}.`
  }
  if (ep.hasKey && !keyResolved) {
    return `The stored API key for "${ep.label}" could not be read from the OS keychain — re-add the provider in Settings.`
  }
  const model = req.options.model
  if (req.provider === 'copilot' && !(model && isValidModel(model))) {
    return `Provider "${ep.label}" needs an explicit model — pick one in the session form.`
  }
  return null
}

type RunningTurn = {
  readonly child: ChildProcess
  /** Flipped when the CLI emits its done event — mutable turn state on purpose */
  doneSent: boolean
  readonly provider: Provider
  /** Epoch ms this turn was spawned — surfaces as elapsed time on the board */
  readonly startedAt: number
  /** Native session ids this turn is known under — the resumed id plus any the
   *  stream announces (claude forks a fresh id per resumed turn). */
  readonly sessionIds: Set<string>
}

/** Optional collaborators wired by index.ts (busy board + BYOK endpoint/keychain store). */
type ChatManagerHooks = {
  readonly onBusyChange?: (sessions: BusySession[]) => void
  readonly resolveEndpoint?: ResolveEndpoint
  readonly resolveKey?: ResolveKey
}

export class ChatManager {
  private turns = new Map<string, RunningTurn>()
  private readonly emit: Emit
  private readonly hooks: ChatManagerHooks

  constructor(emit: Emit, hooks: ChatManagerHooks = {}) {
    this.emit = emit
    this.hooks = hooks
  }

  /** Sessions with a provider process currently running (earliest start wins on overlap). */
  busySessions(): BusySession[] {
    const byId = new Map<string, number>()
    for (const t of this.turns.values()) {
      for (const nativeId of t.sessionIds) {
        const id = `${t.provider}:${nativeId}`
        const prev = byId.get(id)
        if (prev === undefined || t.startedAt < prev) byId.set(id, t.startedAt)
      }
    }
    return [...byId].map(([id, startedAt]) => ({ id, startedAt }))
  }

  private notifyBusy(): void {
    this.hooks.onBusyChange?.(this.busySessions())
  }

  send(req: ChatRequest): string {
    const turnId = randomUUID()
    if (req.resumeNativeId && !isValidNativeId(req.resumeNativeId)) {
      queueMicrotask(() => {
        this.emit({ turnId, type: 'error', message: 'Refusing to resume: session id in the log looks malformed.' })
        this.emit({ turnId, type: 'done' })
      })
      return turnId
    }
    try {
      if (!statSync(req.cwd).isDirectory()) throw new Error('not a directory')
    } catch {
      queueMicrotask(() => {
        this.emit({ turnId, type: 'error', message: `Working directory no longer exists: ${req.cwd}` })
        this.emit({ turnId, type: 'done' })
      })
      return turnId
    }
    const { cmd, args } = buildCommand(req)
    const env = cliEnv()
    // BYOK: resolve the endpoint and its key, refuse loudly rather than silently
    // falling back to the provider's own backend
    const ep = req.options?.modelEndpoint
      ? this.hooks.resolveEndpoint?.(req.options.modelEndpoint)
      : undefined
    const apiKey = ep ? this.hooks.resolveKey?.(ep) : undefined
    const refusal = endpointPreflight(req, ep, Boolean(apiKey))
    if (refusal) {
      queueMicrotask(() => {
        this.emit({ turnId, type: 'error', message: refusal })
        this.emit({ turnId, type: 'done' })
      })
      return turnId
    }
    if (ep) Object.assign(env, endpointEnv(req.provider, ep, apiKey))
    // per-account config homes: each provider has its own env var for this
    if (req.configDir) {
      if (req.provider === 'claude') env.CLAUDE_CONFIG_DIR = req.configDir
      else if (req.provider === 'codex') env.CODEX_HOME = req.configDir
      else env.COPILOT_HOME = req.configDir
    }
    const child = spawn(cmd, args, {
      cwd: req.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      // own process group so cancel() can reach grandchildren (bash tools, MCP servers)
      detached: true
    })
    const turn: RunningTurn = {
      child,
      doneSent: false,
      provider: req.provider,
      startedAt: Date.now(),
      sessionIds: new Set(req.resumeNativeId ? [req.resumeNativeId] : [])
    }
    this.turns.set(turnId, turn)
    this.notifyBusy()

    const sendDone = (): void => {
      if (!turn.doneSent) {
        turn.doneSent = true
        this.emit({ turnId, type: 'done' })
      }
    }

    let buf = ''
    let sawStructured = false
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => {
      if (req.provider === 'copilot') {
        // copilot -p streams plain text
        this.emit({ turnId, type: 'text', text: chunk })
        return
      }
      buf += chunk
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const raw = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!raw) continue
        let parsed: any
        try {
          parsed = JSON.parse(raw)
        } catch {
          this.emit({ turnId, type: 'text', text: raw })
          continue
        }
        sawStructured = true
        const events =
          req.provider === 'claude'
            ? parseClaudeStreamLine(turnId, parsed)
            : parseCodexStreamLine(turnId, parsed)
        for (const ev of events) {
          if (ev.type === 'done') turn.doneSent = true
          if (ev.type === 'session' && !turn.sessionIds.has(ev.nativeSessionId)) {
            turn.sessionIds.add(ev.nativeSessionId)
            this.notifyBusy()
          }
          this.emit(ev)
        }
      }
    })

    let errBuf = ''
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (c: string) => {
      errBuf = (errBuf + c).slice(-4000)
    })

    child.on('error', (err) => {
      this.emit({
        turnId,
        type: 'error',
        message:
          (err as NodeJS.ErrnoException).code === 'ENOENT'
            ? `'${cmd}' not found on PATH — is the ${req.provider} CLI installed?`
            : String(err)
      })
      sendDone()
      this.turns.delete(turnId)
      this.notifyBusy()
    })

    child.on('close', (code) => {
      // flush a final line that arrived without a trailing newline — it can carry the
      // session_id / result event, without which resume breaks
      const rest = buf.trim()
      if (rest && sawStructured) {
        try {
          const parsed = JSON.parse(rest)
          const events =
            req.provider === 'claude'
              ? parseClaudeStreamLine(turnId, parsed)
              : parseCodexStreamLine(turnId, parsed)
          for (const ev of events) {
            if (ev.type === 'done') turn.doneSent = true
            this.emit(ev)
          }
          buf = ''
        } catch {
          /* not a complete JSON line */
        }
      }
      if (code !== 0 && !turn.doneSent) {
        this.emit({
          turnId,
          type: 'error',
          message: `${cmd} exited with code ${code}${errBuf ? `:\n${errBuf.trim()}` : ''}`
        })
      }
      if (!sawStructured && req.provider !== 'copilot' && code === 0 && buf.trim()) {
        this.emit({ turnId, type: 'text', text: buf.trim() })
      }
      sendDone()
      this.turns.delete(turnId)
      this.notifyBusy()
    })

    return turnId
  }

  cancel(turnId: string): void {
    const t = this.turns.get(turnId)
    if (!t) return
    this.turns.delete(turnId)
    this.notifyBusy()
    const pid = t.child.pid
    // kill the whole process group (agent CLIs spawn bash tools / MCP servers)
    const signal = (sig: NodeJS.Signals): void => {
      try {
        if (pid) process.kill(-pid, sig)
        else t.child.kill(sig)
      } catch {
        t.child.kill(sig)
      }
    }
    signal('SIGTERM')
    const hardKill = setTimeout(() => {
      if (t.child.exitCode === null && !t.child.killed) signal('SIGKILL')
    }, 3000)
    t.child.once('close', () => clearTimeout(hardKill))
  }

  cancelAll(): void {
    for (const [id] of this.turns) this.cancel(id)
  }
}
