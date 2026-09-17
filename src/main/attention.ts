import { app, Notification } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  AttentionFocus,
  AttentionItem,
  AttentionPrefs,
  AttentionTarget,
  ChatEvent,
  NotificationDelivery,
  PrStatus,
  Provider,
  SessionMeta
} from '../shared/types'
import {
  AttentionTracker,
  QUIET,
  judgeAttentionTail,
  providerOf,
  sanitizeMemory,
  sanitizeUnseen,
  type Notice,
  type PrSignal,
  type Sound,
  type TableEnd,
  type TailAttention,
  type TurnStart,
  type Unseen
} from './attention-core'
import { execText } from './env'
import { LIVE_TAIL_STEPS, LIVE_WINDOW_MS, type ObservedTurnEnd } from './liveness'
import { parseJsonlText, readTail } from './parsers/util'

/**
 * Attention, the IO half: carries out what `attention-core.ts` decides. The desk
 * owns the burst timer, the file that keeps the list across a restart, the tail
 * reads that tell it what an agent waits for, the PR sweep, and the pushes to the
 * renderer; every OS call goes through an `AttentionSurface`, so the desk runs
 * headless in tests and only `electronSurface()` touches macOS.
 */

/** The OS side: banners, the Dock and the speaker. */
export type AttentionSurface = {
  /** Post a banner; resolves once macOS has shown it, refused it, or kept quiet too long */
  readonly notify: (notice: Notice, onClick: () => void) => Promise<NotificationDelivery>
  /** Take delivered banners out of Notification Center */
  readonly withdraw: (ids: readonly string[]) => void
  readonly setBadge: (count: number) => void
  readonly play: (sound: Sound) => void
  /** One Dock bounce — how a refused banner still gets noticed */
  readonly bounce: () => void
}

/** Where pull requests come from: the badges' own reader, scoped to the user's branches. */
export type AttentionPrSource = {
  /** Every repo root the index knows */
  readonly roots: () => readonly string[]
  /** The repo's PRs as the badges read them — cached, failing soft to [] */
  readonly list: (root: string) => Promise<PrStatus[]>
  /** The newest session on a branch of that repo: the user's own work, or null for someone else's PR */
  readonly sessionOnBranch: (root: string, branch: string) => SessionMeta | null
}

export type AttentionDeskDeps = {
  /** Where the list survives a restart */
  readonly file: string
  readonly surface: AttentionSurface
  readonly prefs: AttentionPrefs
  /** The index's row for a session, when it has one */
  readonly sessionFor: (id: string) => SessionMeta | null
  readonly onItems: (items: AttentionItem[]) => void
  /** A banner was clicked; null only brings the window forward (the Settings sample) */
  readonly onOpen: (target: AttentionTarget | null) => void
  /** Pull requests on the user's branches; left out, the desk never runs gh */
  readonly prs?: AttentionPrSource
  readonly prSweepMs?: number
  readonly now?: () => number
}

/** PR sweeps run gh once per repo this often; the badges' 60s cache absorbs the sidebar's own asks. */
export const PR_SWEEP_MS = 5 * 60_000

const SAMPLE: Notice = {
  id: 'cockpit:sample',
  title: 'Claude finished after 4m',
  subtitle: 'Sample notification — nothing ran',
  body: 'This is how Cockpit tells you a session needs you.',
  failed: false,
  target: { kind: 'home' },
  keys: []
}

type Saved = {
  readonly unseen: Unseen[]
  readonly seen: Array<[string, string]>
  readonly noticed: Array<[string, string]>
}

function readSaved(file: string, now: number): Saved {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    return {
      unseen: sanitizeUnseen(parsed?.['unseen'], now),
      seen: sanitizeMemory(parsed?.['seen']),
      noticed: sanitizeMemory(parsed?.['noticed'])
    }
  } catch {
    // first run, or a hand-edited file: what needs you is news, not records — start clean
    return { unseen: [], seen: [], noticed: [] }
  }
}

/**
 * What the tail of one session log says the agent waits for, or how its turn
 * ended: the same bounded, escalating read as liveness.ts, judged by
 * attention-core. Null when nothing in the last LIVE_TAIL_STEPS bytes speaks for
 * it; a missing or empty file is quiet, never an error.
 */
export function readTailAttention(file: string, provider: Provider): TailAttention | null {
  // copilot's legacy JSON snapshots never wait on anyone
  if (provider === 'copilot' && !file.endsWith('events.jsonl')) return QUIET
  for (const bytes of LIVE_TAIL_STEPS) {
    const tail = readTail(file, bytes)
    if (!tail.text) return QUIET
    // a truncated tail opens mid-record — drop the partial line
    const text = tail.truncated ? tail.text.slice(tail.text.indexOf('\n') + 1) : tail.text
    const verdict = judgeAttentionTail(provider, parseJsonlText(text, false))
    if (verdict) return verdict
    if (!tail.truncated) return null // that was the whole file
  }
  return null
}

