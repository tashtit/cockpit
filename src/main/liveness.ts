import { existsSync, opendirSync, type Dir } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import type { AttentionAsk, BusySession, Provider, SessionMeta } from '../shared/types'
import { TRANSCRIPT_TAIL_BYTES, judgeJsonlTail, readJson } from './parsers/util'
import { execText } from './env'
import { isDrivable } from '../shared/providers'
import {
  IDLE,
  claudeProcessHolds,
  claudeProcessPids,
  codexWriterLock,
  copilotLockPids,
  judgeTail,
  type ObservedSession,
  type ObservedTurn,
  type TurnVerdict
} from './liveness-core'

export type { ObservedSession, ObservedTurn } from './liveness-core'

/**
 * Live status for the sessions Cockpit did not spawn — the ones running in a terminal
 * or in the provider's own app, which is most of them — for the agents Cockpit drives:
 * an agent it only reads keeps turn records nothing here parses, so it is never busy. Nothing announces their turns,
 * but every provider streams its log as it works, so the indexer's watcher is the
 * signal: on each write the tracker reads a bounded tail (never the file), asks
 * liveness-core what it says, and keeps the session in the busy set while the log
 * keeps growing. A turn can go quiet for minutes and still be running — the model
 * thinking hard, a tool call (a test suite, a build) that writes nothing until it ends,
 * a question waiting on the person — but a killed CLI leaves a mid-turn tail forever
 * too, and only the process can tell those apart. So past its window an entry is kept
 * while the process running the turn says it still is: Copilot holds an
 * `inuse.<pid>.lock` beside the log for as long as its CLI runs, Claude keeps a
 * `sessions/<pid>.json` per running process naming its session and whether it is idle,
 * Codex holds a writer lock on the thread. Without that sign — a home of another shape,
 * an older CLI — silence ends it on a timer: LIVE_WINDOW_MS, or LIVE_TOOL_WINDOW_MS
 * while the newest record is a tool call waiting for its result. Best-effort by
 * design: an unreadable or unrecognised tail — or lock — is idle, never an error.
 *
 * A turn Cockpit stopped itself is the one case where the tracker is told rather than
 * left to read (`stopped`). The kill leaves the log mid-turn — a tool call with no
 * result, a prompt with no answer — and the CLI writes a few bookkeeping records as it
 * exits, so the tail reads exactly like a turn still running, for a whole window: ten
 * minutes inside a tool call, with Send held and no Stop to press. So the turn is over
 * the moment it is stopped, and stays over until the log opens a new one or ends.
 *
 * The transitions are news too (`onTurn`, for the attention desk): a turn seen
 * running whose log then writes its ending record has *ended* — an expiry is not
 * that, a killed CLI or a long tool call must never chime — and a running turn whose
 * newest record is a question or a permission prompt *asks*, until the log moves on.
 */

/** No write for this long and an observed turn is over, whatever its tail says — unless its process says otherwise (`holds`). */
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
/** Stopped turns remembered at once — the newest; one whose log never moves again is forgotten in time */
const STOPPED_KEEP = 64

/**
 * What the tail of one session log says right now: a verdict, or null when nothing in
 * the last LIVE_TAIL_STEPS bytes speaks for the turn. Bounded reads; a missing or
 * empty file is idle, never an error.
 */
export function readTurnState(file: string, provider: Provider): TurnVerdict | null {
  // copilot's legacy JSON snapshots never stream a turn
  if (provider === 'copilot' && !file.endsWith('events.jsonl')) return IDLE
  // each wider window reads only what the narrower one did not: a buried record used
  // to cost the 64KB, the 1MB and the 4MB read and parsed over again, one after another
  const tail = judgeJsonlTail(file, LIVE_TAIL_STEPS, (records) => judgeTail(provider, records))
  return tail.empty ? IDLE : tail.found
}

/**
 * Directory entries a lock check will look at. A Copilot session directory holds a
 * handful of files (the log, a workspace, the locks); the cap is what keeps the read
 * bounded whatever else has been dropped in there.
 */
export const LOCK_SCAN_ENTRIES = 64

