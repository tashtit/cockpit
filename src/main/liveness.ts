import { opendirSync, type Dir } from 'node:fs'
import { dirname } from 'node:path'
import type { AttentionAsk, BusySession, Provider, SessionMeta } from '../shared/types'
import { TRANSCRIPT_TAIL_BYTES, parseJsonlText, readTail } from './parsers/util'
import {
  IDLE,
  copilotLockPids,
  judgeTail,
  type ObservedSession,
  type ObservedTurn,
  type TurnVerdict
} from './liveness-core'

export type { ObservedSession, ObservedTurn } from './liveness-core'

/**
 * Live status for the sessions Cockpit did not spawn — the ones running in a terminal
 * or in the provider's own app, which is most of them. Nothing announces their turns,
 * but every provider streams its log as it works, so the indexer's watcher is the
 * signal: on each write the tracker reads a bounded tail (never the file), asks
 * liveness-core what it says, and keeps the session in the busy set while the log
 * keeps growing. Silence ends it — a killed CLI leaves a mid-turn tail forever — so
 * an entry without a write for LIVE_WINDOW_MS expires on a timer; while the newest
 * record is a tool call waiting for its result (a test suite, a build — minutes with
 * nothing written) the entry gets LIVE_TOOL_WINDOW_MS instead. Copilot is the one
 * provider that says so itself: it holds an `inuse.<pid>.lock` beside the log for as
 * long as its CLI runs, so a Copilot entry past either window is kept while that pid
 * is alive and expires once it is not. Best-effort by design: an unreadable or
 * unrecognised tail — or lock — is idle, never an error.
 *
 * The transitions are news too (`onTurn`, for the attention desk): a turn seen
 * running whose log then writes its ending record has *ended* — an expiry is not
 * that, a killed CLI or a long tool call must never chime — and a running turn whose
 * newest record is a question or a permission prompt *asks*, until the log moves on.
 */

/** No write for this long and an observed turn is over, whatever its tail says. */
export const LIVE_WINDOW_MS = 90_000
/**
 * …unless that tail is a tool call still running: those write nothing until they
 * finish, and a typical one takes 100–600s. The arrival gate stays LIVE_WINDOW_MS —
 * a cold scan reads no old tails, and a turn is only ever *kept* live this long.
 */
export const LIVE_TOOL_WINDOW_MS = 10 * 60_000
/**
 * Tail windows tried in turn. The first holds the newest few records and, for a
 * typical turn, the prompt that opened it — almost every read stops there. The rest
 * exist for what can bury the decisive record: a run of attachments, one tool result
 * (a single Claude one reaches 1MB, a Codex tool output several), a Copilot screenshot
 * asset. The last is the cap the transcript view already lives with; past it the tail
 * is declared silent rather than the file read.
 */
export const LIVE_TAIL_STEPS: readonly number[] = [64 * 1024, 1024 * 1024, TRANSCRIPT_TAIL_BYTES]
const SWEEP_MS = 10_000

/**
 * What the tail of one session log says right now: a verdict, or null when nothing in
 * the last LIVE_TAIL_STEPS bytes speaks for the turn. Bounded reads; a missing or
 * empty file is idle, never an error.
 */
export function readTurnState(file: string, provider: Provider): TurnVerdict | null {
  // copilot's legacy JSON snapshots never stream a turn
  if (provider === 'copilot' && !file.endsWith('events.jsonl')) return IDLE
  for (const bytes of LIVE_TAIL_STEPS) {
    const tail = readTail(file, bytes)
    if (!tail.text) return IDLE
    // a truncated tail opens mid-record — drop the partial line
    const text = tail.truncated ? tail.text.slice(tail.text.indexOf('\n') + 1) : tail.text
    const verdict = judgeTail(provider, parseJsonlText(text, false))
    if (verdict) return verdict
    if (!tail.truncated) return null // that was the whole file
  }
  return null
}

/**
 * Directory entries a lock check will look at. A Copilot session directory holds a
 * handful of files (the log, a workspace, the locks); the cap is what keeps the read
 * bounded whatever else has been dropped in there.
 */
