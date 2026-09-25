import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import type {
  AcpAgent,
  BusySession,
  ChatEvent,
  ChatRequest,
  ModelEndpoint,
  Provider
} from '../shared/types'
import { AcpTurn } from './acp'
import {
  endpointEnv,
  endpointSupports,
  isBlockedEndpointHost,
  isValidModel
} from '../shared/endpoints'
import { parseAsks } from '../shared/asks'
import { LineSplitter, capText, contentToText, shellPreview, toolPreview, truncate } from './parsers/util'
import { fileChangeArtifact, todoListArtifact, toolArtifact } from './parsers/artifacts'
import { commandItemCheck } from './parsers/checks'
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

export { isValidModel } from '../shared/endpoints'
import { EFFORT_LEVELS } from '../shared/agent-models'

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
/**
 * The thinking level, re-checked here against the provider's own list: it reaches the
 * CLI as an argv value (or a `-c` config value), so only a known word ever gets there.
 */
function effortOf(req: ChatRequest): string | null {
  const e = req.options?.effort
  return e && EFFORT_LEVELS[req.provider].includes(e) ? e : null
}

/**
 * Copilot's per-turn knobs as flags. Shared by the headless command and the built-in
 * ACP agent (`copilot --acp` takes the same flags), so a seat's model is honoured
 * whichever transport runs it.
 */
export function copilotFlags(req: ChatRequest): string[] {
  const out: string[] = []
  const model = req.options?.model && isValidModel(req.options.model) ? req.options.model : null
  if (model) out.push('--model', model)
  const effort = effortOf(req)
  if (effort) out.push('--reasoning-effort', effort)
  if (req.options?.longContext) out.push('--context', 'long_context')
  return out
}

/**
 * The ACP agent a turn actually spawns. The built-in `copilot --acp` takes the CLI's
 * own flags, so the turn's model, thinking level and context ride on it — without them
 * a Copilot seat over ACP ran on the default model whatever was picked. A user-defined
 * agent is any binary, so nothing is ever appended to it. Exported for tests.
 */
export function withTurnFlags(agent: AcpAgent | undefined, req: ChatRequest): AcpAgent | undefined {
  if (!agent?.builtin || agent.provider !== 'copilot') return agent
  return { ...agent, args: [...(agent.args ?? []), ...copilotFlags(req)] }
}

/**
 * What a safe-mode Claude seat may use without an approval nobody is there to give: web
 * search and page fetches. Research only — reading the workspace needs no allowance, and
 * the shell stays refused because no rule can keep a command read-only.
 */
export const CLAUDE_RESEARCH_TOOLS: readonly string[] = ['WebSearch', 'WebFetch']

