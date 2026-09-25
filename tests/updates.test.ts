import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CheckGate } from '../src/main/updates'

/*
 * UpdateManager itself needs a running Electron (`app.isPackaged` decides at
 * construction whether it is wired at all), so what is tested here is the gate its
 * checks run through: the deadline, and which answers still count.
 */

/** A check that answers — or fails — only when told to. */
function pending(): {
  readonly check: () => Promise<void>
  readonly answer: () => void
  readonly fail: (err: Error) => void
} {
  let answer = (): void => {}
  let fail = (_err: Error): void => {}
  const promise = new Promise<void>((resolve, reject) => {
    answer = () => resolve()
    fail = reject
  })
  return { check: () => promise, answer: () => answer(), fail: (err) => fail(err) }
}

describe('CheckGate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is open while a check waits, and closes once it answers', async () => {
    const gate = new CheckGate(60_000)
    const c = pending()
    let timeouts = 0
    const run = gate.run(c.check, () => timeouts++)
    expect(gate.open).toBe(true)
    c.answer()
    await run
    expect(gate.open).toBe(false)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(timeouts).toBe(0)
  })

  it('gives up on a check that never answers, and stays closed to what it brings later', async () => {
    const gate = new CheckGate(60_000)
    const c = pending()
    let timeouts = 0
    const run = gate.run(c.check, () => timeouts++)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(timeouts).toBe(0)
    expect(gate.open).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    await run
    expect(timeouts).toBe(1)
    expect(gate.open).toBe(false)

    c.answer()
    await vi.advanceTimersByTimeAsync(0)
    expect(gate.open).toBe(false)
    expect(timeouts).toBe(1)
  })

  it('opens for the next check after one was given up on, and a late answer does not close it', async () => {
    const gate = new CheckGate(60_000)
    const stalled = pending()
    const first = gate.run(stalled.check, () => {})
    await vi.advanceTimersByTimeAsync(60_000)
    await first

    const next = pending()
    const second = gate.run(next.check, () => {})
    expect(gate.open).toBe(true)
    stalled.answer()
    await vi.advanceTimersByTimeAsync(0)
    expect(gate.open).toBe(true)
    next.answer()
    await second
    expect(gate.open).toBe(false)
  })

  it('leaves a failure inside the deadline to the caller, and swallows one after it', async () => {
    const gate = new CheckGate(60_000)
    const c = pending()
    const run = gate.run(c.check, () => {})
    c.fail(new Error('offline'))
    await expect(run).rejects.toThrow('offline')
    expect(gate.open).toBe(false)

    // an unhandled rejection would fail the run: a late failure must go nowhere
    const late = pending()
    const given = gate.run(late.check, () => {})
    await vi.advanceTimersByTimeAsync(60_000)
    await given
    late.fail(new Error('too late'))
    await vi.advanceTimersByTimeAsync(0)
    expect(gate.open).toBe(false)
  })
})