export const LOCK_SCAN_ENTRIES = 64

/** Does this pid still exist? EPERM says it does — it just isn't ours to signal. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

/**
 * Is a Copilot CLI still holding the session this log belongs to? Copilot writes
 * `inuse.<pid>.lock` next to `events.jsonl` while a process has the session open, so
 * a mid-turn tail that has gone quiet for minutes can be told from a killed CLI —
 * which is the one thing the records never say. Bounded and best-effort: no lock, an
 * unreadable directory or a pid that has gone leaves the windows to decide. It only
 * ever *keeps* an entry: the locks outlive the turns (most of the ones on disk are
 * stale), so one alone never means a turn is running.
 */
function copilotHolderAlive(file: string): boolean {
  let dir: Dir
  try {
    dir = opendirSync(dirname(file))
  } catch {
    return false
  }
  try {
    const names: string[] = []
    for (let i = 0; i < LOCK_SCAN_ENTRIES; i++) {
      const entry = dir.readSync()
      if (!entry) break
      names.push(entry.name)
    }
    return copilotLockPids(names).some(pidAlive)
  } catch {
    return false
  } finally {
    try {
      dir.closeSync()
    } catch {
      // already closed, or the directory went away mid-read
    }
  }
}

type LiveEntry = {
  readonly id: string
  readonly file: string
  /** Whose log this is — copilot's expiry also consults its lock */
  readonly provider: Provider
  /** Tracker state, mutated in place: the turn's start (kept once known) and its newest write */
  startedAt: number
  lastWriteAt: number
  /** What the turn is waiting on the person for, while it is */
  asks: AttentionAsk | null
  /** How long silence is tolerated before this entry expires — longer inside a tool call */
  windowMs: number
}

export type LivenessOptions = {
  readonly windowMs?: number
  /** The window while the newest record is a tool call without its result */
  readonly toolWindowMs?: number
  readonly sweepMs?: number
  /** The clock — tests pin it */
  readonly now?: () => number
  /** A turn started, stopped to ask, or ended — from the log's own records only */
  readonly onTurn?: (ev: ObservedTurn) => void
}

const sameAsk = (a: AttentionAsk | null, b: AttentionAsk | null): boolean =>
  a === b || (a !== null && b !== null && a.kind === b.kind && a.detail === b.detail)

export class LivenessTracker {
  private entries = new Map<string, LiveEntry>()
  private sweepTimer: NodeJS.Timeout | null = null
  private readonly onChange: (sessions: BusySession[]) => void
  private readonly onTurn: (ev: ObservedTurn) => void
  private readonly windowMs: number
  private readonly toolWindowMs: number
  private readonly sweepMs: number
  private readonly now: () => number

  constructor(onChange: (sessions: BusySession[]) => void, opts: LivenessOptions = {}) {
    this.onChange = onChange
    this.onTurn = opts.onTurn ?? (() => {})
    this.windowMs = opts.windowMs ?? LIVE_WINDOW_MS
    this.toolWindowMs = Math.max(this.windowMs, opts.toolWindowMs ?? LIVE_TOOL_WINDOW_MS)
    this.sweepMs = opts.sweepMs ?? SWEEP_MS
    this.now = opts.now ?? Date.now
  }