/**
 * Is this pid one of ours, and still running? A lock under the user's own config home
 * was written by a process running as the user, so a pid we are not allowed to signal
 * is not that process — it is a pid the OS has since handed to someone else. Treating
 * it as gone is what keeps a recycled pid from pinning a session live forever.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
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
  return copilotLockPids(dirNames(dirname(file), LOCK_SCAN_ENTRIES)).some(pidAlive)
}

/** Up to `max` names in a directory; none when it can't be read. */
function dirNames(path: string, max: number): string[] {
  let dir: Dir
  try {
    dir = opendirSync(path)
  } catch {
    return []
  }
  const names: string[] = []
  try {
    for (let i = 0; i < max; i++) {
      const entry = dir.readSync()
      if (!entry) break
      names.push(entry.name)
    }
  } catch {
    // the directory went away mid-read: what was read is all there is
  } finally {
    try {
      dir.closeSync()
    } catch {
      // already closed
    }
  }
  return names
}

/**
 * Entries a Claude process check looks at: two per running Claude (`<pid>.json` and its
 * `.key`), and a few left behind by ones that crashed.
 */
const CLAUDE_PROCESS_ENTRIES = 256
/** A process file is a few hundred bytes of JSON */
const CLAUDE_PROCESS_BYTES = 16 * 1024

/**
 * Is a Claude process still holding the session this log belongs to? Claude Code keeps
 * `<config home>/sessions/<pid>.json` for each running process, naming the session it
 * has open — the log sits at `<config home>/projects/<project>/<id>.jsonl`. Only living
 * pids have their file read. Bounded; a home of another shape holds nothing.
 */
function claudeHolderAlive(file: string, nativeId: string): boolean {
  const projects = dirname(dirname(file))
  if (basename(projects) !== 'projects') return false
  const dir = join(dirname(projects), 'sessions')
  return claudeProcessPids(dirNames(dir, CLAUDE_PROCESS_ENTRIES)).some(
    (pid) => pidAlive(pid) && claudeProcessHolds(readJson(join(dir, `${pid}.json`), CLAUDE_PROCESS_BYTES), pid, nativeId)
  )
}

/**
 * Does a Codex process hold this writer lock? The file outlives its holder, so only an
 * open descriptor on it counts — which only lsof can see. Narrowed to processes named
 * codex (the app's server and the CLI both are): a whole-table lsof takes a second, this
 * one well under a tenth. No lsof, no match, a timeout: not held.
 */
async function codexLockHeld(lock: string): Promise<boolean> {
  if (!existsSync(lock)) return false
  const r = await execText('lsof', ['-t', '-a', '-c', 'codex', '--', lock], { timeoutMs: 5_000 })
  return /^\d+$/m.test(r.stdout)
}