export class AttentionDesk {
  private readonly deps: AttentionDeskDeps
  private readonly tracker: AttentionTracker
  private readonly clock: () => number
  private prefs: AttentionPrefs
  private timer: ReturnType<typeof setTimeout> | null = null
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private sweeping = false
  private swept = false
  private revalidated = false
  private sentItems: string
  private savedState: string
  /** What the Dock shows now — the OS is only called when it changes */
  private badge = 0

  constructor(deps: AttentionDeskDeps) {
    this.deps = deps
    this.clock = deps.now ?? Date.now
    const saved = readSaved(deps.file, this.clock())
    this.tracker = new AttentionTracker({ now: this.clock, ...saved })
    this.prefs = deps.prefs
    this.sentItems = JSON.stringify(this.items())
    this.savedState = this.stateJson()
    if (deps.prs) {
      this.sweepTimer = setInterval(() => void this.sweepPrs(), deps.prSweepMs ?? PR_SWEEP_MS)
      // a sweep timer must never be what keeps the process alive
      this.sweepTimer.unref()
    }
    this.sync()
  }

  get currentPrefs(): AttentionPrefs {
    return this.prefs
  }

  /** The list as the renderer shows it, newest first. */
  items(): AttentionItem[] {
    return this.tracker.items(this.deps.sessionFor)
  }

  /* stream-side calls are hot (every text chunk) — only an ending can change what shows */

  turnStarted(start: TurnStart): void {
    this.tracker.turnStarted(start)
  }

  turnCancelled(turnId: string): void {
    this.tracker.turnCancelled(turnId)
  }

  chatEvent(ev: ChatEvent): void {
    this.tracker.chatEvent(ev)
    if (ev.type === 'done') this.sync()
  }

  tableEnded(end: TableEnd): void {
    this.tracker.tableEnded(end)
    this.sync()
  }

  /**
   * The indexer re-parsed a session's log: read what its tail says the agent waits
   * for. Same freshness gate as liveness — a cold scan over thousands of old logs
   * reads no tails — and Cockpit's own turns are skipped: `-p` mode never waits, and
   * the stream already says how those end.
   */
  observeLog(file: string, meta: SessionMeta, mtimeMs: number): void {
    const written = Math.min(mtimeMs, meta.updatedAt)
    if (this.clock() - written > LIVE_WINDOW_MS) return
    if (this.tracker.spawnedIds().has(meta.id)) return
    const tail = readTailAttention(file, meta.provider)
    // a silent tail (a run of huge records) changes nothing the desk knows
    if (!tail) return
    this.tracker.observed(meta.id, meta.provider, tail, written)
    this.sync()
  }

  /** The liveness tracker saw a log end its turn. */
  observedEnd(end: ObservedTurnEnd): void {
    const provider = providerOf(end.id)
    if (!provider) return
    this.tracker.observedEnd({ ...end, provider })
    this.sync()
  }

  setFocus(focus: AttentionFocus): void {
    this.tracker.setFocus(focus)
    this.sync()
  }

  setWindowFocused(focused: boolean): void {
    this.tracker.setWindowFocused(focused)
    this.sync()
  }

  /** The user looked at an item some way other than opening its session. */
  markSeen(key: string): void {
    this.tracker.markSeen(key)
    this.sync()
  }

  /**
   * The index updated: id-less landings may have found their session, persisted
   * asks can be checked against their logs (once — those files were not re-parsed
   * after a restart, so nothing else would), and the first PR sweep has roots to run
   * over.
   */
  resolve(find: (u: Unseen) => string | null): void {
    this.tracker.resolve(find)
    if (!this.revalidated) {
      this.revalidated = true
      this.revalidate()
    }
    if (this.deps.prs && !this.swept) void this.sweepPrs()
    this.sync()
  }

  /** Read every open PR on the user's branches now — the timer does this on its own otherwise. */
  async sweepPrs(): Promise<void> {
    const { prs } = this.deps
    if (!prs || this.sweeping) return
    this.sweeping = true
    this.swept = true
    try {
      const signals: PrSignal[] = []
      for (const root of prs.roots()) {
        let list: PrStatus[]
        try {
          list = await prs.list(root)
        } catch {
          continue // one repo's gh trouble is not the others'
        }
        for (const pr of list) {
          if (pr.state !== 'OPEN') continue
          // someone else's PR in a shared repo waits on someone else
          const session = prs.sessionOnBranch(root, pr.headRefName)
          if (!session) continue
          signals.push({ pr, repoRoot: root, session })
        }
      }
      this.tracker.setPrs(signals)
      this.sync()
    } finally {
      this.sweeping = false
    }
  }

  setPrefs(prefs: AttentionPrefs): void {
    this.prefs = prefs
    this.sync()
  }

  /** The Settings button: a sample banner whatever the switch says (the user asked); the sound keeps its own switch. */
  async test(): Promise<NotificationDelivery> {
    if (this.prefs.sound) this.deps.surface.play('finish')
    // clicking the sample must not navigate away from the Settings that sent it
    return this.deps.surface.notify(SAMPLE, () => this.deps.onOpen(null))
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    this.sweepTimer = null
  }