  /**
   * The indexer re-parsed a session's log because it changed: judge its tail. The
   * freshness gate comes first so a cold scan over thousands of old logs reads no
   * tails at all — only a file written inside the window can be live. "Written" is
   * the file's mtime capped by the log's own last timestamp (`meta.updatedAt`, which
   * the parsers derive and which falls back to the mtime for a log too big to read
   * through): a file restored from a backup or synced in from another machine has a
   * fresh mtime and old content, and must not surface as a phantom turn.
   */
  observe(file: string, meta: SessionMeta, mtimeMs: number): void {
    const written = Math.min(mtimeMs, meta.updatedAt)
    if (this.now() - written > this.windowMs) {
      this.drop(meta.id)
      return
    }
    const verdict = readTurnState(file, meta.provider)
    const prev = this.entries.get(meta.id)
    if (verdict === null) {
      // the tail is silent (a run of huge records): a turn that was running still is —
      // its end always writes a small decisive record — and one that wasn't is not invented
      if (prev) prev.lastWriteAt = Math.max(prev.lastWriteAt, written)
      return
    }
    const session: ObservedSession = { id: meta.id, provider: meta.provider, cwd: meta.cwd }
    if (!verdict.live) {
      // the ending record of a turn seen running is news; one never seen running is
      // not (a quick exchange the person was there for, or a turn ended before launch)
      if (prev) {
        this.onTurn({
          ...session,
          type: 'ended',
          startedAt: prev.startedAt,
          endedAt: written,
          closing: verdict.closing ?? null,
          ...(verdict.failed ? { failed: true as const } : {})
        })
      } else {
        // nothing running here — so nothing is waiting either (a question answered while
        // its entry had expired, an Esc on it)
        this.onTurn({ ...session, type: 'settled' })
      }
      this.drop(meta.id)
      return
    }
    // the opening record is in the tail on a turn's first write, so the exact start is
    // learnt then and kept; when it has scrolled out, the last write is the lower bound
    const startedAt = verdict.startedAt ?? prev?.startedAt ?? written
    const asks = verdict.asks ?? null
    const windowMs = verdict.inTool ? this.toolWindowMs : this.windowMs
    if (prev) {
      prev.lastWriteAt = Math.max(prev.lastWriteAt, written)
      prev.windowMs = windowMs
      const newTurn = prev.startedAt !== startedAt
      const askChanged = !sameAsk(prev.asks, asks)
      prev.asks = asks
      if (askChanged || newTurn) this.turnEvent(session, startedAt, asks)
      if (!newTurn) return
      prev.startedAt = startedAt
    } else {
      this.entries.set(meta.id, {
        id: meta.id,
        file,
        provider: meta.provider,
        startedAt,
        lastWriteAt: written,
        asks,
        windowMs
      })
      this.ensureSweep()
      this.turnEvent(session, startedAt, asks)
    }
    this.emit()
  }

  /** A turn is running — or, when its newest record is a request, waiting on the person. */
  private turnEvent(session: ObservedSession, startedAt: number, asks: AttentionAsk | null): void {
    if (asks) this.onTurn({ ...session, type: 'asks', asks, startedAt })
    else this.onTurn({ ...session, type: 'running' })
  }

  /**
   * A write to a file that belongs to a session but is not its log — a Claude parent
   * log goes silent while its subagent works, and the subagent's transcript is what
   * grows. Extends a running entry only; it never creates one.
   */
  heartbeat(id: string): void {
    const e = this.entries.get(id)
    if (e) e.lastWriteAt = Math.max(e.lastWriteAt, this.now())
  }

  /** Sessions whose logs show a turn in progress, as the busy set wants them. */
  sessions(): BusySession[] {
    return [...this.entries.values()].map((e) => ({
      id: e.id,
      startedAt: e.startedAt,
      source: 'observed' as const
    }))
  }

  /** Forget everything: no more writes will arrive once the watchers are down. */
  stop(): void {
    this.stopSweep()
    if (this.entries.size === 0) return
    this.entries.clear()
    this.emit()
  }

  private drop(id: string): void {
    if (!this.entries.delete(id)) return
    if (this.entries.size === 0) this.stopSweep()
    this.emit()
  }

  private sweep(): void {
    const now = this.now()
    let changed = false
    for (const [id, e] of this.entries) {
      if (now - e.lastWriteAt <= e.windowMs) continue
      if (e.provider === 'copilot' && copilotHolderAlive(e.file)) continue
      this.entries.delete(id)
      changed = true
    }
    if (this.entries.size === 0) this.stopSweep()
    if (changed) this.emit()
  }

  private ensureSweep(): void {
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(() => this.sweep(), this.sweepMs)
    // an expiry timer must never be what keeps the process alive
    this.sweepTimer.unref()
  }

  private stopSweep(): void {
    if (!this.sweepTimer) return
    clearInterval(this.sweepTimer)
    this.sweepTimer = null
  }

  private emit(): void {
    this.onChange(this.sessions())
  }
}
