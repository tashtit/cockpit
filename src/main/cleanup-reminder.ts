import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CleanupNotice } from '../shared/types'
import {
  EMPTY_REMINDER,
  TICK_MS,
  judgeCheck,
  markShown,
  nextCheckAt,
  sanitizeReminder,
  type CleanupReady,
  type ReminderState
} from './cleanup-reminder-core'

/**
 * Cleanup reminders, the IO half: the timer that runs the cleanup scan once a day in
 * the background, and the file that remembers what the person has already been shown.
 * `cleanup-reminder-core.ts` decides; the attention desk tells.
 */

export type CleanupReminderDeps = {
  /** Where the last check and what was shown survive a restart */
  readonly file: string
  /**
   * The Cleanup view's own scan, reduced to what could go right now. When the view is
   * scanning at the same moment, both get the one survey (`surveyCleanup`).
   */
  readonly survey: () => Promise<CleanupReady>
  /** The Settings switch — off means no scan at all */
  readonly enabled: () => boolean
  /** Something new is ready to clean: the attention desk takes it from here */
  readonly remind: (notice: CleanupNotice) => void
  readonly now?: () => number
}

function readState(file: string): ReminderState {
  try {
    return sanitizeReminder(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    // first run, or a hand-edited file: at worst one reminder too many
    return EMPTY_REMINDER
  }
}

export class CleanupReminder {
  private readonly deps: CleanupReminderDeps
  private readonly now: () => number
  private state: ReminderState
  /** When the index was first ready — checks wait for it; null until `start` */
  private readyAt: number | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private checking = false

  constructor(deps: CleanupReminderDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.state = readState(deps.file)
  }

  /** The index has its first scan: the clock starts (the first check still waits a while). */
  start(): void {
    this.readyAt ??= this.now()
    this.arm()
  }

  /** The switch changed: arm the timer, or stand it down. */
  reschedule(): void {
    this.arm()
  }

  /**
   * The Cleanup view just scanned, so everything ready is on the person's screen —
   * that is being shown it. Nothing on that list is news for the next reminder, and the
   * quiet week starts over.
   */
  seen(ready: CleanupReady): void {
    this.state = markShown(this.state, ready, this.now())
    this.save()
  }

  /** Run one check now: survey, judge, remind. Resolves with what was said, if anything. */
  async check(): Promise<CleanupNotice | null> {
    if (this.checking) return null
    this.checking = true
    try {
      const ready = await this.deps.survey()
      const { state, notice } = judgeCheck(this.state, ready, this.now())
      this.state = state
      this.save()
      if (notice) this.deps.remind(notice)
      return notice
    } catch (err) {
      // a scan that throws is retried tomorrow, not on every tick
      console.error('[cleanup] reminder check failed:', err)
      this.state = { ...this.state, checkedAt: this.now() }
      this.save()
      return null
    } finally {
      this.checking = false
      this.arm()
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.readyAt = null
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.readyAt === null || this.checking || !this.deps.enabled()) return
    const now = this.now()
    const due = nextCheckAt(this.state, { readyAt: this.readyAt, now })
    // an hourly look at the wall clock: a sleeping Mac holds timers still
    this.timer = setTimeout(
      () => {
        this.timer = null
        if (this.now() >= due) void this.check()
        else this.arm()
      },
      Math.min(Math.max(0, due - now), TICK_MS)
    )
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.deps.file), { recursive: true })
      // write-then-rename: a crash mid-write must never leave a truncated file
      const tmp = `${this.deps.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.state))
      renameSync(tmp, this.deps.file)
    } catch (err) {
      console.error('[cleanup] could not save the reminder state:', err)
    }
  }
}
