import { describe, it, expect, afterAll, afterEach, beforeEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CleanupReminder } from '../src/main/cleanup-reminder'
import {
  CHECK_EVERY_MS,
  FIRST_CHECK_DELAY_MS,
  REMIND_EVERY_MS,
  TICK_MS,
  type CleanupReady
} from '../src/main/cleanup-reminder-core'
import type { CleanupNotice } from '../src/shared/types'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

const T0 = new Date('2026-09-25T09:00:00Z').getTime()

const READY: CleanupReady = {
  staleDays: 30,
  sessions: ['claude:old'],
  worktrees: [],
  tables: [],
  processes: [],
  bytes: 5_000_000
}

/** A reminder over a scan the test answers, recording what it was asked to say. */
function makeReminder(
  file: string,
  opts: { enabled?: () => boolean; survey?: () => Promise<CleanupReady> } = {}
): { reminder: CleanupReminder; surveys: { count: number }; reminded: CleanupNotice[] } {
  const surveys = { count: 0 }
  const reminded: CleanupNotice[] = []
  const reminder = new CleanupReminder({
    file,
    survey: async () => {
      surveys.count++
      return opts.survey ? opts.survey() : READY
    },
    enabled: opts.enabled ?? (() => true),
    remind: (n) => reminded.push(n)
  })
  return { reminder, surveys, reminded }
}

let file: string

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  const dir = mkdtempSync(join(tmpdir(), 'cockpit-cleanup-reminder-'))
  dirs.push(dir)
  file = join(dir, 'cleanup-reminder.json')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('CleanupReminder', () => {
  it('waits for launch to settle, then checks, reminds, and remembers it did', async () => {
    const { reminder, surveys, reminded } = makeReminder(file)
    reminder.start()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS - 1000)
    expect(surveys.count).toBe(0)

    await vi.advanceTimersByTimeAsync(1000)
    expect(surveys.count).toBe(1)
    expect(reminded).toEqual([expect.objectContaining({ sessions: 1, bytes: 5_000_000 })])
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      checkedAt: T0 + FIRST_CHECK_DELAY_MS,
      shown: ['s:claude:old']
    })

    // the next check is a day later, and what was shown is not said twice
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS)
    expect(surveys.count).toBe(2)
    expect(reminded).toHaveLength(1)
    reminder.dispose()
  })

  it('switched off, it never scans; switched on, the timer comes back', async () => {
    let on = false
    const { reminder, surveys } = makeReminder(file, { enabled: () => on })
    reminder.start()
    await vi.advanceTimersByTimeAsync(2 * CHECK_EVERY_MS)
    expect(surveys.count).toBe(0)

    on = true
    reminder.reschedule()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS)
    expect(surveys.count).toBe(1)
    reminder.dispose()
  })

  it('a restart does not re-check what was checked today', async () => {
    const first = makeReminder(file)
    first.reminder.start()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS)
    first.reminder.dispose()

    const second = makeReminder(file)
    second.reminder.start()
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS - 60_000)
    expect(second.surveys.count).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(second.surveys.count).toBe(1)
    second.reminder.dispose()
  })

  it('a Mac that slept through the day still checks within the hour it wakes', async () => {
    const { reminder, surveys } = makeReminder(file)
    reminder.start()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS)
    expect(surveys.count).toBe(1)

    // the wall clock moved two days while no timer ran
    vi.setSystemTime(Date.now() + 2 * CHECK_EVERY_MS)
    await vi.advanceTimersByTimeAsync(TICK_MS)
    expect(surveys.count).toBe(2)
    reminder.dispose()
  })

  it('what the Cleanup view showed is not news to the next reminder', async () => {
    const { reminder, reminded } = makeReminder(file)
    reminder.seen(READY)
    vi.setSystemTime(T0 + REMIND_EVERY_MS)
    await reminder.check()
    expect(reminded).toEqual([])
  })

  it('a scan that throws is logged and retried tomorrow, not on every tick', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { reminder, surveys, reminded } = makeReminder(file, {
      survey: () => Promise.reject(new Error('lsof missing'))
    })
    reminder.start()
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_DELAY_MS + 3 * TICK_MS)
    expect(surveys.count).toBe(1)
    expect(reminded).toEqual([])
    expect(error).toHaveBeenCalledWith('[cleanup] reminder check failed:', expect.any(Error))
    error.mockRestore()
    reminder.dispose()
  })

  it('a hand-mangled file is a fresh start, not a crash', async () => {
    writeFileSync(file, '{"shown": ')
    const { reminder, reminded } = makeReminder(file)
    await reminder.check()
    expect(reminded).toHaveLength(1)
  })
})
