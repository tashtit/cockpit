import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, renderHook, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { HomeView } from '../../src/renderer/src/HomeView'
import { initBusySessions } from '../../src/renderer/src/busy'
import { clearLanded, markSeen, noteTurnsEnded, setViewing } from '../../src/renderer/src/landed'
import type { BusySession, RepoGroup, SessionMeta } from '../../src/shared/types'

const repo: RepoGroup = {
  key: '/home/dev/rocket',
  name: 'rocket',
  fullName: 'acme/rocket',
  root: '/home/dev/rocket',
  sessionCount: 2,
  archivedCount: 0,
  lastActivity: 1700000000000,
  providers: ['claude'],
  hidden: false
}

function session(id: string, title: string): SessionMeta {
  return {
    id,
    provider: 'claude',
    nativeId: id.split(':')[1],
    source: 'claude-default',
    title,
    cwd: '/home/dev/rocket',
    gitBranch: 'main',
    startedAt: 1700000000000,
    updatedAt: 1700000000000,
    messageCount: 4,
    sourcePath: `/home/dev/.claude/projects/p/${id.split(':')[1]}.jsonl`,
    repo: { key: repo.key, name: repo.name, fullName: repo.fullName, root: repo.root },
    archived: false
  }
}

const rows = [session('claude:one', 'fix the login flake'), session('claude:two', 'add pagination')]

/** Drive the busy push the way main does: a set, then the set without that id. */
function pushBusy(sessions: BusySession[]): void {
  const push = vi.mocked(window.cockpit.onBusySessions).mock.calls.at(-1)?.[0]
  act(() => push?.(sessions))
}

function renderHome(): void {
  render(
    <HomeView
      repos={[repo]}
      indexVersion={0}
      busy={false}
      onStart={vi.fn().mockResolvedValue(null)}
      onOpenSession={vi.fn()}
      onOpenFull={vi.fn()}
      onNewRoundtable={vi.fn()}
      onOpenRoundtable={vi.fn()}
      onOpenSettings={vi.fn()}
    />
  )
}

beforeEach(() => {
  window.localStorage.clear()
  clearLanded()
  vi.mocked(window.cockpit.pageSessions).mockResolvedValue({ total: 2, items: rows })
  vi.mocked(window.cockpit.getBusySessions).mockResolvedValue([])
})

describe('landed sessions', () => {
  it('marks a session landed when its turn leaves the busy set', async () => {
    const stop = initBusySessions()
    renderHome()
    await screen.findByText('fix the login flake')

    pushBusy([{ id: 'claude:one', startedAt: Date.now() - 5000 }])
    await waitFor(() => expect(screen.getByText(/1 flying/)).toBeInTheDocument())

    pushBusy([])
    await waitFor(() => expect(screen.getByText(/1 landed/)).toBeInTheDocument())
    // the row says so in words, not colour alone
    expect(screen.getByText(/^landed/)).toBeInTheDocument()
    stop()
  })

  it('never lands the session on screen — the user watched it finish', async () => {
    const stop = initBusySessions()
    renderHome()
    await screen.findByText('fix the login flake')
    setViewing('claude:one')

    pushBusy([{ id: 'claude:one', startedAt: Date.now() - 5000 }])
    pushBusy([])

    await waitFor(() => expect(screen.getByText('all on the ground')).toBeInTheDocument())
    expect(screen.queryByText(/landed/)).not.toBeInTheDocument()
    setViewing(null)
    stop()
  })

  it('clears a landing once the session is opened', async () => {
    renderHome()
    await screen.findByText('fix the login flake')

    act(() => noteTurnsEnded(['claude:two']))
    await waitFor(() => expect(screen.getByText(/1 landed/)).toBeInTheDocument())

    act(() => markSeen('claude:two'))
    await waitFor(() => expect(screen.getByText('all on the ground')).toBeInTheDocument())
  })

  it('survives a reload, and forgets landings older than a week', async () => {
    const stale = Date.now() - 8 * 24 * 60 * 60 * 1000
    window.localStorage.setItem(
      'cockpit:landed',
      JSON.stringify({ 'claude:one': Date.now() - 60_000, 'claude:two': stale })
    )
    vi.resetModules()
    const fresh = await import('../../src/renderer/src/landed')
    const { result } = renderHook(() => fresh.useLandedMap())
    expect(result.current.has('claude:one')).toBe(true)
    expect(result.current.has('claude:two')).toBe(false)
  })

  it('shrugs off a corrupt store rather than taking the window down', async () => {
    window.localStorage.setItem('cockpit:landed', 'not json')
    vi.resetModules()
    const fresh = await import('../../src/renderer/src/landed')
    const { result } = renderHook(() => fresh.useLandedMap())
    expect(result.current.size).toBe(0)
  })

  it('the fleet leads the view only while something is flying or landed', async () => {
    renderHome()
    await screen.findByText('fix the login flake')
    const quiet = document.querySelector('.home-inner')!
    // quiet: the composer card comes before the board
    const order = [...quiet.children].map((el) => el.className)
    const composerAt = order.findIndex((c) => c.includes('composer-card'))
    const boardAt = order.findIndex((c) => c.includes('board'))
    expect(composerAt).toBeGreaterThanOrEqual(0)
    expect(boardAt).toBeGreaterThan(composerAt)

    act(() => noteTurnsEnded(['claude:one']))
    await waitFor(() => {
      const busyOrder = [...document.querySelector('.home-inner')!.children].map((el) => el.className)
      const leadAt = busyOrder.findIndex((c) => c.includes('board'))
      expect(leadAt).toBe(0)
      expect(busyOrder.findIndex((c) => c.includes('composer-card'))).toBeGreaterThan(leadAt)
    })
  })
})