export function buildCommand(req: ChatRequest): { cmd: string; args: string[] } {
  const model = req.options?.model && isValidModel(req.options.model) ? req.options.model : null
  const effort = effortOf(req)
  switch (req.provider) {
    case 'claude': {
      const args = ['-p', '--output-format', 'stream-json', '--verbose']
      if (model) args.push('--model', model)
      if (effort) args.push('--effort', effort)
      if (req.permissionMode === 'auto-edit') args.push('--permission-mode', 'acceptEdits')
      if (req.permissionMode === 'yolo') args.push('--dangerously-skip-permissions')
      if (req.research && req.permissionMode === 'safe') args.push('--allowedTools', CLAUDE_RESEARCH_TOOLS.join(','))
      if (req.resumeNativeId) args.push('--resume', req.resumeNativeId)
      // after `--`: a message that starts with "-" (a pasted list, or typed flags) is
      // otherwise parsed as options — claude refuses "- fix this" as an unknown one
      args.push('--', promptWithImages(req))
      return { cmd: 'claude', args }
    }
    case 'codex': {
      const resume = req.resumeNativeId
      const args = resume ? ['exec', 'resume', resume, '--json'] : ['exec', '--json']
      // both `exec` and `exec resume` take this flag (verified against codex --help)
      if (req.options?.codexSkipGitCheck) args.push('--skip-git-repo-check')
      if (model) args.push('--model', model)
      // no flags for these: the config-override form works for `exec` and `exec resume`
      if (effort) args.push('-c', `model_reasoning_effort="${effort}"`)
      if (req.options?.fast) args.push('-c', 'service_tier="priority"')
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
      args.push('--', promptWithImages(req))
      return { cmd: 'codex', args }
    }
    case 'copilot': {
      // joined to its flag: `-p "- fix this"` reads the prompt as an option, and
      // copilot takes no `--` before an option's value
      const args = [`--prompt=${promptWithImages(req)}`, ...copilotFlags(req)]
      if (req.permissionMode !== 'safe') args.push('--allow-all-tools')
      // headless, nothing can ask — so auto-edit's "anything that executes still asks"
      // means shell is refused here, as it is for claude's acceptEdits under -p
      if (req.permissionMode === 'auto-edit') args.push('--deny-tool', 'shell')
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
          // a question the CLI can't answer itself rides along with its options, so
          // the chat can offer them as picks rather than a JSON blob
          const asks = parseAsks(b.name ?? '', b.input)
          const artifact = toolArtifact(b.name ?? '', b.input)
          out.push({
            turnId,
            type: 'tool',
            toolName: b.name ?? 'tool',
            detail: truncate(JSON.stringify(b.input ?? {}), 200),
            ...(preview ? { preview: truncate(preview, 200) } : {}),
            ...(asks ? { asks } : {}),
            ...(artifact ? { artifact } : {})
          })
        }
      }
    }
  } else if (line?.type === 'result') {
    if (line.session_id) out.push({ turnId, type: 'session', nativeSessionId: String(line.session_id) })
    // error results (is_error / subtype error_*) still end the turn, but silently
    // swallowing them would make a failed turn look like a successful empty one
    if (line.is_error) {
      const detail =
        typeof line.result === 'string' && line.result.trim()
          ? line.result.trim()
          : String(line.subtype ?? 'unknown error')
      out.push({ turnId, type: 'error', message: `claude reported an error: ${truncate(detail, 500)}` })
    }
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
    if (it.type === 'command_execution') {
      const preview = shellPreview(it.command)
      // a check streams in finished, its exit code with it
      const artifact = commandItemCheck(it)
      out.push({
        turnId,
        type: 'tool',
        toolName: 'shell',
        detail: truncate(String(it.command ?? ''), 200),
        ...(preview ? { preview: truncate(preview, 200) } : {}),
        ...(artifact ? { artifact } : {})
      })
    }
    if (it.type === 'file_change') {
      // the files a change touched, not its JSON — the raw list stays in the detail
      const paths = Array.isArray(it.changes)
        ? it.changes.map((c: { path?: unknown }) => c?.path).filter((p: unknown): p is string => typeof p === 'string')
        : []
      // the stream names the files and what happened to each, never the lines. Named
      // the way the rollout's FileChange row is (`apply_patch`, the files it touches),
      // so a rejoined turn can tell the streamed row and the logged one are the same
      const artifact = fileChangeArtifact(it.changes)
      out.push({
        turnId,
        type: 'tool',
        toolName: 'apply_patch',
        detail: truncate(JSON.stringify(it.changes ?? ''), 200),
        ...(paths.length > 0 ? { preview: truncate(`apply_patch ${paths.join(', ')}`, 200) } : {}),
        ...(artifact ? { artifact } : {})
      })
    }
    if (it.type === 'todo_list') {
      // the agent's running plan, always the whole list — it replaces the last one
      const artifact = todoListArtifact(it.items)
      const items = Array.isArray(it.items) ? it.items.length : 0
      if (artifact)
        out.push({
          turnId,
          type: 'tool',
          toolName: 'update_plan',
          detail: truncate(JSON.stringify(it.items ?? []), 200),
          preview: `${items} ${items === 1 ? 'step' : 'steps'}`,
          artifact
        })
    }
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
    if (m.type === 'exec_command_begin' && m.command) {
      const preview = shellPreview(m.command)
      out.push({
        turnId,
        type: 'tool',
        toolName: 'shell',
        detail: truncate(Array.isArray(m.command) ? m.command.join(' ') : String(m.command), 200),
        ...(preview ? { preview: truncate(preview, 200) } : {})
      })
    }
    if (m.type === 'task_complete') out.push({ turnId, type: 'done' })
  }
  return out
}