type LiveEntry = {
  readonly id: string
  /** The provider's own id — what its process files and locks name the session by */
  readonly nativeId: string
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
  /** Whether a Codex writer lock is held — lsof by default; tests stand one in */
  readonly codexLockHeld?: (lock: string) => Promise<boolean>
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
  private readonly codexLockHeld: (lock: string) => Promise<boolean>
  /** An asking Codex entry's lock, as last checked (see codexHeld) */
  private readonly codexLocks = new Map<string, { held: boolean; checking: boolean }>()
  /** Sessions whose turn Cockpit stopped, each with when — oldest first (see `stopped`) */
  private readonly stoppedAt = new Map<string, number>()

  constructor(onChange: (sessions: BusySession[]) => void, opts: LivenessOptions = {}) {
    this.onChange = onChange
    this.onTurn = opts.onTurn ?? (() => {})
    this.windowMs = opts.windowMs ?? LIVE_WINDOW_MS
    this.toolWindowMs = Math.max(this.windowMs, opts.toolWindowMs ?? LIVE_TOOL_WINDOW_MS)
    this.sweepMs = opts.sweepMs ?? SWEEP_MS
    this.now = opts.now ?? Date.now
    this.codexLockHeld = opts.codexLockHeld ?? codexLockHeld
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
    // turns are read out of the logs of the CLIs Cockpit drives; an agent it only reads
    // keeps logs whose turn records it has never been taught
    if (!isDrivable(meta.provider)) return
    const written = Math.min(mtimeMs, meta.updatedAt)
    const prev = this.entries.get(meta.id)
    // an older page of a Codex thread shares the live page's id: nothing it says is news
    if (prev && file !== prev.file && written <= prev.lastWriteAt) return
    // The gate is for arrivals. The indexer also re-reads a log that has not changed,
    // when a file beside it did (Codex's name index, when that thread is named;
    // Copilot's workspace.yaml) — and at the 90s gate that re-read dropped a turn ten
    // minutes into a tool call: shown idle while it ran, its real ending never
    // announced. A running entry is kept by the rule the sweep keeps it by.
    if (this.now() - written > this.windowMs && !(prev && this.holds(prev, this.now()))) {
      this.drop(meta.id)
      return
    }
    const verdict = readTurnState(file, meta.provider)
    if (verdict === null) {
      // the tail is silent (a run of huge records): a turn that was running still is —
      // its end always writes a small decisive record — and one that wasn't is not invented
      if (prev) prev.lastWriteAt = Math.max(prev.lastWriteAt, written)
      return
    }
    const stoppedAt = this.stoppedAt.get(meta.id)
    if (stoppedAt !== undefined) {
      // the turn Cockpit stopped, still mid-turn in its log: that is the kill. A new
      // turn opens after the stop; one whose start the tail can't say is the old one
      if (verdict.live && !(verdict.startedAt !== null && verdict.startedAt > stoppedAt)) return
      this.stoppedAt.delete(meta.id)
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
      // the busy set carries the question, so asking or moving past it is a change too
      if (!newTurn && !askChanged) return
      prev.startedAt = startedAt
    } else {
      this.entries.set(meta.id, {
        id: meta.id,
        nativeId: meta.nativeId,
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

  /** Sessions whose logs show a turn in progress — and what it waits on, if anything —
   *  as the busy set wants them. */
  sessions(): BusySession[] {
    return [...this.entries.values()].map((e) => ({
      id: e.id,
      startedAt: e.startedAt,
      source: 'observed' as const,
      ...(e.asks ? { asks: e.asks } : {})
    }))
  }

  /**
   * Cockpit stopped the turn running in this session: it is over now, whatever its log
   * says (the header). An entry for it goes at once — not an ending, which is news only
   * when the log writes one — and what the log says of that turn from here on is the
   * kill: a live tail is passed over until it names a turn opened after this moment.
   */
  stopped(id: string): void {
    this.stoppedAt.delete(id)
    this.stoppedAt.set(id, this.now())
    while (this.stoppedAt.size > STOPPED_KEEP) this.stoppedAt.delete(this.stoppedAt.keys().next().value as string)
    this.drop(id)
  }

  /**
   * Forget everything running: no more writes will arrive once the watchers are down.
   * What Cockpit stopped stays stopped — a new source rescans every fresh log, the
   * stopped turn's mid-turn tail among them.
   */
  stop(): void {
    this.stopSweep()
    this.codexLocks.clear()
    if (this.entries.size === 0) return
    this.entries.clear()
    this.emit()
  }

  private drop(id: string): void {
    this.codexLocks.delete(id)
    if (!this.entries.delete(id)) return
    if (this.entries.size === 0) this.stopSweep()
    this.emit()
  }

  private sweep(): void {
    const now = this.now()
    let changed = false
    for (const [id, e] of this.entries) {
      if (this.holds(e, now)) continue
      this.entries.delete(id)
      this.codexLocks.delete(id)
      changed = true
    }
    if (this.entries.size === 0) this.stopSweep()
    if (changed) this.emit()
  }

  /**
   * Inside its window — or past it, while the process running the turn is still there
   * and still at it: a long think, a long tool call and a question all write nothing for
   * as long as they take. Only ever asked of a turn seen running, so a holder alone never
   * starts one (the arrival gate in observe()).
   */
  private holds(e: LiveEntry, now: number): boolean {
    if (now - e.lastWriteAt <= e.windowMs) return true
    if (e.provider === 'copilot') return copilotHolderAlive(e.file)
    return e.provider === 'claude' ? claudeHolderAlive(e.file, e.nativeId) : this.codexHeld(e)
  }

  /**
   * Whether a Codex process still holds a quiet thread, as lsof last said. lsof is a
   * process, not a read, so it is never waited on here: each sweep asks again and the
   * answer decides the sweep after it, which keeps the entry one sweep past its holder
   * at most. Until the first answer the entry is kept — a wait, not a verdict.
   */
  private codexHeld(e: LiveEntry): boolean {
    const lock = codexWriterLock(e.file, e.nativeId, sep)
    if (!lock) return false
    const known = this.codexLocks.get(e.id)
    if (!known?.checking) {
      this.codexLocks.set(e.id, { held: known?.held ?? true, checking: true })
      void this.codexLockHeld(lock).then((held) => {
        // an entry dropped meanwhile keeps no answer
        if (this.codexLocks.has(e.id)) this.codexLocks.set(e.id, { held, checking: false })
      })
    }
    return known?.held ?? true
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
