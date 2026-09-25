import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render } from '@testing-library/react'
import type { JSX } from 'react'
import { useWatchUntil } from '../../src/renderer/src/SignInFix'

function Watcher({ active, check }: { active: boolean; check: () => void }): JSX.Element {
  useWatchUntil(active, check, { everyMs: 1_000, forMs: 5_000 })
  return <span />
}

/** Watching for something finished in Terminal: a sign-in, an update. */
describe('useWatchUntil', () => {
  it('asks every tick and on focus while it watches', () => {
    vi.useFakeTimers()
    try {
      const check = vi.fn()
      render(<Watcher active check={check} />)
      act(() => vi.advanceTimersByTime(3_000))
      expect(check).toHaveBeenCalledTimes(3)
      fireEvent.focus(window)
      expect(check).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops for good once it gives up — no timer left ticking, no listener left', () => {
    vi.useFakeTimers()
    try {
      const check = vi.fn()
      render(<Watcher active check={check} />)
      act(() => vi.advanceTimersByTime(6_000))
      expect(check).toHaveBeenCalledTimes(5)
      expect(vi.getTimerCount()).toBe(0)
      act(() => vi.advanceTimersByTime(60_000))
      fireEvent.focus(window)
      expect(check).toHaveBeenCalledTimes(5)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does nothing while inactive', () => {
    vi.useFakeTimers()
    try {
      const check = vi.fn()
      render(<Watcher active={false} check={check} />)
      act(() => vi.advanceTimersByTime(3_000))
      expect(check).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
