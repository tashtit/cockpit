import { app, Notification } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type {
  AttentionFocus,
  AttentionPrefs,
  AttentionTarget,
  ChatEvent,
  CleanupNotice,
  Landing,
  NotificationDelivery,
  PrStatus,
  SessionMeta
} from '../shared/types'
import {
  AttentionTracker,
  sanitizeSeenPrs,
  sanitizeUnseen,
  type Notice,
  type TableEnd,
  type TurnStart,
  type Unseen
} from './attention-core'
import { execText } from './env'
import { readTurnState } from './liveness'
import type { ObservedTurn } from './liveness-core'

/**
 * Attention, the IO half: carries out what `attention-core.ts` decides. The desk
 * owns the burst timer, the file that keeps landings across a restart, and the
 * pushes to the renderer; every OS call goes through an `AttentionSurface`, so
 * the desk runs headless in tests and only `electronSurface()` touches macOS.
 */

/** The OS side: banners, the Dock and the speaker. */
export type AttentionSurface = {
  /** Post a banner; resolves once macOS has shown it, refused it, or kept quiet too long */
  readonly notify: (notice: Notice, onClick: () => void) => Promise<NotificationDelivery>
  /** Take delivered banners out of Notification Center */
  readonly withdraw: (ids: readonly string[]) => void
  readonly setBadge: (count: number) => void
  readonly play: (sound: 'finish' | 'fail') => void
  /** One Dock bounce — how a refused banner still gets noticed */
  readonly bounce: () => void
}

export type AttentionDeskDeps = {
  /** Where unseen landings survive a restart */
  readonly file: string
  readonly surface: AttentionSurface
  readonly prefs: AttentionPrefs
  /** A session's title from the index, when it has one */
  readonly titleFor: (u: Unseen) => string | null
  readonly onLandings: (landings: Landing[]) => void
  /** The sidebar's Cleanup key: a reminder arrived, or the view was opened (null) */
  readonly onCleanup: (notice: CleanupNotice | null) => void
  /** A banner was clicked; null only brings the window forward (the Settings sample) */
  readonly onOpen: (target: AttentionTarget | null) => void
  readonly now?: () => number
}

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
  readonly seenPrs: Array<[string, string]>
}

function readSaved(file: string, now: number): Saved {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { unseen?: unknown; prs?: unknown }
    return { unseen: sanitizeUnseen(parsed?.unseen, now), seenPrs: sanitizeSeenPrs(parsed?.prs) }
  } catch {
    // first run, or a hand-edited file: landings are news, not records — start clean
    return { unseen: [], seenPrs: [] }
  }
}

export class AttentionDesk {
  private readonly deps: AttentionDeskDeps
  private readonly tracker: AttentionTracker
  private prefs: AttentionPrefs
  private timer: ReturnType<typeof setTimeout> | null = null
  private sentLandings: string
  private sentCleanup: string
  private savedEntries: string
  /** What the Dock shows now — the OS is only called when it changes */
  private badge = 0

  constructor(deps: AttentionDeskDeps) {
    this.deps = deps
    const now = deps.now ?? Date.now
    const saved = readSaved(deps.file, now())
    this.tracker = new AttentionTracker({ now, unseen: saved.unseen, seenPrs: saved.seenPrs })
    this.prefs = deps.prefs
    this.sentLandings = JSON.stringify(this.tracker.landings())
    this.sentCleanup = JSON.stringify(this.tracker.cleanupNotice())
    this.savedEntries = this.serialize()
    this.sync()
  }

  get currentPrefs(): AttentionPrefs {
    return this.prefs
  }

  landings(): Landing[] {
    return this.tracker.landings()
  }

  cleanupNotice(): CleanupNotice | null {
    return this.tracker.cleanupNotice()
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

  /** A turn in a session run elsewhere started, stopped to ask, or ended (liveness.ts). */
  observedTurn(ev: ObservedTurn): void {
    this.tracker.observedTurn(ev)
    this.sync()
  }

  /** One repo's PR list came back (github.ts): red ones on a session's branch are news once per push. */
  prsUpdated(repoRoot: string, prs: readonly PrStatus[], carrierFor: (pr: PrStatus) => string | null): void {
    this.tracker.prsUpdated(repoRoot, prs, carrierFor)
    this.sync()
  }

  /** The daily cleanup check found something new to clean (cleanup-reminder.ts). */
  cleanupReady(notice: CleanupNotice): void {
    this.tracker.cleanupReady(notice)
    this.sync()
  }

  /**
   * Once the first index scan knows where every log is: a question saved as waiting may
   * have been answered, or its CLI closed, while Cockpit was not running. Re-read each
   * one's tail and keep only those whose newest record still asks.
   */
  recheckAsks(sessionFor: (id: string) => Pick<SessionMeta, 'provider' | 'sourcePath'> | null): void {
    this.tracker.settleAsks((u) => {
      const s = u.id === null ? null : sessionFor(u.id)
      return s !== null && readTurnState(s.sourcePath, s.provider)?.asks !== undefined
    })
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

  resolve(find: (u: Unseen) => string | null): void {
    this.tracker.resolve(find)
    this.sync()
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
  }

  /** Bring the badge, the renderer, the file and the burst timer in line with the tracker. */
  private sync(): void {
    const { surface } = this.deps
    const landings = JSON.stringify(this.tracker.landings())
    if (landings !== this.sentLandings) {
      this.sentLandings = landings
      this.deps.onLandings(this.tracker.landings())
    }
    const cleanup = JSON.stringify(this.tracker.cleanupNotice())
    if (cleanup !== this.sentCleanup) {
      this.sentCleanup = cleanup
      this.deps.onCleanup(this.tracker.cleanupNotice())
    }
    const entries = this.serialize()
    if (entries !== this.savedEntries) {
      this.savedEntries = entries
      this.save(entries)
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
      const now = (this.deps.now ?? Date.now)()
      this.timer = setTimeout(() => this.flush(), Math.max(0, due - now))
    }
  }

  private flush(): void {
    this.timer = null
    const { notice, sound } = this.tracker.flush(this.prefs, this.deps.titleFor)
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

  /** The file's contents: what is unseen, and which PRs have already been raised. */
  private serialize(): string {
    return JSON.stringify({ unseen: this.tracker.entries(), prs: this.tracker.seenPrEntries() })
  }

  private save(json: string): void {
    try {
      mkdirSync(dirname(this.deps.file), { recursive: true })
      // write-then-rename: a crash mid-write must never leave a truncated file
      const tmp = `${this.deps.file}.tmp`
      writeFileSync(tmp, json)
      renameSync(tmp, this.deps.file)
    } catch (err) {
      console.error('[attention] could not save landings:', err)
    }
  }
}

/** macOS system sounds: on every Mac already, so nothing third-party ships with the app. */
const SOUND_FILE: Record<'finish' | 'fail', string> = {
  finish: '/System/Library/Sounds/Glass.aiff',
  fail: '/System/Library/Sounds/Basso.aiff'
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
