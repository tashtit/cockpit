import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CommandPalette } from '../../src/renderer/src/CommandPalette'
import type { RepoGroup, SessionMeta } from '../../src/shared/types'

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

function session(id: string, title: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: `claude:${id}`,
    provider: 'claude',
    nativeId: id,
    source: 'claude-default',
    title,
    cwd: '/home/dev/rocket',
    gitBranch: 'cockpit/fix-login',
    startedAt: 1700000000000,
    updatedAt: 1700000600000,
    messageCount: 4,
    sourcePath: `/home/dev/.claude/projects/p/${id}.jsonl`,
    repo: { key: repo.key, name: repo.name, fullName: repo.fullName, root: repo.root },
    ...over
  }
}

function renderPalette(over: Partial<Parameters<typeof CommandPalette>[0]> = {}) {
  const props = {
    repos: [repo],
    onOpenSession: vi.fn(),
    onNewSession: vi.fn(),
    onGoto: vi.fn(),
    onClose: vi.fn(),
    ...over
  }
  const view = render(<CommandPalette {...props} />)
  return { ...props, unmount: view.unmount }
}

describe('CommandPalette', () => {
  it('opens on recent sessions plus the go-to views, input focused', async () => {
    vi.mocked(window.cockpit.pageSessions).mockResolvedValue({
      total: 2,
      items: [session('a', 'fix the login flake'), session('b', 'add pagination')]
    })
    renderPalette()

    expect(screen.getByRole('combobox')).toHaveFocus()
    await screen.findByRole('option', { name: /fix the login flake/ })
    // recent fetch is unscoped — no search term on an empty query
    expect(window.cockpit.pageSessions).toHaveBeenCalledWith({ limit: 8 })
    // every view is one Enter away
    for (const view of ['Home', 'Agents', 'Profile', 'Settings']) {
      expect(screen.getByRole('option', { name: view })).toBeInTheDocument()
    }
    expect(screen.getByRole('group', { name: 'recent' })).toBeInTheDocument()
  })

  it('arrows move the active option and Enter opens it', async () => {
    const items = [session('a', 'fix the login flake'), session('b', 'add pagination')]
    vi.mocked(window.cockpit.pageSessions).mockResolvedValue({ total: 2, items })
    const { onOpenSession, onClose } = renderPalette()

    const input = screen.getByRole('combobox')
    const first = await screen.findByRole('option', { name: /fix the login flake/ })
    await waitFor(() => expect(first).toHaveAttribute('aria-selected', 'true'))

    await userEvent.keyboard('{ArrowDown}')
    const second = screen.getByRole('option', { name: /add pagination/ })
    expect(second).toHaveAttribute('aria-selected', 'true')
    expect(input).toHaveAttribute('aria-activedescendant', second.id)

    await userEvent.keyboard('{Enter}')
    expect(onOpenSession).toHaveBeenCalledWith(items[1])
    expect(onClose).toHaveBeenCalled()
  })

  it('a query searches sessions server-side and offers repo launches', async () => {
    vi.mocked(window.cockpit.pageSessions)
      .mockResolvedValueOnce({ total: 0, items: [] }) // the initial recent fetch
      .mockResolvedValue({ total: 1, items: [session('a', 'fix the login flake')] })
    const { onNewSession } = renderPalette()

    await userEvent.type(screen.getByRole('combobox'), 'rocket')
    await waitFor(() =>
      expect(window.cockpit.pageSessions).toHaveBeenCalledWith({ search: 'rocket', limit: 6 })
    )
    // repo matched by name from the already-loaded repo list
    const launch = await screen.findByRole('option', { name: 'New session in acme/rocket' })
    await userEvent.click(launch)
    expect(onNewSession).toHaveBeenCalledWith(repo)
  })

  it('view keywords route: "skills" finds the Agents view', async () => {
    vi.mocked(window.cockpit.pageSessions).mockResolvedValue({ total: 0, items: [] })
    const { onGoto } = renderPalette()

    await userEvent.type(screen.getByRole('combobox'), 'skills')
    const agents = await screen.findByRole('option', { name: 'Agents' })
    await userEvent.click(agents)
    expect(onGoto).toHaveBeenCalledWith('extensions')
  })

  it('states the overflow instead of silently capping results', async () => {
    vi.mocked(window.cockpit.pageSessions).mockResolvedValue({
      total: 9,
      items: [session('a', 'fix the login flake')]
    })
    renderPalette()

    await userEvent.type(screen.getByRole('combobox'), 'flake')
    await screen.findByText(/8 more — keep typing to narrow/)
  })

  it('nothing-matches names the query and suggests what to try', async () => {
    vi.mocked(window.cockpit.pageSessions).mockResolvedValue({ total: 0, items: [] })
    renderPalette()

    await userEvent.type(screen.getByRole('combobox'), 'zzz')
    await screen.findByText(/nothing matches “zzz”/)
  })

  it('Escape closes; unmount hands focus back to where it was', async () => {
    vi.mocked(window.cockpit.pageSessions).mockResolvedValue({ total: 0, items: [] })
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()

    const { onClose, unmount } = renderPalette()
    expect(screen.getByRole('combobox')).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalled()

    // App unmounts the palette when onClose fires — simulate that and check focus
    unmount()
    expect(outside).toHaveFocus()
    outside.remove()
  })
})
