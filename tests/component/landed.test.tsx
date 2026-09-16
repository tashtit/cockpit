import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, renderHook, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { HomeView } from '../../src/renderer/src/HomeView'
import { initBusySessions } from '../../src/renderer/src/busy'
import { clearLanded, initLanded, useLandedMap } from '../../src/renderer/src/landed'
import type { BusySession, Landing, RepoGroup, SessionMeta } from '../../src/shared/types'

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
    logBranch: 'main',
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

/** Drive main's landings push — main decides what landed (attention-core.ts). */
function pushLandings(landings: Landing[]): void {
  const push = vi.mocked(window.cockpit.onLandings).mock.calls.at(-1)?.[0]
  act(() => push?.(landings))
}

function renderHome(): void {
  render(
    <HomeView
      repos={[repo]}
      indexed
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
  clearLanded()
  vi.mocked(window.cockpit.pageSessions).mockResolvedValue({ total: 2, items: rows })
  vi.mocked(window.cockpit.getBusySessions).mockResolvedValue([])
})

describe('landed sessions', () => {
  it('shows what main says landed — in words, not colour alone', async () => {
    const stop = initLanded()
    renderHome()
    await screen.findByText('fix the login flake')

    pushLandings([{ id: 'claude:one', at: Date.now() - 5000 }])
    await waitFor(() => expect(screen.getByText(/1 landed/)).toBeInTheDocument())
    expect(screen.getByText(/^landed/)).toBeInTheDocument()
    stop()
  })

  it('seeds from main, so landings survive a reload of the window', async () => {
    vi.mocked(window.cockpit.getLandings).mockResolvedValue([{ id: 'claude:two', at: Date.now() }])
    const stop = initLanded()
    const { result } = renderHook(() => useLandedMap())
    await waitFor(() => expect(result.current.has('claude:two')).toBe(true))
    stop()
  })

  it('a push that beats the seed is newer, and the seed must not overwrite it', async () => {
    let resolveSeed: (l: Landing[]) => void = () => {}
    vi.mocked(window.cockpit.getLandings).mockReturnValue(
      new Promise<Landing[]>((r) => {
        resolveSeed = r
      })
    )
    const stop = initLanded()
    const { result } = renderHook(() => useLandedMap())
    pushLandings([])
    await act(async () => resolveSeed([{ id: 'claude:one', at: Date.now() }]))
    expect(result.current.has('claude:one')).toBe(false)
    stop()
  })

  it('clears a landing once main says the session was opened', async () => {
    const stop = initLanded()
    renderHome()
    await screen.findByText('fix the login flake')

    pushLandings([{ id: 'claude:two', at: Date.now() }])
    await waitFor(() => expect(screen.getByText(/1 landed/)).toBeInTheDocument())

    pushLandings([])
    await waitFor(() => expect(screen.getByText('all on the ground')).toBeInTheDocument())
    stop()
  })

  it('a turn leaving the busy set is not a landing by itself — watching it is main\'s call', async () => {
    const stopBusy = initBusySessions()
    const stop = initLanded()
    renderHome()
    await screen.findByText('fix the login flake')

    pushBusy([{ id: 'claude:one', startedAt: Date.now() - 5000, source: 'spawned' }])
    await waitFor(() => expect(screen.getByText(/1 flying/)).toBeInTheDocument())
    pushBusy([])

    await waitFor(() => expect(screen.getByText('all on the ground')).toBeInTheDocument())
    expect(screen.queryByText(/landed/)).not.toBeInTheDocument()
    stop()
    stopBusy()
  })

  it('tidies away the localStorage store the window used to keep', () => {
    window.localStorage.setItem('cockpit:landed', JSON.stringify({ 'claude:one': Date.now() }))
    const stop = initLanded()
    expect(window.localStorage.getItem('cockpit:landed')).toBeNull()
    stop()
  })

  it('the fleet leads the view only while something is flying or landed', async () => {
    const stop = initLanded()
    renderHome()
    await screen.findByText('fix the login flake')
    const quiet = document.querySelector('.home-inner')!
    // quiet: the composer card comes before the board
    const order = [...quiet.children].map((el) => el.className)
    const composerAt = order.findIndex((c) => c.includes('composer-card'))
    const boardAt = order.findIndex((c) => c.includes('board'))
    expect(composerAt).toBeGreaterThanOrEqual(0)
    expect(boardAt).toBeGreaterThan(composerAt)

    pushLandings([{ id: 'claude:one', at: Date.now() }])
    await waitFor(() => {
      const busyOrder = [...document.querySelector('.home-inner')!.children].map((el) => el.className)
      const leadAt = busyOrder.findIndex((c) => c.includes('board'))
      expect(leadAt).toBe(0)
      expect(busyOrder.findIndex((c) => c.includes('composer-card'))).toBeGreaterThan(leadAt)
    })
    stop()
  })
})
