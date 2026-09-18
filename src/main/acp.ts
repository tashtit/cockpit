import { spawn, type ChildProcess } from 'node:child_process'
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
  denyOption,
  initializeParams,
  modeIdFor,
  permissionOptions,
  promptResultEvents
} from './acp-core'
import { cliEnv } from './env'
import { truncate } from './parsers/util'

/**
 * One ACP conversation, for the length of one turn.
 *
 * ACP is built for a connection that outlives many turns, and Cockpit will want that
 * eventually. It does not take it yet on purpose: `ChatManager` is built around one child
 * process per turn — that is what `busySessions()` counts, what `cancel()` kills, and what
 * the attention desk hears start and stop. Spawning per turn keeps all of that true and
 * costs a process launch; `session/load` makes the conversation continuous regardless.
 * A pooled connection is the follow-up, not a prerequisite.
 */

type TurnOptions = {
  readonly turnId: string
  readonly cwd: string
  readonly env: NodeJS.ProcessEnv
  readonly permissionMode: PermissionMode
  readonly emit: (ev: ChatEvent) => void
}

/** Stops one runaway line from growing the heap without bound. */
const MAX_LINE_BYTES = 8 * 1024 * 1024

type Pending = {
  readonly resolve: (value: unknown) => void
  readonly reject: (err: Error) => void
}

/** JSON-RPC over the child's stdio: newline-delimited objects, one per message. */
class JsonRpc {
  private buf = ''
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
    this.buf += chunk
    if (this.buf.length > MAX_LINE_BYTES) {
      this.fail(new Error('the agent sent a single message larger than 8MB'))
      return
    }
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const raw = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
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
        new Error(typeof e?.message === 'string' ? e.message : `agent error ${String(e?.code)}`)
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

/** A permission question put to the user and not yet answered. */
type OpenPermission = {
  readonly rpcId: number | string
  readonly options: readonly AcpPermissionOption[]
}

export class AcpTurn {
  readonly child: ChildProcess
  private readonly rpc: JsonRpc
  private readonly opts: TurnOptions
  private readonly seenToolCalls = new Set<string>()
  private readonly open = new Map<string, OpenPermission>()
  private sessionId: string | null = null
  /** `session/load` replays the whole conversation; none of it is new to the user */
  private replaying = false
  private finished = false
  private stderr = ''

  constructor(agent: AcpAgent, opts: TurnOptions) {
    this.opts = opts
    this.child = spawn(agent.command, [...(agent.args ?? [])], {
      cwd: opts.cwd,
      env: { ...opts.env, ...(agent.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      // own process group, so cancelling reaches the tools the agent spawned
      detached: true
    })
    this.child.stderr!.setEncoding('utf8')
    this.child.stderr!.on('data', (c: string) => {
      this.stderr = (this.stderr + c).slice(-4000)
    })
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
      detail: truncate(JSON.stringify(call.rawInput ?? title), 400),
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

    try {
      const init = (await step(this.rpc.request('initialize', initializeParams()))) as
        | Record<string, unknown>
        | undefined
      const caps = (init?.agentCapabilities ?? {}) as Record<string, unknown>
      this.sessionId = await step(this.openSession(Boolean(caps.loadSession), resumeNativeId))
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
    }
  }

  /** Resume the conversation when we can, start a fresh one when we can't. */
  private async openSession(canLoad: boolean, resumeNativeId?: string): Promise<string> {
    if (resumeNativeId && canLoad) {
      this.replaying = true
      try {
        await this.rpc.request('session/load', {
          sessionId: resumeNativeId,
          cwd: this.opts.cwd,
          mcpServers: []
        })
        return resumeNativeId
      } catch {
        // the agent forgot this session (pruned, or written under another account) —
        // a fresh one is better than refusing the turn
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
   * Stop the turn. Open questions are refused first: an agent left holding an unanswered
   * request would otherwise sit waiting through its own cancellation.
   */
  cancel(): void {
    for (const [, open] of this.open) {
      const deny = denyOption(open.options)
      this.rpc.respond(
        open.rpcId,
        deny ? { outcome: { outcome: 'selected', optionId: deny } } : { outcome: { outcome: 'cancelled' } }
      )
    }
    this.open.clear()
    if (this.sessionId) this.rpc.notify('session/cancel', { sessionId: this.sessionId })
  }
}

function messageFor(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return truncate(raw, 500)
}

/**
 * Run just the handshake against a definition, so the settings form can say "this is
 * Copilot 1.0.86 and it can resume sessions" instead of accepting a command on faith.
 * Never throws: a failure is a probe result with the reason in it.
 */
export function probeAcpAgent(agent: AcpAgent, cwd: string): Promise<AcpAgentProbe> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(agent.command, [...(agent.args ?? [])], {
        cwd,
        env: { ...cliEnv(), ...(agent.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false
      })
    } catch (err) {
      resolve({ ok: false, error: messageFor(err) })
      return
    }
    let stderr = ''
    let settled = false
    const done = (probe: AcpAgentProbe): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
      resolve(probe)
    }
    const timer = setTimeout(
      () => done({ ok: false, error: 'the agent did not answer the ACP handshake within 15 seconds' }),
      15_000
    )
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (c: string) => {
      stderr = (stderr + c).slice(-2000)
    })
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
