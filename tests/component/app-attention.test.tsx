import { describe, it, expect, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../../src/renderer/src/App'
import type { AttentionTarget, RepoGroup, SessionMeta } from '../../src/shared/types'

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
    id: `claude:${id}`,
    provider: 'claude',
    nativeId: id,
    source: 'claude-default',
    title,
    cwd: '/home/dev/rocket',
    logBranch: 'cockpit/fix-login',
    gitBranch: 'cockpit/fix-login',
    startedAt: 1700000000000,
    updatedAt: 1700000600000,
    messageCount: 4,
    sourcePath: `/home/dev/.claude/projects/p/${id}.jsonl`,
    repo: { key: repo.key, name: repo.name, fullName: repo.fullName, root: repo.root }
  }
}

const homeHero = (): Promise<HTMLElement> =>
  screen.findByRole('heading', { name: /what should we ship/i })

/** Main's notification-click push, as the preload would deliver it. */
function click(target: AttentionTarget): void {
  const push = vi.mocked(window.cockpit.onAttentionOpen).mock.calls.at(-1)?.[0]
  act(() => push?.(target))
}

describe('App attention', () => {
  it('tells main what the window shows — the board, then the session opened from it', async () => {
    vi.mocked(window.cockpit.pageSessions).mockResolvedValue({
      total: 1,
      items: [session('a', 'fix the login flake')]
    })
    render(<App />)
    await homeHero()
    expect(window.cockpit.setAttentionFocus).toHaveBeenLastCalledWith({ kind: 'none' })

    const board = await screen.findByRole('region', { name: 'Session board' })
    await userEvent.click(await within(board).findByRole('button', { name: /fix the login flake/ }))
    await waitFor(() =>
      expect(window.cockpit.setAttentionFocus).toHaveBeenLastCalledWith({
        kind: 'session',
        id: 'claude:a',
        provider: 'claude',
        cwd: '/home/dev/rocket'
      })
    )
  })

  it('a clicked notification opens its session', async () => {
    vi.mocked(window.cockpit.getSession).mockResolvedValue(session('b', 'add pagination'))
    render(<App />)
    await homeHero()

    click({ kind: 'session', id: 'claude:b' })
    await screen.findByRole('textbox', { name: 'Message Claude' })
    expect(window.cockpit.getSession).toHaveBeenCalledWith('claude:b')
    expect(window.cockpit.getSessionMessages).toHaveBeenCalledWith('claude:b')
  })

  it('a session the index no longer has, or a burst of several, lands on the board', async () => {
    vi.mocked(window.cockpit.getSession).mockResolvedValue(null)
    render(<App />)
    await homeHero()
    click({ kind: 'session', id: 'claude:gone' })
    await homeHero()

    // from anywhere else, a summary click goes home too
    await userEvent.keyboard('{Meta>},{/Meta}')
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument()
    click({ kind: 'home' })
    await homeHero()
    expect(screen.queryByRole('heading', { name: 'Settings' })).not.toBeInTheDocument()
  })

  it('a concluded roundtable opens the table', async () => {
    render(<App />)
    await homeHero()
    click({ kind: 'roundtable', id: 'rt-1' })
    await waitFor(() => expect(window.cockpit.getRoundtable).toHaveBeenCalledWith('rt-1'))
    await waitFor(() =>
      expect(window.cockpit.setAttentionFocus).toHaveBeenLastCalledWith({ kind: 'roundtable', id: 'rt-1' })
    )
  })

  it('a click from before this window existed is picked up once it mounts', async () => {
    vi.mocked(window.cockpit.takeAttentionOpen).mockResolvedValue({ kind: 'session', id: 'claude:c' })
    vi.mocked(window.cockpit.getSession).mockResolvedValue(session('c', 'bump deps'))
    render(<App />)
    await screen.findByRole('textbox', { name: 'Message Claude' })
    expect(window.cockpit.getSessionMessages).toHaveBeenCalledWith('claude:c')
  })
})
