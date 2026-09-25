import type { CleanupNotice } from '../shared/types'

/**
 * Cleanup reminders, the IO-free half: whether what a background cleanup scan found is
 * worth telling the person, and when the next check is due. `cleanup-reminder.ts` runs
 * the scan on a timer and keeps the file; the attention desk posts the banner and marks
 * Cleanup in the sidebar.
 *
 * "Once in a while" runs on two clocks. The check is daily — a scan is a few seconds of
 * git, lsof and du, nothing worth running hourly. A reminder goes out at most weekly, and
 * only when something is ready to clean that the person has not been shown yet: not in
 * the last reminder, and not in the list the last time they opened Cleanup. What they
 * looked at and chose to keep is never raised again — a reminder that repeats itself
 * is one people learn to ignore.
 */

export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000
export const REMIND_EVERY_MS = 7 * 24 * 60 * 60 * 1000
/** The first check waits this long after the index is ready — launch is busy enough. */
export const FIRST_CHECK_DELAY_MS = 5 * 60 * 1000
/**
 * The longest a timer is armed for. macOS keeps the monotonic clock still while the
 * machine sleeps, so a day-long timer on a laptop that sleeps most of the day would fire
 * days late; an hourly look at the wall clock keeps the daily check daily.
 */
export const TICK_MS = 60 * 60 * 1000
/** Keys remembered as shown — more than every session a big index could hold stale. */
const SHOWN_MAX = 20_000
const KEY_MAX = 600

/** What a scan found that could go right now, keyed — the reminder's view of a report. */
export type CleanupReady = {
  readonly staleDays: number
  /** Unblocked stale sessions, by id (their worktrees go with them) */
  readonly sessions: readonly string[]
  /** Unblocked stale worktrees no ready session takes with it, by path */
  readonly worktrees: readonly string[]
  /** Roundtables not mid-round, by id */
  readonly tables: readonly string[]
  /** Processes left in old worktrees, by `processKey` */
  readonly processes: readonly string[]
  /** What cleaning every one of them would free, each worktree counted once */
  readonly bytes: number
}

/**
 * A left-behind process, as something shown once. A pid alone is handed out again, and
 * its start time is re-derived from `etime` on every scan (a second or two of drift), so
 * the command line is what pins it.
 */
export function processKey(p: { readonly pid: number; readonly command: string }): string {
  return `${p.pid} ${p.command}`
}

export type ReminderState = {
  /** When the last check ran; 0 before the first */
  readonly checkedAt: number
  /** When the person was last reminded, or last opened Cleanup; 0 when never */
  readonly shownAt: number
  /** Everything ready at that moment (`kind:key`) — what is not news any more */
  readonly shown: readonly string[]
}

export const EMPTY_REMINDER: ReminderState = { checkedAt: 0, shownAt: 0, shown: [] }

function keysOf(ready: CleanupReady): string[] {
  return [
    ...ready.sessions.map((k) => `s:${k}`),
    ...ready.worktrees.map((k) => `w:${k}`),
    ...ready.tables.map((k) => `t:${k}`),
    ...ready.processes.map((k) => `p:${k}`)
  ]
}

/** What the reminder says: all of it, not only the new part. */
export function noticeFor(ready: CleanupReady, at: number): CleanupNotice {
  return {
    at,
    staleDays: ready.staleDays,
    sessions: ready.sessions.length,
    worktrees: ready.worktrees.length,
    tables: ready.tables.length,
    processes: ready.processes.length,
    bytes: ready.bytes
  }
}

/** The person has now seen everything ready — by a reminder, or by opening Cleanup. */
export function markShown(state: ReminderState, ready: CleanupReady, now: number): ReminderState {
  return { ...state, shownAt: now, shown: keysOf(ready).map((k) => k.slice(0, KEY_MAX)).slice(0, SHOWN_MAX) }
}

/**
 * A check came back. Remind when the quiet week since the last reminder (or visit) is up
 * and something ready now was not ready then; otherwise just note that it ran.
 */
export function judgeCheck(
  state: ReminderState,
  ready: CleanupReady,
  now: number
): { readonly state: ReminderState; readonly notice: CleanupNotice | null } {
  const checked = { ...state, checkedAt: now }
  // a clock set back must not hold reminders off for as long as it jumped
  if (state.shownAt <= now && now - state.shownAt < REMIND_EVERY_MS) return { state: checked, notice: null }
  const shown = new Set(state.shown)
  if (!keysOf(ready).some((k) => !shown.has(k.slice(0, KEY_MAX)))) return { state: checked, notice: null }
  return { state: markShown(checked, ready, now), notice: noticeFor(ready, now) }
}

/**
 * When the next check is due: a day after the last one, and never sooner than a short
 * wait after the index is ready. A `checkedAt` from a clock that was ahead counts as now.
 */
export function nextCheckAt(state: ReminderState, at: { readonly readyAt: number; readonly now: number }): number {
  return Math.max(at.readyAt + FIRST_CHECK_DELAY_MS, Math.min(state.checkedAt, at.now) + CHECK_EVERY_MS)
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/** The saved file is untrusted input: keep what is well-formed, forget the rest. */
export function sanitizeReminder(raw: unknown): ReminderState {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const shown = Array.isArray(o['shown']) ? o['shown'] : []
  return {
    checkedAt: num(o['checkedAt']),
    shownAt: num(o['shownAt']),
    shown: shown
      .filter((k): k is string => typeof k === 'string')
      .slice(0, SHOWN_MAX)
      .map((k) => k.slice(0, KEY_MAX))
  }
}