  /** Persisted asks re-read from their logs: answered while the app was closed means gone. */
  private revalidate(): void {
    for (const u of this.tracker.entries()) {
      if (u.kind !== 'session' || u.id === null) continue
      if (u.reason !== 'question' && u.reason !== 'permission') continue
      const s = this.deps.sessionFor(u.id)
      if (!s) continue
      const tail = readTailAttention(s.sourcePath, s.provider)
      if (tail) this.tracker.observed(u.id, s.provider, tail, u.startedAt)
    }
  }

  private stateJson(): string {
    return JSON.stringify({
      unseen: this.tracker.entries(),
      seen: this.tracker.seenEntries(),
      noticed: this.tracker.noticedEntries()
    })
  }

  /** Bring the badge, the renderer, the file and the burst timer in line with the tracker. */
  private sync(): void {
    const { surface } = this.deps
    const items = this.items()
    const sent = JSON.stringify(items)
    if (sent !== this.sentItems) {
      this.sentItems = sent
      this.deps.onItems(items)
    }
    const state = this.stateJson()
    if (state !== this.savedState) {
      this.savedState = state
      this.save(state)
    }
    const badge = this.tracker.badgeCount(this.prefs)
    if (badge !== this.badge) {
      this.badge = badge
      surface.setBadge(badge)
    }
    const withdrawn = this.tracker.takeWithdrawn()
    if (withdrawn.length > 0) surface.withdraw(withdrawn)
    const due = this.tracker.flushAt()
    if (due !== null && this.timer === null) {
      this.timer = setTimeout(() => this.flush(), Math.max(0, due - this.clock()))
    }
  }

  private flush(): void {
    this.timer = null
    const { notice, sound } = this.tracker.flush(this.prefs, (u) =>
      u.id ? (this.deps.sessionFor(u.id)?.title ?? null) : null
    )
    if (sound) this.deps.surface.play(sound)
    if (notice) {
      void this.deps.surface
        .notify(notice, () => this.deps.onOpen(this.tracker.targetFor(notice)))
        .then((delivery) => {
          // unsigned builds are never allowed to post banners — still get noticed
          if (delivery.status === 'refused') this.deps.surface.bounce()
        })
    }
    this.sync()
  }

  private save(state: string): void {
    try {
      mkdirSync(dirname(this.deps.file), { recursive: true })
      // write-then-rename: a crash mid-write must never leave a truncated file
      const tmp = `${this.deps.file}.tmp`
      writeFileSync(tmp, state)
      renameSync(tmp, this.deps.file)
    } catch (err) {
      console.error('[attention] could not save the list:', err)
    }
  }
}

/** macOS system sounds: on every Mac already, so nothing third-party ships with the app. */
const SOUND_FILE: Record<Sound, string> = {
  finish: '/System/Library/Sounds/Glass.aiff',
  fail: '/System/Library/Sounds/Basso.aiff',
  ask: '/System/Library/Sounds/Ping.aiff'
}

/** No answer from macOS within this long means the permission prompt is probably up. */
const DELIVERY_WAIT_MS = 4_000
/** Electron stops firing click events for a Notification it has garbage-collected. */
const LIVE_MAX = 20

/** The real OS: Electron's Notification, the Dock, and afplay. macOS only — elsewhere quiet no-ops. */
export function electronSurface(): AttentionSurface {
  const mac = process.platform === 'darwin'
  const live = new Map<string, Notification>()
  return {
    notify: (notice, onClick) =>
      new Promise((done) => {
        if (!Notification.isSupported()) {
          done({ status: 'refused', message: 'Notifications are not supported on this system.' })
          return
        }
        let settled = false
        const settle = (d: NotificationDelivery): void => {
          if (settled) return
          settled = true
          done(d)
        }
        const n = new Notification({
          id: notice.id,
          title: notice.title,
          ...(notice.subtitle ? { subtitle: notice.subtitle } : {}),
          body: notice.body,
          // the sound is Cockpit's own (afplay), so it follows the Sound switch even
          // where macOS refuses the banner
          silent: true
        })
        n.on('show', () => settle({ status: 'shown' }))
        n.on('failed', (_e, error) => settle({ status: 'refused', message: String(error) }))
        n.on('click', onClick)
        live.delete(notice.id)
        live.set(notice.id, n)
        while (live.size > LIVE_MAX) live.delete(live.keys().next().value as string)
        n.show()
        setTimeout(() => settle({ status: 'unknown' }), DELIVERY_WAIT_MS)
      }),
    withdraw: (ids) => {
      if (!mac) return
      try {
        Notification.remove([...ids])
      } catch {
        /* nothing delivered under those ids */
      }
      for (const id of ids) live.delete(id)
    },
    setBadge: (count) => {
      app.setBadgeCount(count)
    },
    play: (sound) => {
      if (mac) void execText('/usr/bin/afplay', [SOUND_FILE[sound]], { timeoutMs: 10_000 })
    },
    bounce: () => {
      app.dock?.bounce('informational')
    }
  }
}