/** Hostname of a stored base URL; '' when it no longer parses (then nothing matches). */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname
  } catch {
    return ''
  }
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
  if (!ep) return 'Custom model provider is no longer configured — re-add it in Settings.'
  // an endpoint stored before the host guard existed (or hand-edited into config)
  // must not be spawned against either — the CLI would carry the key there
  if (isBlockedEndpointHost(hostOf(ep.baseUrl))) {
    return `Provider "${ep.label}" points at a link-local address — remove it in Settings.`
  }
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
  /** Set when the turn is driven over ACP: it answers permission questions and can be
   *  asked to stop through the protocol before anything is signalled. */
  readonly acp?: AcpTurn
}

/** Optional collaborators wired by index.ts (busy board, attention, BYOK endpoint/keychain store). */
type ChatManagerHooks = {
  readonly onBusyChange?: (sessions: BusySession[]) => void
  /** Every turn, before any of its events — fast failures included */
  readonly onTurnStart?: (turnId: string, req: ChatRequest) => void
  /** cancel() was called: the error and done that follow are the kill, not a failure */
  readonly onTurnCancel?: (turnId: string) => void
  readonly resolveEndpoint?: ResolveEndpoint
  readonly resolveKey?: ResolveKey
  /** The ACP agent to drive this request with, or undefined for the CLI's own flags */
  readonly resolveAcpAgent?: (req: ChatRequest) => AcpAgent | undefined
}

/** What an ACP turn is started with: the agent, the inherited env, and what the turn itself sets. */
type AcpLaunch = {
  readonly agent: AcpAgent
  readonly env: NodeJS.ProcessEnv
  readonly pinned: Readonly<Record<string, string>>
}

export class ChatManager {
  private turns = new Map<string, RunningTurn>()
  private readonly emit: Emit
  private readonly hooks: ChatManagerHooks

  constructor(emit: Emit, hooks: ChatManagerHooks = {}) {
    this.emit = emit
    this.hooks = hooks
  }

  /**
   * Sessions with a provider process currently running, each with the turn still live
   * on it — the one a window can rejoin. Two processes on one session (a finished turn's
   * still exiting as the next starts): the live turn speaks for it, else the earlier.
   */
  busySessions(): BusySession[] {
    type Entry = { readonly startedAt: number; readonly turnId: string | null }
    const wins = (a: Entry, b: Entry): boolean =>
      (a.turnId === null) !== (b.turnId === null) ? a.turnId !== null : a.startedAt < b.startedAt
    const byId = new Map<string, Entry>()
    for (const [turnId, t] of this.turns) {
      const entry: Entry = { startedAt: t.startedAt, turnId: t.doneSent ? null : turnId }
      for (const nativeId of t.sessionIds) {
        const id = `${t.provider}:${nativeId}`
        const prev = byId.get(id)
        if (prev === undefined || wins(entry, prev)) byId.set(id, entry)
      }
    }
    return [...byId].map(([id, e]) => ({ id, ...e, source: 'spawned' as const }))
  }

  /**
   * The turn in flight on this session, if there is one: known under the id it resumed
   * and every id its stream announced. A turn that has said it is done no longer counts
   * — its process may take a moment to exit, and a follow-up must not wait on that.
   */
  turnFor(provider: Provider, nativeId: string): string | null {
    for (const [turnId, t] of this.turns) {
      if (!t.doneSent && t.provider === provider && t.sessionIds.has(nativeId)) return turnId
    }
    return null
  }

  /**
   * Every turn this manager has in flight, roundtable seats included — unlike
   * `busySessions()`, which can only name the ones whose session id is known (a
   * Copilot turn never announces one). What quitting would stop.
   */
  runningTurns(): number {
    return this.turns.size
  }

  private notifyBusy(): void {
    this.hooks.onBusyChange?.(this.busySessions())
  }

