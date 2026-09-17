import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, renderHook, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { act } from 'react'
import { HomeView } from '../../src/renderer/src/HomeView'
import { initBusySessions } from '../../src/renderer/src/busy'
import {
  clearAttention,
  initAttention,
  useAttentionItems,
  useLandedMap,
  useSessionAttention
} from '../../src/renderer/src/attention'
import type { AttentionItem, BusySession, RepoGroup, SessionMeta } from '../../src/shared/types'
import { openPr } from './stub-api'

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

/** A session item as main pushes it — the index's row, snapshotted. */
function sessionItem(
  id: string,
  reason: 'landed' | 'failed' | 'question' | 'permission',
  over: Partial<Extract<AttentionItem, { kind: 'session' }>> = {}
): AttentionItem {
  return {
    kind: 'session',
    key: id,
    id,
    provider: 'claude',
    reason,
    title: rows.find((r) => r.id === id)?.title ?? 'a session the board does not list',
    branch: 'cockpit/login-flake',
    repo: 'rocket',
    detail: '',
    at: Date.now() - 5000,
    ...over
  }
}

/** Drive the busy push the way main does: a set, then the set without that id. */
function pushBusy(sessions: BusySession[]): void {
  const push = vi.mocked(window.cockpit.onBusySessions).mock.calls.at(-1)?.[0]
  act(() => push?.(sessions))
}

/** Drive main's attention push — main decides what needs you (attention-core.ts). */
function pushAttention(items: AttentionItem[]): void {
  const push = vi.mocked(window.cockpit.onAttention).mock.calls.at(-1)?.[0]
  act(() => push?.(items))
}

function renderHome(over: Partial<Parameters<typeof HomeView>[0]> = {}): Parameters<typeof HomeView>[0] {
  const props = {
    repos: [repo],
    indexed: true,
    indexVersion: 0,
    busy: false,
    onStart: vi.fn().mockResolvedValue(null),
    onOpenSession: vi.fn(),
    onOpenFull: vi.fn(),
    onNewRoundtable: vi.fn(),
    onOpenRoundtable: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenUrl: vi.fn(),
    ...over
  }
  render(<HomeView {...props} />)
  return props
}

const needsYou = (): HTMLElement => screen.getByRole('list', { name: 'Needs you' })

beforeEach(() => {
  clearAttention()
  vi.mocked(window.cockpit.pageSessions).mockResolvedValue({ total: 2, items: rows })
  vi.mocked(window.cockpit.getBusySessions).mockResolvedValue([])
})

describe('the attention store', () => {
  it('seeds from main, so the list survives a reload of the window', async () => {
    vi.mocked(window.cockpit.getAttention).mockResolvedValue([sessionItem('claude:two', 'landed')])
    const stop = initAttention()
    const { result } = renderHook(() => useAttentionItems())
    await waitFor(() => expect(result.current.map((i) => i.key)).toEqual(['claude:two']))
    stop()
  })

  it('a push that beats the seed is newer, and the seed must not overwrite it', async () => {
    let resolveSeed: (l: AttentionItem[]) => void = () => {}
    vi.mocked(window.cockpit.getAttention).mockReturnValue(
      new Promise<AttentionItem[]>((r) => {
        resolveSeed = r
      })
    )
    const stop = initAttention()
    const { result } = renderHook(() => useAttentionItems())
    pushAttention([])
    await act(async () => resolveSeed([sessionItem('claude:one', 'landed')]))
    expect(result.current).toEqual([])
    stop()
  })

  it('answers per session for the rows, and keeps the palette\'s landed map', () => {
    const stop = initAttention()
    const item = sessionItem('claude:one', 'question', { detail: 'Which owner?' })
    const one = renderHook(() => useSessionAttention('claude:one'))
    const two = renderHook(() => useSessionAttention('claude:two'))
    const map = renderHook(() => useLandedMap())
    pushAttention([item, openPrItem()])
    expect(one.result.current).toEqual(item)
    expect(two.result.current).toBeNull()
    expect([...map.result.current.keys()]).toEqual(['claude:one'])
    stop()
  })

  it('tidies away the localStorage store the window used to keep', () => {
    window.localStorage.setItem('cockpit:landed', JSON.stringify({ 'claude:one': Date.now() }))
    const stop = initAttention()
    expect(window.localStorage.getItem('cockpit:landed')).toBeNull()
    stop()
  })
})

function openPrItem(over: Partial<Extract<AttentionItem, { kind: 'pr' }>> = {}): AttentionItem {
  return {
    kind: 'pr',
    key: 'pr:https://github.com/acme/rocket/pull/42',
    pr: openPr({ checks: 'failing' }),
    repoRoot: repo.root as string,
    repo: 'rocket',
    sessionId: 'claude:one',
    provider: 'claude',
    reason: 'checks',
    at: Date.now() - 60_000,
    ...over
  }
}

