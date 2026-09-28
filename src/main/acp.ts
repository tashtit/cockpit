import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import type {
  AcpAgent,
  AcpAgentProbe,
  AcpPermissionOption,
  ChatEvent,
  PermissionMode
} from '../shared/types'
import {
  acpUpdateToEvents,
  decidePermission,
  initializeParams,
  modeIdFor,
  permissionDetail,
  permissionOptions,
  promptResultEvents,
  unattendedOutcome,
  type PermissionOutcome
} from './acp-core'
import { cliEnv } from './env'
import { LineSplitter, MAX_STREAM_LINE_CHARS, truncate } from './parsers/util'

/**
 * One ACP conversation, for the length of one turn.
 *
 * ACP is built for a connection that outlives many turns, and Cockpit will want that
 * eventually. It does not take it yet on purpose: `ChatManager` is built around one child
 * process per turn — that is what `busySessions()` counts, what `cancel()` kills, and what
 * the attention desk hears start and stop. Spawning per turn keeps all of that true and
 * costs a process launch; `session/load` makes the conversation continuous regardless.
 * A pooled connection is the follow-up, not a prerequisite.
 *
 * Signing in is the agent's: an agent that answers a session with ACP's auth-required error
 * is asked, once and briefly, to sign in with the method its built-in names (`authMethod`,
 * which reuses the CLI's own login and never opens a browser), and otherwise the turn says
 * what to run (`signIn`). Every process Cockpit starts here — a turn's, and the launch-time
 * `probeAcpAgent` — runs in its own group and is ended as a group, since some agents
 * re-launch themselves as a child and some ignore EOF: SIGTERM, then SIGKILL for whatever
 * in the group still ignores it (`endGroup`). Quitting stops a turn through ChatManager,
 * and kills any probe still about (`stopAcpProbes`).
 */

type TurnOptions = {
  readonly turnId: string
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  /**
   * What the turn itself sets — a custom provider's base URL and key, the account's
   * config home. Applied over the definition's own env, which otherwise could send
   * the provider's key to a host of its choosing (ANTHROPIC_BASE_URL), or its own key
   * to the provider.
   */
  readonly pinned?: Readonly<Record<string, string>>
  readonly permissionMode: PermissionMode
  /**
   * Someone can answer this turn's permission questions in the chat. Unset — a roundtable
   * seat — every question the mode does not answer itself is refused (`unattendedOutcome`)
   * instead of put on a card nobody will see.
   */
  readonly asksPermissions?: boolean
  readonly emit: (ev: ChatEvent) => void
  /**
   * A resumed turn that cannot reopen its conversation fails rather than starting a
   * fresh one. Set for an agent Cockpit only reads: whether its ACP server knows a
   * session by the id its own store gives it is the agent's business, and a quiet new
   * session would answer the person without any of the history they are looking at.
   */
  readonly mustResume?: boolean
  /** How long the handshake may take (`HANDSHAKE_MS`, `OPEN_SESSION_MS`) — tests shorten them */
  readonly deadlines?: { readonly handshake?: number; readonly openSession?: number }
}

/**
 * How long an agent has to answer `initialize`, a turn's or a probe's: it needs nothing
 * but its process started, so one silent past this is stuck — or waiting on input nobody
 * can give it — and the turn fails rather than spinning until Stop.
 */
const HANDSHAKE_MS = 15_000

/**
 * How long opening the session may take once the agent has answered: `session/new` can
 * start the agent's own MCP servers, and `session/load` replays the whole conversation.
 */
const OPEN_SESSION_MS = 60_000

/** How long an agent has to exit on its own once its turn is over */
const EXIT_GRACE_MS = 2_000

/** How long a group sent SIGTERM has before SIGKILL — ChatManager.cancel's wait */
const KILL_AFTER_MS = 3_000

/** How long signing in with an agent's own method may take before the turn says how to sign in */
const AUTHENTICATE_MS = 15_000

type Pending = {
  readonly resolve: (value: unknown) => void
  readonly reject: (err: Error) => void
}

/** JSON-RPC over the child's stdio: newline-delimited objects, one per message. */
class JsonRpc {
  /** Bounded and linear however long a line runs; one past the cap fails the connection */
  private readonly lines = new LineSplitter()
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private closed: Error | null = null