  /**
   * One conversation, one turn: a second CLI resuming a session that is mid-turn would
   * write two turns into one log at once. A window that comes back to a running session
   * rejoins its turn (BusySession.turnId); this is the backstop for one that didn't.
   * Thrown, not emitted — no turn exists to carry the events.
   */
  assertNotRunning(req: ChatRequest): void {
    if (req.resumeNativeId && this.turnFor(req.provider, req.resumeNativeId)) {
      throw new Error('This session already has a turn running — wait for it to finish, or stop it.')
    }
  }

  send(req: ChatRequest): string {
    // before a turn exists, so the attention desk is never told of one that won't run
    this.assertNotRunning(req)
    const turnId = randomUUID()
    // synchronous, so it runs before the microtask a refused turn emits its events in
    this.hooks.onTurnStart?.(turnId, req)
    try {
      this.start(turnId, req)
    } catch (err) {
      // a refusal below ends as events; so must a throw — a removed ACP agent, or a
      // prompt past the OS argument limit, which spawn throws synchronously (E2BIG).
      // Rethrown, the turn the attention desk was just told about never ended, and it
      // muted every observed ending of that session until a restart.
      queueMicrotask(() => {
        this.emit({ turnId, type: 'error', message: startFailure(err) })
        this.emit({ turnId, type: 'done' })
      })
    }
    return turnId
  }

  private start(turnId: string, req: ChatRequest): void {
    if (req.resumeNativeId && !isValidNativeId(req.resumeNativeId)) {
      queueMicrotask(() => {
        this.emit({ turnId, type: 'error', message: 'Refusing to resume: session id in the log looks malformed.' })
        this.emit({ turnId, type: 'done' })
      })
      return
    }
    try {
      if (!statSync(req.cwd).isDirectory()) throw new Error('not a directory')
    } catch {
      queueMicrotask(() => {
        this.emit({ turnId, type: 'error', message: `Working directory no longer exists: ${req.cwd}` })
        this.emit({ turnId, type: 'done' })
      })
      return
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
      return
    }
    // what this turn itself decides: the BYOK endpoint and the account's config home
    const pinned: Record<string, string> = ep ? { ...endpointEnv(req.provider, ep, apiKey) } : {}
    // per-account config homes: each provider has its own env var for this
    if (req.configDir) {
      if (req.provider === 'claude') pinned.CLAUDE_CONFIG_DIR = req.configDir
      else if (req.provider === 'codex') pinned.CODEX_HOME = req.configDir
      else pinned.COPILOT_HOME = req.configDir
    }
    // ACP: the same turn, driven over the agent's protocol instead of its headless
    // flags. Everything above — cwd checks, BYOK env, the config home — has already
    // been applied, and the agent inherits it as its environment.
    const acpAgent = withTurnFlags(this.hooks.resolveAcpAgent?.(req), req)
    if (acpAgent) {
      this.startAcpTurn(turnId, req, { agent: acpAgent, env, pinned })
      return
    }
    Object.assign(env, pinned)

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

    // bounded and linear however long a line runs (see LineSplitter)
    const stdout = new LineSplitter()
    let sawStructured = false
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => {
      if (req.provider === 'copilot') {
        // copilot -p streams plain text
        this.emit({ turnId, type: 'text', text: chunk })
        return
      }
      const { lines, dropped } = stdout.push(chunk)
      if (dropped > 0) console.warn(`[chat] ${cmd}: dropped ${dropped} stream line(s) over the size cap`)
      for (const line of lines) {
        const raw = line.trim()
        if (!raw) continue
        let parsed: any
        try {
          parsed = JSON.parse(raw)
        } catch {
          // a banner or a warning, not an event — shown, but no bigger than any message
          this.emit({ turnId, type: 'text', text: capText(raw) })
          continue
        }
        sawStructured = true
        let events: ChatEvent[]
        try {
          events =
            req.provider === 'claude'
              ? parseClaudeStreamLine(turnId, parsed)
              : parseCodexStreamLine(turnId, parsed)
        } catch (err) {
          // one event the parser cannot read (an input nested past what it can
          // serialise) is skipped; thrown out of a stream handler it took down main
          console.error(`[chat] ${cmd}: unreadable stream event skipped:`, err)
          continue
        }
        for (const ev of events) this.deliver(turn, ev)
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
      let rest = stdout.rest().trim()
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
          rest = ''
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
      if (!sawStructured && req.provider !== 'copilot' && code === 0 && rest) {
        this.emit({ turnId, type: 'text', text: capText(rest) })
      }
      // a throw from a listener must not leave the turn on the busy board forever
      try {
        sendDone()
      } finally {
        this.turns.delete(turnId)
        this.notifyBusy()
      }
    })
  }

