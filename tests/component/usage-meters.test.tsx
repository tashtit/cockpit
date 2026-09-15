import { describe, it, expect, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { UsageMeters, USAGE_POLL_MS, usageMeter } from '../../src/renderer/src/UsageMeters'
import { initBusySessions } from '../../src/renderer/src/busy'
import type { BusySession, ProviderUsage, UsageSnapshot } from '../../src/shared/types'
import { usageFixture } from './stub-api'

function withProviders(edit: (p: ProviderUsage[]) => ProviderUsage[]): UsageSnapshot {
  const snap = usageFixture()
  return { ...snap, providers: edit(snap.providers) }
}

function codexAt(percent: number): UsageSnapshot {
  return withProviders((ps) =>
    ps.map((p) =>
      p.provider === 'codex'
        ? { ...p, windows: [{ label: '5h window', usedPercent: percent }, { label: 'weekly window', usedPercent: 12 }] }
        : p
    )
  )
}

const cell = (provider: string): HTMLElement | null => document.querySelector(`.usage-cell-${provider}`)
const calls = (): number => vi.mocked(window.cockpit.getUsage).mock.calls.length

describe('footer usage meters', () => {
  it('renders one cell per provider, reading each one its tightest window', async () => {
    vi.mocked(window.cockpit.getUsage).mockResolvedValue(usageFixture())
    render(<UsageMeters onOpen={vi.fn()} />)
    const row = await screen.findByRole('button', { name: /^Subscription usage/ })
    expect(document.querySelectorAll('.usage-cell')).toHaveLength(3)
    // codex reports limits: the 42% window beats the 12% one, and draws a bar
    expect(cell('codex')).toHaveTextContent('42%')
    expect(cell('codex')?.querySelector('.usage-mini-fill')).toHaveStyle({ width: '42%' })
    expect(cell('codex')?.title).toContain('5h window: 42% used · resets in 3h 0m')
    expect(cell('codex')?.title).toContain('weekly window: 12% used')
    // no limit known for claude or copilot: the moving count, no bar
    expect(cell('claude')).toHaveTextContent('1.2M')
    expect(cell('claude')?.querySelector('.usage-mini')).toBeNull()
    expect(cell('claude')?.title).toContain('current 5h block: 1.2M tokens · 42 requests · resets in 2h 0m')
    expect(cell('copilot')).toHaveTextContent('310')
    expect(cell('copilot')?.title).toContain('premium requests this month: 310 used')
    expect(row).toHaveAccessibleName(/Codex 5h window: 42% used/)
    expect(document.querySelector('.usage-warn')).toBeNull()
  })

  it('skips a provider whose usage is unavailable, and disappears when none reports', async () => {
    vi.mocked(window.cockpit.getUsage).mockResolvedValue(
      withProviders((ps) =>
        ps.map((p) =>
          p.provider === 'copilot' ? { ...p, windows: [], unavailable: 'gh CLI is not signed in' } : p
        )
      )
    )
    const { unmount } = render(<UsageMeters onOpen={vi.fn()} />)
    await screen.findByRole('button', { name: /^Subscription usage/ })
    expect(document.querySelectorAll('.usage-cell')).toHaveLength(2)
    expect(cell('copilot')).toBeNull()
    unmount()

    vi.mocked(window.cockpit.getUsage).mockResolvedValue({ at: 0, providers: [] })
    render(<UsageMeters onOpen={vi.fn()} />)
    await waitFor(() => expect(window.cockpit.getUsage).toHaveBeenCalledTimes(2))
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('flags 80% with a glyph and the word, not just a color', async () => {
    vi.mocked(window.cockpit.getUsage).mockResolvedValue(codexAt(80))
    const { unmount } = render(<UsageMeters onOpen={vi.fn()} />)
    const row = await screen.findByRole('button', { name: /^Subscription usage/ })
    expect(cell('codex')).toHaveClass('warn')
    expect(cell('codex')?.querySelector('.usage-warn')).not.toBeNull()
    expect(cell('codex')?.title).toContain('warning: 5h window at 80%')
    expect(row).toHaveAccessibleName(/Codex 5h window: 80% used \(warning\)/)
    unmount()

    vi.mocked(window.cockpit.getUsage).mockResolvedValue(codexAt(79))
    render(<UsageMeters onOpen={vi.fn()} />)
    await screen.findByRole('button', { name: /^Subscription usage/ })
    expect(cell('codex')).not.toHaveClass('warn')
    expect(cell('codex')?.querySelector('.usage-warn')).toBeNull()
  })

  it('flags copilot once premium requests are billed beyond the plan', () => {
    const copilot = usageFixture().providers.find((p) => p.provider === 'copilot')!
    const m = usageMeter({
      ...copilot,
      windows: [{ label: 'premium requests this month', requests: 312, requestsBilled: 12 }]
    })
    expect(m?.warn).toBe(true)
    expect(m?.text).toBe('312')
    expect(m?.title).toContain('312 used · 12 billed beyond plan')
    expect(m?.title).toContain('warning: 12 requests billed beyond the plan')
  })

  it('shows one cell per provider even with two claude homes — the fuller one', () => {
    const claude = usageFixture().providers.find((p) => p.provider === 'claude')!
    expect(usageMeter({ ...claude, windows: [] })).toBeNull()
    expect(usageMeter({ ...claude, unavailable: 'no session logs found' })).toBeNull()
  })

  it('opens Settings when clicked', async () => {
    vi.mocked(window.cockpit.getUsage).mockResolvedValue(usageFixture())
    const onOpen = vi.fn()
    render(<UsageMeters onOpen={onOpen} />)
    await userEvent.click(await screen.findByRole('button', { name: /^Subscription usage/ }))
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('re-measures when the busy set changes', async () => {
    vi.mocked(window.cockpit.getUsage).mockResolvedValue(usageFixture())
    let push: ((s: BusySession[]) => void) | null = null
    vi.mocked(window.cockpit.onBusySessions).mockImplementation((cb) => {
      push = cb
      return () => {}
    })
    const stop = initBusySessions()
    render(<UsageMeters onOpen={vi.fn()} />)
    await screen.findByRole('button', { name: /^Subscription usage/ })
    // the store's seed from main lands after the first paint and counts as a change
    // of its own — let it settle, then measure what each push adds
    await act(async () => {})
    const base = calls()

    // a turn starting is when the numbers begin to move; a turn ending is when they land
    act(() => push!([{ id: 'claude:abc', startedAt: 1 }]))
    await waitFor(() => expect(calls()).toBe(base + 1))
    act(() => push!([]))
    await waitFor(() => expect(calls()).toBe(base + 2))
    stop()
  })

  it('re-measures on the interval', async () => {
    vi.useFakeTimers()
    try {
      vi.mocked(window.cockpit.getUsage).mockResolvedValue(usageFixture())
      render(<UsageMeters onOpen={vi.fn()} />)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      const base = calls()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(USAGE_POLL_MS)
      })
      expect(calls()).toBe(base + 1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(USAGE_POLL_MS)
      })
      expect(calls()).toBe(base + 2)
    } finally {
      vi.useRealTimers()
    }
  })
})