  constructor(
    private readonly child: ChildProcess,
    private readonly onNotify: (method: string, params: unknown) => void,
    private readonly onRequest: (id: number | string, method: string, params: unknown) => void
  ) {
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => this.feed(chunk))
  }

  private feed(chunk: string): void {
    // failed: nothing more will be read, and holding on to it would grow without bound
    if (this.closed) return
    const { lines, dropped } = this.lines.push(chunk)
    // at once, not when the runaway line ends: an agent may never send its newline
    if (dropped > 0 || this.lines.isOverflowing()) {
      this.lines.rest()
      this.fail(new Error(`the agent sent a single message larger than ${MAX_STREAM_LINE_CHARS / (1024 * 1024)}MB`))
      return
    }
    for (const line of lines) {
      const raw = line.trim()
      if (!raw) continue
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(raw)
      } catch {
        // an agent that prints a banner to stdout is not a protocol error — skip it
        continue
      }
      this.dispatch(msg)
    }
  }

  private dispatch(msg: Record<string, unknown>): void {
    const id = msg.id
    if (typeof msg.method === 'string') {
      if (id === undefined || id === null) this.onNotify(msg.method, msg.params)
      else this.onRequest(id as number | string, msg.method, msg.params)
      return
    }
    if (typeof id !== 'number') return
    const p = this.pending.get(id)
    if (!p) return
    this.pending.delete(id)
    if (msg.error) {
      const e = msg.error as { message?: unknown; code?: unknown }
      p.reject(
        new AgentError(typeof e?.message === 'string' ? e.message : `agent error ${String(e?.code)}`, e?.code)
      )
    } else {
      p.resolve(msg.result)
    }
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closed)
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params: unknown): void {
    this.write({ jsonrpc: '2.0', method, params })
  }

  respond(id: number | string, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result })
  }

  respondError(id: number | string, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  private write(msg: unknown): void {
    if (this.closed) return
    try {
      this.child.stdin!.write(JSON.stringify(msg) + '\n')
    } catch {
      /* the child is gone; the close handler settles everything in flight */
    }
  }

  /** Reject everything still waiting — the child died or the stream broke. */
  fail(err: Error): void {
    this.closed = err
    for (const [, p] of this.pending) p.reject(err)
    this.pending.clear()
  }
}

/** An error the agent answered a request with, its JSON-RPC code kept. */
class AgentError extends Error {
  constructor(
    message: string,
    readonly code: unknown
  ) {
    super(message)
  }
}

/** ACP's own code for "sign in first" — what an agent answers a session with before it has been. */
const AUTH_REQUIRED = -32000

function isAuthRequired(err: unknown): boolean {
  return err instanceof AgentError && err.code === AUTH_REQUIRED
}

/** The sign-in methods an agent offered at `initialize`, by id. */
function authMethodIds(init: Record<string, unknown> | undefined): string[] {
  const methods = Array.isArray(init?.authMethods) ? init.authMethods : []
  return methods.flatMap((m) => (m && typeof m === 'object' && typeof (m as { id?: unknown }).id === 'string' ? [(m as { id: string }).id] : []))
}

/** A permission question put to the user and not yet answered. */
type OpenPermission = {
  readonly rpcId: number | string
  readonly options: readonly AcpPermissionOption[]
}

export class AcpTurn {
  readonly child: ChildProcess
  /**
   * Settles once the agent's own process is gone — exited, or never started. The turn
   * can be over well before: an agent may keep running past EOF until `reap` stops it.
   */
  readonly exited: Promise<void>
  private readonly rpc: JsonRpc
  private readonly opts: TurnOptions
  private readonly seenToolCalls = new Set<string>()
  private readonly open = new Map<string, OpenPermission>()
  private sessionId: string | null = null
  /** `session/load` replays the whole conversation; none of it is new to the user */
  private replaying = false
  private finished = false
  private stderr = ''
  /** What the person calls this agent, for the errors that name it */
  private readonly agentLabel: string
  /** How this agent is signed in, when a built-in says (`AcpAgent.authMethod`, `signIn`) */
  private readonly auth: Pick<AcpAgent, 'authMethod' | 'signIn'>