describe('the board\'s "Needs you" group', () => {
  it('shows what main says landed — in words, not colour alone — and counts it in the eyebrow', async () => {
    const stop = initAttention()
    renderHome()
    await screen.findByText('fix the login flake')

    pushAttention([sessionItem('claude:one', 'landed')])
    await waitFor(() => expect(screen.getByText(/1 needs you/)).toBeInTheDocument())
    const row = within(needsYou()).getByRole('button', { name: /fix the login flake/ })
    expect(row).toHaveTextContent(/landed \d/)
    expect(row.className).toContain('landed')
    // the same session is not also on the ground
    expect(screen.getAllByRole('button', { name: /fix the login flake/ })).toHaveLength(1)
    stop()
  })

  it('a question, an approval and a failure each say what they are, with the agent\'s words alongside', async () => {
    const stop = initAttention()
    renderHome()
    await screen.findByText('fix the login flake')
    pushAttention([
      sessionItem('claude:one', 'question', { detail: 'Which owner should the repo live under?' }),
      sessionItem('claude:two', 'permission', { detail: 'rm -rf dist && npm run build', provider: 'codex' }),
      sessionItem('copilot:three', 'failed', { detail: 'Failed to get response from the AI model', provider: 'copilot' })
    ])
    await waitFor(() => expect(screen.getByText(/3 need you/)).toBeInTheDocument())
    const group = needsYou()
    const asking = within(group).getByRole('button', { name: /fix the login flake/ })
    expect(within(asking).getByRole('img', { name: 'asking a question — needs you' })).toBeInTheDocument()
    expect(asking).toHaveTextContent('Which owner should the repo live under?')
    expect(asking).toHaveTextContent(/asking$/)
    const approval = within(group).getByRole('button', { name: /add pagination/ })
    expect(within(approval).getByRole('img', { name: 'waiting for approval — needs you' })).toBeInTheDocument()
    expect(approval).toHaveTextContent(/needs approval$/)
    // a session outside the ten recent rows is on the board all the same
    const failed = within(group).getByRole('button', { name: /a session the board does not list/ })
    expect(within(failed).getByRole('img', { name: 'failed — needs you' })).toBeInTheDocument()
    expect(failed).toHaveTextContent(/failed \d/)
    stop()
  })

  it('a red PR names the branch and its verdict; clicking opens the session on that branch, or the PR itself', async () => {
    const stop = initAttention()
    vi.mocked(window.cockpit.getSession).mockResolvedValue(rows[0])
    const { onOpenSession, onOpenUrl } = renderHome()
    await screen.findByText('fix the login flake')
    pushAttention([
      openPrItem(),
      openPrItem({
        key: 'pr:https://github.com/acme/rocket/pull/43',
        pr: openPr({ number: 43, title: 'Dark mode tokens', url: 'https://github.com/acme/rocket/pull/43', checks: 'none', review: 'changes_requested' }),
        sessionId: null,
        provider: null,
        reason: 'review'
      })
    ])
    await waitFor(() => expect(screen.getByText(/2 need you/)).toBeInTheDocument())
    const group = needsYou()
    const checks = within(group).getByRole('button', { name: /Fix the login flake/ })
    expect(within(checks).getByRole('img', { name: 'checks failing — needs you' })).toBeInTheDocument()
    expect(checks).toHaveTextContent('pull request #42')
    // the branch chip abbreviates the worktree prefix; the full name is in its tooltip
    expect(checks).toHaveTextContent('c/login-flake')
    expect(checks).toHaveTextContent(/checks failing$/)
    await userEvent.click(checks)
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith(rows[0]))
    expect(window.cockpit.getSession).toHaveBeenCalledWith('claude:one')

    const review = within(group).getByRole('button', { name: /Dark mode tokens/ })
    expect(review).toHaveTextContent(/changes requested$/)
    await userEvent.click(review)
    expect(onOpenUrl).toHaveBeenCalledWith('https://github.com/acme/rocket/pull/43')
    expect(onOpenSession).toHaveBeenCalledTimes(1)
    stop()
  })

  it('clears a row once main says it was looked at, and the group with it', async () => {
    const stop = initAttention()
    renderHome()
    await screen.findByText('fix the login flake')

    pushAttention([sessionItem('claude:two', 'landed')])
    await waitFor(() => expect(screen.getByText(/1 needs you/)).toBeInTheDocument())

    pushAttention([])
    await waitFor(() => expect(screen.getByText('all on the ground')).toBeInTheDocument())
    expect(screen.queryByRole('list', { name: 'Needs you' })).not.toBeInTheDocument()
    stop()
  })

  it('a turn leaving the busy set is not a landing by itself — watching it is main\'s call', async () => {
    const stopBusy = initBusySessions()
    const stop = initAttention()
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

  it('a session waiting on you stays in the group even while its turn is live', async () => {
    const stopBusy = initBusySessions()
    const stop = initAttention()
    renderHome()
    await screen.findByText('fix the login flake')
    pushBusy([{ id: 'claude:one', startedAt: Date.now() - 5000, source: 'observed' }])
    pushAttention([sessionItem('claude:one', 'permission', { detail: 'git push' })])
    await waitFor(() => expect(screen.getByText(/1 needs you/)).toBeInTheDocument())
    expect(screen.queryByText(/flying/)).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /fix the login flake/ })).toHaveLength(1)
    // the busy store outlives the test — leave it as empty as it was found
    pushBusy([])
    stop()
    stopBusy()
  })

  it('the fleet leads the view only while something is flying or needs you', async () => {
    const stop = initAttention()
    renderHome()
    await screen.findByText('fix the login flake')
    const quiet = document.querySelector('.home-inner')!
    // quiet: the composer card comes before the board
    const order = [...quiet.children].map((el) => el.className)
    const composerAt = order.findIndex((c) => c.includes('composer-card'))
    const boardAt = order.findIndex((c) => c.includes('board'))
    expect(composerAt).toBeGreaterThanOrEqual(0)
    expect(boardAt).toBeGreaterThan(composerAt)

    pushAttention([sessionItem('claude:one', 'landed')])
    await waitFor(() => {
      const busyOrder = [...document.querySelector('.home-inner')!.children].map((el) => el.className)
      const leadAt = busyOrder.findIndex((c) => c.includes('board'))
      expect(leadAt).toBe(0)
      expect(busyOrder.findIndex((c) => c.includes('composer-card'))).toBeGreaterThan(leadAt)
    })
    stop()
  })
})