  /**
   * Emit one event and keep the turn's bookkeeping with it: a session id the stream
   * announces is a new id this turn is busy under, and a `done` is what stops the close
   * handler from reporting a failure on top of it — and leaves nothing to rejoin while
   * the process exits.
   */
  private deliver(turn: RunningTurn, ev: ChatEvent): void {
    if (ev.type === 'done' && !turn.doneSent) {
      turn.doneSent = true
      this.notifyBusy()
    }
    if (ev.type === 'session' && !turn.sessionIds.has(ev.nativeSessionId)) {
      turn.sessionIds.add(ev.nativeSessionId)
      this.notifyBusy()
    }
    this.emit(ev)
  }

  /** Spawn and run an ACP turn, with the same busy/cancel bookkeeping as a CLI turn. */
  private startAcpTurn(
    turnId: string,
    req: ChatRequest,
    launch: AcpLaunch
  ): void {
    const { agent, env, pinned } = launch
    const acp = new AcpTurn(agent, {
      turnId,
      cwd: req.cwd,
      env,
      pinned,
      permissionMode: req.permissionMode,
      emit: (ev) => {
        const turn = this.turns.get(turnId)
        // a cancelled turn is already off the board; its trailing events are the kill
        if (turn) this.deliver(turn, ev)
      }
    })
    const turn: RunningTurn = {
      child: acp.child,
      doneSent: false,
      provider: req.provider,
      startedAt: Date.now(),
      sessionIds: new Set(req.resumeNativeId ? [req.resumeNativeId] : []),
      acp
    }
    this.turns.set(turnId, turn)
    this.notifyBusy()
    void acp.run(promptWithImages(req), req.resumeNativeId).then(() => {
      // run() reports every outcome as events and never rejects, so reaching here means
      // the turn is over one way or another
      if (!turn.doneSent) this.emit({ turnId, type: 'done' })
      this.turns.delete(turnId)
      this.notifyBusy()
    })
  }

  /**
   * Answer a permission question an ACP turn asked. Silently ignored for a turn that has
   * already ended — the click raced the agent giving up on it.
   */
  respondPermission(turnId: string, requestId: string, optionId: string): void {
    this.turns.get(turnId)?.acp?.respondPermission(requestId, optionId)
  }

  cancel(turnId: string): void {
    const t = this.turns.get(turnId)
    if (!t) return
    this.hooks.onTurnCancel?.(turnId)
    // over ACP the agent can be told to stop, and anything it is waiting on refused,
    // before the process group is signalled
    t.acp?.cancel()
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
    // The escalation goes to the group whether or not the CLI itself has gone: it
    // usually exits on SIGTERM at once, while a tool it started that ignores the
    // signal (a dev server, a test runner) is still in the group — and keyed to the
    // leader's exit, the SIGKILL was cancelled and that tool kept running, orphaned.
    // A group that is already empty makes this a no-op.
    setTimeout(() => signal('SIGKILL'), 3000).unref()
  }

  cancelAll(): void {
    for (const [id] of this.turns) this.cancel(id)
  }
}

/** Why a turn could not start, in words — a bare `spawn E2BIG` tells the user nothing. */
function startFailure(err: unknown): string {
  if ((err as NodeJS.ErrnoException | null)?.code === 'E2BIG') {
    return 'This message is too long to hand to the agent (past the system’s argument limit) — shorten it.'
  }
  return err instanceof Error ? err.message : String(err)
}