  constructor(agent: AcpAgent, opts: TurnOptions) {
    this.opts = opts
    this.agentLabel = agent.label
    this.auth = { authMethod: agent.authMethod, signIn: agent.signIn }
    this.child = spawn(agent.command, [...(agent.args ?? [])], {
      cwd: opts.cwd,
      env: { ...opts.env, ...(agent.env ?? {}), ...(opts.pinned ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      // own process group, so cancelling reaches the tools the agent spawned
      detached: true
    })
    // 'exit' is the process; a spawn that failed emits only 'close'
    this.exited = new Promise((resolve) => {
      this.child.once('exit', () => resolve())
      this.child.once('close', () => resolve())
    })
    this.child.stderr!.setEncoding('utf8')
    this.child.stderr!.on('data', (c: string) => {
      this.stderr = (this.stderr + c).slice(-4000)
    })
    // A write to an agent that has just exited fails later, as an 'error' on the
    // stream — past write()'s try/catch — and with no listener that is an uncaught
    // exception: main's error dialog. The close handler settles the turn either way.
    this.child.stdin!.on('error', () => {})
    this.rpc = new JsonRpc(
      this.child,
      (method, params) => this.onNotify(method, params),
      (id, method, params) => this.onRequest(id, method, params)
    )
  }

  private emit(ev: ChatEvent): void {
    this.opts.emit(ev)
  }

  private onNotify(method: string, params: unknown): void {
    if (method !== 'session/update' || this.replaying || this.finished) return
    const update = (params as { update?: unknown } | null)?.update
    for (const ev of acpUpdateToEvents(this.opts.turnId, update, this.seenToolCalls)) this.emit(ev)
  }

  private onRequest(id: number | string, method: string, params: unknown): void {
    if (method === 'session/request_permission') {
      this.onPermission(id, params)
      return
    }
    // fs/* and terminal/* are capabilities we did not claim at initialize; answering
    // "method not found" is what tells a well-behaved agent to use its own tools
    this.rpc.respondError(id, -32601, `Cockpit does not implement ${method}`)
  }

  private onPermission(rpcId: number | string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>
    const call = (p.toolCall ?? {}) as Record<string, unknown>
    const options = permissionOptions(p.options)
    const kind = typeof call.kind === 'string' ? call.kind : undefined
    const auto = decidePermission(this.opts.permissionMode, options, kind)
    if (auto) {
      this.rpc.respond(rpcId, { outcome: { outcome: 'selected', optionId: auto } })
      return
    }
    if (!this.opts.asksPermissions) {
      // before the no-options case: an agent's own default may be to go ahead
      this.rpc.respond(rpcId, { outcome: unattendedOutcome(options) })
      return
    }
    if (options.length === 0) {
      // nothing we could answer with — let the agent apply its own default
      this.rpc.respondError(rpcId, -32602, 'no answerable options were offered')
      return
    }
    const requestId = String(rpcId)
    this.open.set(requestId, { rpcId, options })
    const title = typeof call.title === 'string' ? call.title : 'the agent wants permission'
    this.emit({
      turnId: this.opts.turnId,
      type: 'permission',
      requestId,
      toolName: kind === 'execute' ? 'shell' : (kind ?? 'tool'),
      // a command reaches the card whole, not as a 400-character line of JSON
      detail: permissionDetail(kind, call.rawInput, title),
      preview: truncate(title, 200),
      options
    })
  }

  /** Answer a question the user was asked. Unknown ids are stale clicks — ignored. */
  respondPermission(requestId: string, optionId: string): void {
    const open = this.open.get(requestId)
    if (!open) return
    if (!open.options.some((o) => o.optionId === optionId)) return
    this.open.delete(requestId)
    this.rpc.respond(open.rpcId, { outcome: { outcome: 'selected', optionId } })
  }

  /**
   * Run the whole turn. Every outcome — including failure — reaches the caller as chat
   * events, so this never rejects and the caller has nothing to catch.
   */
  async run(prompt: string, resumeNativeId?: string): Promise<void> {
    const { turnId } = this.opts
    const exited = new Promise<never>((_, reject) => {
      this.child.once('error', (err) => {
        const e = err as NodeJS.ErrnoException
        reject(
          new Error(
            e.code === 'ENOENT'
              ? `'${this.child.spawnfile}' not found on PATH — is the agent installed?`
              : String(err)
          )
        )
      })
      this.child.once('close', (code) => {
        const err = new Error(
          `the agent exited with code ${code}${this.stderr.trim() ? `:\n${this.stderr.trim()}` : ''}`
        )
        this.rpc.fail(err)
        reject(err)
      })
    })
    // nothing is listening once the turn is over; without this the child's ordinary
    // exit would surface as an unhandled rejection
    exited.catch(() => {})
    // every await races the child's death, so a crash mid-handshake surfaces as the
    // exit and its stderr rather than as a promise that never settles
    const step = <T>(p: Promise<T>): Promise<T> => Promise.race([p, exited]) as Promise<T>

    const { handshake = HANDSHAKE_MS, openSession = OPEN_SESSION_MS } = this.opts.deadlines ?? {}
    const label = this.agentLabel
    try {
      const init = (await step(
        within(this.rpc.request('initialize', initializeParams()), handshake, () => handshakeLate(label, handshake))
      )) as Record<string, unknown> | undefined
      const caps = (init?.agentCapabilities ?? {}) as Record<string, unknown>
      // each attempt at the session has the deadline — signing in between has its own
      const session = (): Promise<string> =>
        within(
          this.openSession(Boolean(caps.loadSession), resumeNativeId),
          openSession,
          () => new Error(`${label} did not open the session within ${inSeconds(openSession)}.`)
        )
      this.sessionId = await step(this.signedIn(session, authMethodIds(init)))
      this.emit({ turnId, type: 'session', nativeSessionId: this.sessionId })
      const result = await step(
        this.rpc.request('session/prompt', {
          sessionId: this.sessionId,
          prompt: [{ type: 'text', text: prompt }]
        })
      )
      for (const ev of promptResultEvents(turnId, result)) this.emit(ev)
    } catch (err) {
      this.emit({ turnId, type: 'error', message: messageFor(err) })
      this.emit({ turnId, type: 'done' })
    } finally {
      this.finished = true
      try {
        this.child.stdin!.end()
      } catch {
        /* already closed */
      }
      this.reap()
    }
  }

  /**
   * The turn is over and the agent has been sent EOF, which a well-behaved one exits
   * on. One that doesn't — it failed mid-turn and is still working, or it just keeps
   * running (Cursor's waits past EOF) — is stopped, its group with it, rather than left
   * editing a worktree where nothing shows it and nothing will ever cancel it. Until it
   * has gone, ChatManager keeps the turn (`exited`), so quitting stops it too.
   */
  private reap(): void {
    const pid = this.child.pid
    if (!pid || this.child.exitCode !== null || this.child.signalCode !== null) return
    const timer = setTimeout(() => endGroup(this.child), EXIT_GRACE_MS)
    timer.unref()
    this.child.once('close', () => clearTimeout(timer))
  }

  /**
   * Open the session, signing in first when the agent says it must. An agent answers a
   * session it won't open signed out with ACP's auth-required error; a built-in that names
   * the method reusing its CLI's own sign-in (Cursor's `cursor_login` — its agent wants
   * this even after `agent login`) is asked to use it, once, and the session tried again.
   * Anything else is the person's to do, and the error says how.
   */
  private async signedIn(open: () => Promise<string>, offered: readonly string[]): Promise<string> {
    try {
      return await open()
    } catch (err) {
      if (!isAuthRequired(err)) throw err
      const { authMethod } = this.auth
      if (authMethod && offered.includes(authMethod)) {
        try {
          // an agent may wait on an interactive login here — never longer than this
          await within(
            this.rpc.request('authenticate', { methodId: authMethod }),
            AUTHENTICATE_MS,
            () => new AgentError('signing in took too long', AUTH_REQUIRED)
          )
          return await open()
        } catch (again) {
          if (!isAuthRequired(again) && !(again instanceof AgentError)) throw again
        }
      }
      throw new Error(signInMessage(this.agentLabel, this.auth.signIn, err))
    }
  }

  /** Resume the conversation when we can, start a fresh one when we can't. */
  private async openSession(canLoad: boolean, resumeNativeId?: string): Promise<string> {
    const { mustResume } = this.opts
    if (resumeNativeId && !canLoad && mustResume) {
      throw new Error(`${this.agentLabel} can't reopen a conversation over ACP, so this one can't be continued from Cockpit.`)
    }
    if (resumeNativeId && canLoad) {
      this.replaying = true
      try {
        await this.rpc.request('session/load', {
          sessionId: resumeNativeId,
          cwd: this.opts.cwd,
          mcpServers: []
        })
        return resumeNativeId
      } catch (err) {
        // signed out is not forgotten: that is the person's to fix, and says so (signedIn)
        if (isAuthRequired(err)) throw err
        // the agent forgot this session (pruned, or written under another account) —
        // a fresh one is better than refusing the turn, unless the turn says otherwise
        if (mustResume) {
          throw new Error(`${this.agentLabel} couldn't reopen this conversation over ACP: ${messageFor(err)}`)
        }
      } finally {
        this.replaying = false
      }
    }
    const res = (await this.rpc.request('session/new', {
      cwd: this.opts.cwd,
      mcpServers: []
    })) as Record<string, unknown> | undefined
    const id = res?.sessionId
    if (typeof id !== 'string' || !id) throw new Error('the agent did not return a session id')
    await this.applyMode(id, res)
    return id
  }

  /** Ask for the session mode that matches the turn's permission mode, if it has one. */
  private async applyMode(sessionId: string, session: Record<string, unknown> | undefined): Promise<void> {
    const modes = (session?.modes ?? {}) as { availableModes?: { id: string }[] }
    const wanted = modeIdFor(this.opts.permissionMode, modes.availableModes ?? [])
    if (!wanted) return
    try {
      await this.rpc.request('session/set_mode', { sessionId, modeId: wanted })
    } catch {
      // an agent may list a mode and refuse to switch to it; the turn still runs in the
      // default, and permission requests still gate everything either way
    }
  }

  /**
   * Stop the turn. Open questions are answered first — an agent left holding one would
   * sit waiting through its own cancellation — and answered `cancelled`, which the spec
   * requires of a client that cancels. Never with an option: a refusal the agent offers
   * may be a standing one, kept in its own config long after this turn. A turn already
   * over has told the agent all it will: only its process is left, which the caller ends.
   */
  cancel(): void {
    if (this.finished) return
    const cancelled: PermissionOutcome = { outcome: 'cancelled' }
    for (const [, open] of this.open) this.rpc.respond(open.rpcId, { outcome: cancelled })
    this.open.clear()
    if (this.sessionId) this.rpc.notify('session/cancel', { sessionId: this.sessionId })
  }
}

/** Signal a child's whole process group (each is spawned `detached`), or the child alone without a pid. */
function signalGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  try {
    if (child.pid) process.kill(-child.pid, sig)
    else child.kill(sig)
  } catch {
    /* the group has gone */
  }
}

/**
 * SIGTERM to the group now, and SIGKILL to it once `KILL_AFTER_MS` pass, whether or not
 * the agent itself has gone by then: it usually exits on SIGTERM at once, while a tool it
 * started that ignores the signal is still in the group (the lesson ChatManager.cancel
 * records). For a group that is already empty the SIGKILL is a no-op.
 */
function endGroup(child: ChildProcess, onKilled?: () => void): void {
  signalGroup(child, 'SIGTERM')
  setTimeout(() => {
    signalGroup(child, 'SIGKILL')
    onKilled?.()
  }, KILL_AFTER_MS).unref()
}

/**
 * Probes whose group has not had its SIGKILL yet: each is detached, so one Cockpit quits
 * under would outlive it — five built-ins at every launch, and every re-probe after.
 */
const probeGroups = new Set<ChildProcess>()

/**
 * End a probed agent and everything it started: EOF first (an agent may exit on it), then
 * the group's SIGTERM and SIGKILL (`endGroup`) — Cursor's agent waits past EOF, Gemini's
 * launcher re-runs itself as a child, and a probe runs at every launch, so anything it
 * leaves would pile up.
 */
function endProbe(child: ChildProcess): void {
  try {
    child.stdin?.end()
  } catch {
    /* already closed */
  }
  endGroup(child, () => probeGroups.delete(child))
}

/**
 * Quitting: kill every probe's group that has not been killed yet, at once. A probe holds
 * no work — only a handshake — and the timer that would have ended it will not run.
 */
export function stopAcpProbes(): void {
  for (const child of probeGroups) signalGroup(child, 'SIGKILL')
  probeGroups.clear()
}

/** `p`, or — once `ms` pass without it settling — a rejection with `late()`'s error. */
function within<T>(p: Promise<T>, ms: number, late: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(late()), ms)
  })
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer))
}

