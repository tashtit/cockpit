import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Settings } from '../../src/renderer/src/Settings'
import { HomeView } from '../../src/renderer/src/HomeView'
import { fmtElapsed, fmtTime, initTimeFormat, setTimeFormat } from '../../src/renderer/src/time'
import type { RepoGroup, SessionMeta } from '../../src/shared/types'

/** Today at 14:05 local — always "today" whatever the wall clock says. */
function todayAt1405(): number {
  const d = new Date()
  d.setHours(14, 5, 0, 0)
  return d.getTime()
}

beforeEach(() => {
  // the store is module state — put the default back so tests stay independent
  setTimeFormat('24h')
})

describe('fmtTime', () => {
  it('renders today in a 24-hour clock by default', () => {
    const s = fmtTime(todayAt1405(), '24h')
    expect(s).toContain('14')
    expect(s).toContain('05')
  })

  it('renders today as a 12-hour clock when asked', () => {
    const s = fmtTime(todayAt1405(), '12h')
    expect(s).not.toContain('14')
    expect(s).toContain('2')
    expect(s).toContain('05')
  })

  it('renders older sessions as a date in either format', () => {
    const lastWeek = todayAt1405() - 7 * 86_400_000
    const date = new Date(lastWeek).toLocaleDateString([], { month: 'short', day: 'numeric' })
    expect(fmtTime(lastWeek, '24h')).toBe(date)
    expect(fmtTime(lastWeek, '12h')).toBe(date)
  })
})

describe('fmtElapsed', () => {
  it('steps from seconds to minutes to hours with padded remainders', () => {
    expect(fmtElapsed(41_000)).toBe('41s')
    expect(fmtElapsed(134_000)).toBe('2m 14s')
    expect(fmtElapsed(3_780_000)).toBe('1h 03m')
  })
  it('clamps negative clock skew to zero', () => {
    expect(fmtElapsed(-5_000)).toBe('0s')
  })
})

describe('Settings time format', () => {
  it('persists a change and reflects it in the select', async () => {
    render(<Settings onClose={vi.fn()} />)

    const trigger = await screen.findByRole('button', { name: 'Time format' })
    expect(trigger).toHaveTextContent('24-hour')

    await userEvent.click(trigger)
    await userEvent.click(await screen.findByRole('option', { name: /12-hour/ }))

    expect(window.cockpit.setTimeFormat).toHaveBeenCalledWith('12h')
    expect(screen.getByRole('button', { name: 'Time format' })).toHaveTextContent('12-hour')
    expect(screen.getByRole('status')).toHaveTextContent('12-hour format')
  })

  it('initTimeFormat adopts the persisted value from the main process', async () => {
    vi.mocked(window.cockpit.getTimeFormat).mockResolvedValue('12h')
    await act(() => initTimeFormat())

    render(<Settings onClose={vi.fn()} />)
    expect(await screen.findByRole('button', { name: 'Time format' })).toHaveTextContent('12-hour')
  })
})

describe('session rows follow the time format live', () => {
  it('re-renders HomeView recent times when the format changes', async () => {
    const repo: RepoGroup = {
      key: '/home/dev/cachely',
      name: 'cachely',
      fullName: 'dev/cachely',
      root: '/home/dev/cachely',
      sessionCount: 1,
      archivedCount: 0,
      lastActivity: todayAt1405(),
      providers: ['claude'],
      hidden: false
    }
    const session: SessionMeta = {
      id: 'claude:abc',
      provider: 'claude',
      nativeId: 'abc',
      source: '/home/dev/.claude',
      title: 'Fix the flaky indexer test',
      cwd: repo.root,
      gitBranch: null,
      startedAt: todayAt1405(),
      updatedAt: todayAt1405(),
      messageCount: 3,
      sourcePath: '/home/dev/.claude/projects/x/abc.jsonl',
      repo: { key: repo.key, name: repo.name, fullName: repo.fullName, root: repo.root }
    }
    vi.mocked(window.cockpit.pageSessions).mockResolvedValue({ total: 1, items: [session] })
    render(
      <HomeView
        repos={[repo]}
        indexVersion={0}
        busy={false}
        onStart={vi.fn().mockResolvedValue(null)}
        onOpenSession={vi.fn()}
      />
    )

    const row = await screen.findByRole('button', { name: /Fix the flaky indexer test/ })
    expect(row.querySelector('time')?.textContent).toContain('14')

    act(() => setTimeFormat('12h'))
    expect(row.querySelector('time')?.textContent).not.toContain('14')
  })
})
