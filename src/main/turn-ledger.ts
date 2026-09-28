import { resolve } from 'node:path'
import type { ChatEvent, ChatRequest, SessionProvider } from '../shared/types'
import type { SessionIndexer } from './indexer'
import { isDrivable } from '../shared/providers'
import type { ControlEntry } from './session-control-core'
import {
  bindSessionControl,
  bindSessionEndpoint,
  bindSessionLineage,
  sessionLineageFor
} from './config'

/**
 * Handoffs into copilot: `copilot -p` never announces its session id on stdout, so
 * the lineage is resolved against the index instead — the next new copilot session
 * in the same cwd claims the pending entry. Best-effort by design (entries expire);
 * the renderer's in-memory chip covers the live session either way.
 */
type PendingCopilotHandoff = { cwd: string; sourceId: string; spawnedAt: number }
const COPILOT_LINEAGE_TTL_MS = 10 * 60_000
const COPILOT_LINEAGE_MAX = 20

/**
 * What Cockpit remembers about a turn it started until the turn names its session: the
 * BYOK provider it runs on (so later resumes stay on that backend), the conversation it
 * continues (handoff lineage), and that Cockpit holds it — the session a new turn
 * announces was started here, and the id claude forks for a resumed turn stays held the
 * way the one it resumed was. Each is written to config the moment the stream's `session`
 * event names the id, and forgotten when the turn is done.
 */
export class TurnLedger {
  private readonly byokTurns = new Map<string, { provider: SessionProvider; endpointId: string }>()
  private readonly handoffTurns = new Map<string, { provider: SessionProvider; sourceId: string }>()
  private readonly heldTurns = new Map<string, { provider: SessionProvider; entry: ControlEntry }>()
  private readonly pendingCopilot: PendingCopilotHandoff[] = []
  /** Turns of an agent Cockpit only reads, driven over its ACP server */
  private readonly readOnlyTurns = new Set<string>()

  constructor(
    private readonly indexer: SessionIndexer,
    private readonly opts: {
      /** A read-only agent's turn ended — its first may have written a home launch never saw */
      readonly onReadOnlyTurnDone?: () => void
    } = {}
  ) {}

  /**
   * A turn chat:send just started. `resumed` is the session it resumes, if any, and
   * `recorded` that session's control entry — what the new id inherits.
   */
  started(
    turnId: string,
    req: ChatRequest,
    { resumed, recorded }: { readonly resumed: string | null; readonly recorded?: ControlEntry }
  ): void {
    if (!isDrivable(req.provider)) this.readOnlyTurns.add(turnId)
    const holds: ControlEntry | undefined = resumed ? recorded : { how: 'started', at: Date.now() }
    if (holds) this.heldTurns.set(turnId, { provider: req.provider, entry: holds })
    if (req.options?.modelEndpoint) {
      this.byokTurns.set(turnId, { provider: req.provider, endpointId: req.options.modelEndpoint })
    }
    if (req.handoffFrom) {
      if (req.provider === 'copilot') {
        this.pendingCopilot.push({ cwd: req.cwd, sourceId: req.handoffFrom, spawnedAt: Date.now() })
        if (this.pendingCopilot.length > COPILOT_LINEAGE_MAX) this.pendingCopilot.shift()
      } else {
        this.handoffTurns.set(turnId, { provider: req.provider, sourceId: req.handoffFrom })
      }
    } else if (req.resumeNativeId && req.provider !== 'copilot') {
      // claude mints a fresh native id per resumed turn — the new id must keep the
      // lineage of the id it resumed (the sessionEndpointFor pattern in chat:send)
      const lineage = sessionLineageFor(`${req.provider}:${req.resumeNativeId}`)
      if (lineage) this.handoffTurns.set(turnId, { provider: req.provider, sourceId: lineage })
    }
  }

  /** Follow one plain-chat stream event: persist what a `session` event names, forget a finished turn. */
  chatEvent(ev: ChatEvent): void {
    const byok = this.byokTurns.get(ev.turnId)
    if (byok && ev.type === 'session') {
      try {
        bindSessionEndpoint(`${byok.provider}:${ev.nativeSessionId}`, byok.endpointId)
      } catch (err) {
        // a config-write failure must not blow up inside the stream handler
        console.error('[chat] failed to persist session endpoint binding:', err)
      }
    }
    const held = this.heldTurns.get(ev.turnId)
    if (held && ev.type === 'session') {
      try {
        this.indexer.setControl(bindSessionControl(`${held.provider}:${ev.nativeSessionId}`, held.entry))
      } catch (err) {
        console.error('[chat] failed to persist session control:', err)
      }
    }
    const handoff = this.handoffTurns.get(ev.turnId)
    if (handoff && ev.type === 'session') {
      try {
        this.indexer.setLineage(
          bindSessionLineage(`${handoff.provider}:${ev.nativeSessionId}`, handoff.sourceId)
        )
      } catch (err) {
        console.error('[chat] failed to persist handoff lineage:', err)
      }
    }
    if (ev.type === 'done') {
      this.byokTurns.delete(ev.turnId)
      this.handoffTurns.delete(ev.turnId)
      this.heldTurns.delete(ev.turnId)
      if (this.readOnlyTurns.delete(ev.turnId)) {
        try {
          this.opts.onReadOnlyTurnDone?.()
        } catch (err) {
          // it saves config too: a throw here would keep the done from the desk and the window
          console.error('[chat] failed to adopt an agent home after a turn:', err)
        }
      }
    }
  }

  /** On every index update: a pending Copilot handoff claims the new session it started. */
  resolveCopilotHandoffs(): void {
    const pending = this.pendingCopilot
    // emitUpdate is debounced, so the setLineage below cannot re-enter synchronously;
    // the follow-up update finds this list empty and stops the cycle
    if (pending.length === 0) return
    const now = Date.now()
    for (let i = pending.length - 1; i >= 0; i--) {
      if (now - pending[i].spawnedAt > COPILOT_LINEAGE_TTL_MS) pending.splice(i, 1)
    }
    const candidates = this.indexer.allSessions().filter((s) => s.provider === 'copilot' && s.cwd)
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i]
      const match = candidates
        .filter(
          (s) =>
            resolve(s.cwd as string) === resolve(p.cwd) &&
            // fs birthtime can precede the spawn timestamp slightly
            s.startedAt >= p.spawnedAt - 60_000 &&
            // never re-claim a session that already has lineage
            sessionLineageFor(s.id) === undefined
        )
        .sort((a, b) => a.startedAt - b.startedAt)[0]
      if (match) {
        try {
          this.indexer.setLineage(bindSessionLineage(match.id, p.sourceId))
          // the handoff started this session, so Cockpit holds it — the id is known only now
          this.indexer.setControl(bindSessionControl(match.id, { how: 'started', at: p.spawnedAt }))
        } catch (err) {
          console.error('[handoff] failed to persist copilot lineage:', err)
        }
        pending.splice(i, 1)
        i--
      }
    }
  }
}