function inSeconds(ms: number): string {
  const s = Math.round(ms / 1000)
  return `${s} second${s === 1 ? '' : 's'}`
}

/** What a turn or a probe says of an agent that never answered `initialize`. */
function handshakeLate(who: string, ms: number): Error {
  return new Error(
    `${who} did not answer the ACP handshake within ${inSeconds(ms)} — it may be stuck, or waiting for input it can't get here.`
  )
}

/** What a turn that could not sign in says: the agent's own reason, and what fixes it. */
function signInMessage(label: string, signIn: string | undefined, err: unknown): string {
  const why = messageFor(err)
  const fix = signIn ? ` — sign it in by running \`${signIn}\` in a terminal, then send again` : ''
  return `${label} needs signing in: ${why}${fix}.`
}

function messageFor(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return truncate(raw, 500)
}

/**
 * Run just the handshake against a definition, so the settings form can say "this is
 * Copilot 1.0.86 and it can resume sessions" instead of accepting a command on faith.
 * Never throws: a failure is a probe result with the reason in it.
 *
 * The agent starts in `dir`, created when missing: an empty folder of Cockpit's own,
 * never the home folder. Gemini CLI and Cursor's agent read the whole tree they start
 * in, handshake or not, and from home that walk reaches the Music and Photos libraries
 * — macOS then asks the person to let Cockpit into both, for a check that reads nothing.
 */
