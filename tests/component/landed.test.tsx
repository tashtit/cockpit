import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { act } from 'react'
import { HomeView } from '../../src/renderer/src/HomeView'
import { TreeSidebar } from '../../src/renderer/src/TreeSidebar'
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

    pushLandings([{ id: 'claude:one', at: Date.now() - 5000, kind: 'landed' }])
    await waitFor(() => expect(screen.getByText(/1 landed/)).toBeInTheDocument())
    expect(screen.getByText(/^landed/)).toBeInTheDocument()
    stop()
  })

  it('seeds from main, so landings survive a reload of the window', async () => {
    vi.mocked(window.cockpit.getLandings).mockResolvedValue([{ id: 'claude:two', at: Date.now(), kind: 'landed' }])
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
    await act(async () => resolveSeed([{ id: 'claude:one', at: Date.now(), kind: 'landed' }]))
    expect(result.current.has('claude:one')).toBe(false)
    stop()
  })

  it('clears a landing once main says the session was opened', async () => {
    const stop = initLanded()
    renderHome()
    await screen.findByText('fix the login flake')

    pushLandings([{ id: 'claude:two', at: Date.now(), kind: 'landed' }])
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

  it('reads board first, composer docked under it — busy or quiet', async () => {
    const stop = initLanded()
    renderHome()
    await screen.findByText('fix the login flake')
    /** DOCUMENT_POSITION_FOLLOWING: the composer comes after the board in the page. */
    const composerFollowsBoard = (): boolean => {
      const board = document.querySelector('.board')!
      const composer = document.querySelector('.composer-card')!
      return (board.compareDocumentPosition(composer) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
    }
    // the board reads above; the composer is the docked footer, never part of the scroll
    expect(composerFollowsBoard()).toBe(true)
    expect(document.querySelector('.home-stack')!.contains(document.querySelector('.board'))).toBe(true)
    expect(document.querySelector('.home-dock')!.contains(document.querySelector('.composer-card'))).toBe(true)

    // a landing changes the board's rows, never the board's place on the page
    pushLandings([{ id: 'claude:one', at: Date.now(), kind: 'landed' }])
    await waitFor(() => expect(screen.getByText(/1 landed/)).toBeInTheDocument())
    expect(composerFollowsBoard()).toBe(true)
    stop()
  })
})

/* ---------- the two other reasons a session needs you ---------- */

const ASKS: Landing = {
  id: 'claude:one',
  at: Date.now(),
  kind: 'asks',
  asks: { kind: 'question', detail: 'Which owner should the repo live under?' }
}
const RED: Landing = {
  id: 'claude:two',
  at: Date.now(),
  kind: 'pr',
  pr: { number: 57, title: 'Fix login retry flake', url: 'https://github.com/acme/rocket/pull/57', checks: 'failing', review: 'none' }
}

describe('needs you: questions and red pull requests', () => {
  it('an agent waiting on you leads the board, in words, and beats flying', async () => {
    const stopBusy = initBusySessions()
    const stop = initLanded()
    renderHome()
    await screen.findByText('fix the login flake')

    pushBusy([{ id: 'claude:one', startedAt: Date.now() - 5000, source: 'observed' }])
    pushLandings([ASKS])
    await waitFor(() => expect(screen.getByText(/1 waiting on you/)).toBeInTheDocument())
    expect(screen.queryByText(/flying/)).not.toBeInTheDocument()
    const row = screen.getByText('fix the login flake').closest<HTMLElement>('.board-row')!
    expect(row).toHaveClass('asks')
    expect(within(row).getByText('asks you')).toBeInTheDocument()
    expect(row).toHaveAttribute('title', expect.stringContaining('asks you: Which owner should the repo live under?'))
    // the mark is a shape beside the words, not a second announcement
    expect(row.querySelector('.asks-mark')).toHaveAttribute('aria-hidden', 'true')
    expect(row.querySelector('.asks-mark svg')).not.toBeNull()
    // the busy store outlives this test — leave it as the next one expects
    pushBusy([])
    stop()
    stopBusy()
  })

  it('a red PR names its number and reason on the row, and counts as a red PR in the eyebrow', async () => {
    const stop = initLanded()
    renderHome()
    await screen.findByText('add pagination')

    pushLandings([RED, { id: 'claude:one', at: Date.now() - 1000, kind: 'landed' }])
    await waitFor(() => expect(screen.getByText(/1 red PR/)).toBeInTheDocument())
    expect(screen.getByText(/1 landed/)).toBeInTheDocument()
    const row = screen.getByText('add pagination').closest<HTMLElement>('.board-row')!
    expect(row).toHaveClass('fix')
    expect(within(row).getByText('#57 checks failing')).toBeInTheDocument()
    expect(row.querySelector('.fix-mark')).not.toBeNull()
    // the red PR sits above the landing
    const rows = [...document.querySelectorAll('.board-row')].map((r) => r.className)
    expect(rows.findIndex((c) => c.includes('fix'))).toBeLessThan(rows.findIndex((c) => c.includes('landed')))
    stop()
  })

  it('news on a session older than the recent ten still gets its row, fetched by id', async () => {
    const older = session('claude:old', 'rename the config flag')
    vi.mocked(window.cockpit.getSession).mockImplementation(async (id) => (id === older.id ? older : null))
    const stop = initLanded()
    renderHome()
    await screen.findByText('add pagination')

    pushLandings([{ ...RED, id: older.id }])
    const row = (await screen.findByText('rename the config flag')).closest<HTMLElement>('.board-row')!
    expect(row).toHaveClass('fix')
    expect(screen.getByText(/1 red PR/)).toBeInTheDocument()
    expect(window.cockpit.getSession).toHaveBeenCalledWith('claude:old')
    // seen: the row goes with its news rather than joining the ground
    pushLandings([])
    await waitFor(() => expect(screen.queryByText('rename the config flag')).not.toBeInTheDocument())
    stop()
  })

  it('a changes-requested PR says so', async () => {
    const stop = initLanded()
    renderHome()
    await screen.findByText('add pagination')
    pushLandings([{ ...RED, pr: { ...RED.pr, checks: 'passing', review: 'changes_requested' } }])
    await waitFor(() => expect(screen.getByText('#57 changes requested')).toBeInTheDocument())
    stop()
  })

  it('sidebar rows carry the same marks with the reason as their accessible name', async () => {
    const stop = initLanded()
    render(
      <TreeSidebar
        repos={[repo]}
        indexVersion={0}
        accounts={null}
        zoom={1}
        onResetZoom={vi.fn()}
        selectedId={null}
        onSelect={vi.fn()}
        onNewSession={vi.fn()}
        onRepoSetup={vi.fn()}
        selectedRoundtableId={null}
        onOpenRoundtable={vi.fn()}
        onNewTask={vi.fn()}
        onGoHome={vi.fn()}
        onNav={vi.fn()}
        onOpenSettings={vi.fn()}
        onOpenUrl={vi.fn()}
        activeView="welcome"
      />
    )
    await screen.findByText('fix the login flake')
    pushLandings([ASKS, RED])
    const asks = await screen.findByRole('img', { name: 'asks you: Which owner should the repo live under?' })
    expect(asks).toHaveClass('asks-mark', 'plogo-claude')
    const red = await screen.findByRole('img', { name: 'PR #57 checks failing' })
    expect(red).toHaveClass('fix-mark')
    expect(screen.getByText('add pagination').closest('.session-row')).toHaveAttribute(
      'title',
      expect.stringContaining('PR #57 checks failing')
    )
    stop()
  })
})
