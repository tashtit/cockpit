import { describe, it, expect } from 'vitest'
import {
  CHECK_EVERY_MS,
  EMPTY_REMINDER,
  FIRST_CHECK_DELAY_MS,
  REMIND_EVERY_MS,
  judgeCheck,
  markShown,
  nextCheckAt,
  noticeFor,
  processKey,
  sanitizeReminder,
  type CleanupReady
} from '../src/main/cleanup-reminder-core'
import type { OrphanProcess } from '../src/shared/types'

const DAY = 24 * 60 * 60 * 1000
const T0 = 1_700_000_000_000

function ready(over: Partial<CleanupReady> = {}): CleanupReady {
  return {
    staleDays: 30,
    sessions: ['claude:a', 'codex:b'],
    worktrees: ['/src/rocket/.claude/worktrees/old'],
    tables: [],
    processes: [],
    bytes: 3_000_000,
    ...over
  }
}

describe('judgeCheck — whether a check is worth a reminder', () => {
  it('the first check with anything ready reminds, and says all of it', () => {
    const { state, notice } = judgeCheck(EMPTY_REMINDER, ready(), T0)
    expect(notice).toEqual({
      at: T0,
      staleDays: 30,
      sessions: 2,
      worktrees: 1,
      tables: 0,
      processes: 0,
      bytes: 3_000_000
    })
    expect(state).toMatchObject({ checkedAt: T0, shownAt: T0 })
  })

  it('nothing ready is nothing to say — but the check still counts as run', () => {
    const empty = ready({ sessions: [], worktrees: [], bytes: 0 })
    const { state, notice } = judgeCheck(EMPTY_REMINDER, empty, T0)
    expect(notice).toBeNull()
    expect(state).toEqual({ checkedAt: T0, shownAt: 0, shown: [] })
  })

  it('what was already shown is never raised again, however long it waits', () => {
    const first = judgeCheck(EMPTY_REMINDER, ready(), T0).state
    const later = judgeCheck(first, ready(), T0 + 30 * DAY)
    expect(later.notice).toBeNull()
    // and the quiet week does not restart for a check that said nothing
    expect(later.state.shownAt).toBe(T0)
  })

  it('something new inside the quiet week waits for the week to be up', () => {
    const first = judgeCheck(EMPTY_REMINDER, ready(), T0).state
    const grown = ready({ sessions: ['claude:a', 'codex:b', 'copilot:c'] })
    const tomorrow = judgeCheck(first, grown, T0 + DAY)
    expect(tomorrow.notice).toBeNull()
    const nextWeek = judgeCheck(tomorrow.state, grown, T0 + REMIND_EVERY_MS)
    expect(nextWeek.notice).toMatchObject({ sessions: 3 })
    expect(nextWeek.state.shownAt).toBe(T0 + REMIND_EVERY_MS)
  })

  it('something new is news even when the total shrank — counts would miss that', () => {
    const first = judgeCheck(EMPTY_REMINDER, ready(), T0).state
    // two sessions were cleaned, one new one went stale
    const swapped = ready({ sessions: ['claude:z'], worktrees: [] })
    expect(judgeCheck(first, swapped, T0 + REMIND_EVERY_MS).notice).toMatchObject({ sessions: 1, worktrees: 0 })
  })

  it('opening Cleanup is being shown everything on it, and starts the quiet week over', () => {
    const seen = markShown(EMPTY_REMINDER, ready(), T0)
    expect(judgeCheck(seen, ready(), T0 + DAY).notice).toBeNull()
    const grown = ready({ tables: ['t1'] })
    expect(judgeCheck(seen, grown, T0 + DAY).notice).toBeNull()
    expect(judgeCheck(seen, grown, T0 + REMIND_EVERY_MS).notice).toMatchObject({ tables: 1 })
  })

  it('kinds never collide: a worktree path and a session id that read the same are two things', () => {
    const seen = markShown(EMPTY_REMINDER, ready({ sessions: ['x'], worktrees: [] }), T0)
    const notice = judgeCheck(seen, ready({ sessions: [], worktrees: ['x'] }), T0 + REMIND_EVERY_MS).notice
    expect(notice).toMatchObject({ worktrees: 1 })
  })

  it('a clock set back does not hold reminders off for as long as it jumped', () => {
    const shownInFuture = { ...EMPTY_REMINDER, shownAt: T0 + 365 * DAY }
    expect(judgeCheck(shownInFuture, ready(), T0).notice).not.toBeNull()
  })

  it('a left-behind process is keyed by its command line, which survives the start-time drift', () => {
    // what the scan hands over: `startedAt` is re-derived from etime each time, so it drifts
    const p: OrphanProcess = {
      pid: 4242,
      command: 'node vite --port 5173',
      startedAt: T0,
      cwd: '/w',
      worktreePath: '/w',
      repoName: null,
      branch: null,
      worktreeGone: true
    }
    const seen = markShown(EMPTY_REMINDER, ready({ processes: [processKey(p)] }), T0)
    const drifted: OrphanProcess = { ...p, startedAt: T0 + 1000 }
    expect(judgeCheck(seen, ready({ processes: [processKey(drifted)] }), T0 + REMIND_EVERY_MS).notice).toBeNull()
    // the pid handed to something else is a new process
    const reused = processKey({ pid: 4242, command: 'python -m http.server' })
    expect(judgeCheck(seen, ready({ processes: [reused] }), T0 + REMIND_EVERY_MS).notice).toMatchObject({ processes: 1 })
  })
})

describe('nextCheckAt — daily, after launch settles', () => {
  it('never runs sooner than a short wait after the index is ready', () => {
    expect(nextCheckAt(EMPTY_REMINDER, { readyAt: T0, now: T0 })).toBe(T0 + FIRST_CHECK_DELAY_MS)
  })

  it('a day after the last check, even across restarts', () => {
    const state = { ...EMPTY_REMINDER, checkedAt: T0 }
    expect(nextCheckAt(state, { readyAt: T0 + 60_000, now: T0 + 60_000 })).toBe(T0 + CHECK_EVERY_MS)
  })

  it('a last check stamped in the future (a clock that was ahead) counts as now', () => {
    const state = { ...EMPTY_REMINDER, checkedAt: T0 + 90 * DAY }
    expect(nextCheckAt(state, { readyAt: T0, now: T0 })).toBe(T0 + CHECK_EVERY_MS)
  })
})

describe('sanitizeReminder — the saved file is untrusted', () => {
  it('keeps a well-formed state as it was written', () => {
    const state = markShown({ ...EMPTY_REMINDER, checkedAt: T0 }, ready(), T0)
    expect(sanitizeReminder(JSON.parse(JSON.stringify(state)))).toEqual(state)
  })

  it('forgets whatever is malformed', () => {
    expect(sanitizeReminder('nope')).toEqual(EMPTY_REMINDER)
    expect(sanitizeReminder({ checkedAt: 'yesterday', shownAt: -5, shown: ['s:a', 3, null] })).toEqual({
      checkedAt: 0,
      shownAt: 0,
      shown: ['s:a']
    })
  })
})

describe('noticeFor', () => {
  it('counts every kind and carries the threshold it was judged by', () => {
    const n = noticeFor(ready({ tables: ['t'], processes: ['1 node'], staleDays: 90 }), T0)
    expect(n).toEqual({ at: T0, staleDays: 90, sessions: 2, worktrees: 1, tables: 1, processes: 1, bytes: 3_000_000 })
  })
})