export function probeAcpAgent(agent: AcpAgent, dir: string): Promise<AcpAgentProbe> {
  return new Promise((resolve) => {
    try {
      mkdirSync(dir, { recursive: true })
    } catch (err) {
      resolve({ ok: false, error: `could not make the folder the check runs in: ${messageFor(err)}` })
      return
    }
    let child: ChildProcess
    try {
      child = spawn(agent.command, [...(agent.args ?? [])], {
        cwd: dir,
        env: { ...cliEnv(), ...(agent.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        // its own process group, so the probe can end all of it: Gemini's launcher re-runs
        // itself as a child, which a signal to the launcher alone left running for good
        detached: true
      })
    } catch (err) {
      resolve({ ok: false, error: messageFor(err) })
      return
    }
    probeGroups.add(child)
    let stderr = ''
    let settled = false
    const done = (probe: AcpAgentProbe): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      endProbe(child)
      resolve(probe)
    }
    const timer = setTimeout(
      () => done({ ok: false, error: handshakeLate('the agent', HANDSHAKE_MS).message }),
      HANDSHAKE_MS
    )
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (c: string) => {
      stderr = (stderr + c).slice(-2000)
    })
    // a handshake written to an agent that exits at once fails as a stream 'error'
    // (EPIPE) — unheard, that is main's error dialog; 'close' reports the exit
    child.stdin!.on('error', () => {})
    child.on('error', (err) => {
      const e = err as NodeJS.ErrnoException
      done({
        ok: false,
        error:
          e.code === 'ENOENT'
            ? `'${agent.command}' was not found — check the command, or give its full path.`
            : messageFor(err)
      })
    })
    child.on('close', (code) =>
      done({
        ok: false,
        error: `the agent exited with code ${code} instead of answering${
          stderr.trim() ? `:\n${truncate(stderr, 300)}` : ''
        }`
      })
    )
    const rpc = new JsonRpc(
      child,
      () => {},
      (id) => rpc.respondError(id, -32601, 'not implemented during probe')
    )
    rpc.request('initialize', initializeParams()).then(
      (result) => {
        const r = (result ?? {}) as Record<string, unknown>
        const caps = (r.agentCapabilities ?? {}) as Record<string, unknown>
        const sessionCaps = (caps.sessionCapabilities ?? {}) as Record<string, unknown>
        const info = (r.agentInfo ?? {}) as Record<string, unknown>
        const auth = Array.isArray(r.authMethods) ? r.authMethods : []
        done({
          ok: true,
          ...(typeof info.name === 'string' ? { name: truncate(info.name, 48) } : {}),
          ...(typeof info.version === 'string' ? { version: truncate(info.version, 32) } : {}),
          ...(typeof r.protocolVersion === 'number' ? { protocolVersion: r.protocolVersion } : {}),
          loadSession: Boolean(caps.loadSession),
          listSessions: Boolean(sessionCaps.list),
          authMethods: auth
            .map((m) => (m as { name?: unknown })?.name)
            .filter((n): n is string => typeof n === 'string')
            .slice(0, 8)
        })
      },
      (err) => done({ ok: false, error: messageFor(err) })
    )
  })
}
