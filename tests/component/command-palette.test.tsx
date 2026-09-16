import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { CommandPalette } from '../../src/renderer/src/CommandPalette'
import type { RepoGroup, SessionMeta, TranscriptSearchResult } from '../../src/shared/types'

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
    logBranch: 'cockpit/fix-login',
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
    scopeRepo: null,
    onOpenSession: vi.fn(),
    onNewSession: vi.fn(),
    onRepoSetup: vi.fn(),
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

  describe('in transcripts', () => {
    const hit = (over: Partial<TranscriptSearchResult> = {}): TranscriptSearchResult => ({
      query: 'flake',
      hits: [
        {
          sessionId: 'claude:a',
          role: 'assistant',
          snippet: '…the login flake comes from a slow first DNS lookup…',
          matchStart: 11,
          matchEnd: 16,
          timestamp: 1700000300000
        }
      ],
      sessions: [session('a', 'fix the login flake')],
      candidates: 12,
      scanned: 12,
      truncated: 0,
      stoppedBy: 'complete',
      elapsedMs: 40,
      ...over
    })

    it('a query offers the transcript search under the session hits, scoped to the window\'s repo', async () => {
      vi.mocked(window.cockpit.pageSessions).mockResolvedValue({ total: 0, items: [] })
      vi.mocked(window.cockpit.searchTranscripts).mockResolvedValue(hit())
      const { onOpenSession, onClose } = renderPalette({ scopeRepo: repo })

      const input = screen.getByRole('combobox')
      await userEvent.type(input, 'flake')
      const door = await screen.findByRole('option', {
        name: 'Search transcripts for “flake” in acme/rocket'
      })
      // nothing was scanned just by typing — the door has to be picked
      expect(window.cockpit.searchTranscripts).not.toHaveBeenCalled()
      await userEvent.click(door)

      await waitFor(() =>
        expect(window.cockpit.searchTranscripts).toHaveBeenCalledWith({
          text: 'flake',
          repoKey: repo.key,
          limit: 30
        })
      )
      // the mode shows on the input row and the query survives the switch
      expect(screen.getByRole('button', { name: /Searching transcripts/ })).toBeInTheDocument()
      expect(input).toHaveValue('flake')
      expect(input).toHaveFocus()
      const row = await screen.findByRole('option', { name: /fix the login flake — agent:/ })
      // the match is marked inside the snippet
      expect(row.querySelector('mark')).toHaveTextContent('flake')
      expect(screen.getByText(/1 hit in 1 session · searched 12 of 12 transcripts/)).toBeInTheDocument()
      expect(onClose).not.toHaveBeenCalled()

      await userEvent.click(row)
      expect(onOpenSession).toHaveBeenCalledWith(hit().sessions[0])
      expect(onClose).toHaveBeenCalled()
    })

    it('Enter on the door row switches modes; the scope row widens to every repo', async () => {
      vi.mocked(window.cockpit.pageSessions).mockResolvedValue({ total: 0, items: [] })
      vi.mocked(window.cockpit.searchTranscripts).mockResolvedValue(hit({ hits: [], sessions: [] }))
      renderPalette({ scopeRepo: repo })

      await userEvent.type(screen.getByRole('combobox'), 'flake')
      await screen.findByRole('option', { name: /Search transcripts for/ })
      // no session hits, so the door is the top row — Enter takes it
      await userEvent.keyboard('{Enter}')
      await waitFor(() =>
        expect(window.cockpit.searchTranscripts).toHaveBeenLastCalledWith(
          expect.objectContaining({ repoKey: repo.key })
        )
      )
      await screen.findByText(/nothing in acme\/rocket transcripts mentions “flake” · try all repos/)

      await userEvent.click(screen.getByRole('option', { name: 'Search all repos' }))
      await waitFor(() =>
        expect(window.cockpit.searchTranscripts).toHaveBeenLastCalledWith({
          text: 'flake',
          repoKey: undefined,
          limit: 30
        })
      )
      // and back again
      expect(screen.getByRole('option', { name: 'Search only acme/rocket' })).toBeInTheDocument()
    })

    it('with no repo on screen the search is global and offers no scope row', async () => {
      vi.mocked(window.cockpit.pageSessions).mockResolvedValue({ total: 0, items: [] })
      vi.mocked(window.cockpit.searchTranscripts).mockResolvedValue(hit())
      renderPalette({ scopeRepo: null })

      await userEvent.type(screen.getByRole('combobox'), 'flake')
      await userEvent.click(
        await screen.findByRole('option', { name: 'Search transcripts for “flake” in all repos' })
      )
      await waitFor(() =>
        expect(window.cockpit.searchTranscripts).toHaveBeenCalledWith({
          text: 'flake',
          repoKey: undefined,
          limit: 30
        })
      )
      await screen.findByRole('option', { name: /fix the login flake — agent:/ })
      expect(screen.queryByRole('option', { name: /Search all repos|Search only/ })).toBeNull()
    })

    it('says when a search stopped short, and reads on partial transcripts', async () => {
      vi.mocked(window.cockpit.pageSessions).mockResolvedValue({ total: 0, items: [] })
      vi.mocked(window.cockpit.searchTranscripts).mockResolvedValue(
        hit({ candidates: 2431, scanned: 1204, truncated: 3, stoppedBy: 'time' })
      )
      renderPalette({ scopeRepo: null })

      await userEvent.type(screen.getByRole('combobox'), 'flake')
      await userEvent.click(await screen.findByRole('option', { name: /Search transcripts for/ }))
      await screen.findByText(
        /searched 1204 of 2431 transcripts · ran out of time — narrow the query or the scope · 3 large transcripts read only in part/
      )
    })

    it('Backspace on an empty query leaves transcripts mode and cancels the scan', async () => {
      vi.mocked(window.cockpit.pageSessions).mockResolvedValue({ total: 0, items: [] })
      vi.mocked(window.cockpit.searchTranscripts).mockResolvedValue(hit())
      renderPalette({ scopeRepo: repo })

      const input = screen.getByRole('combobox')
      await userEvent.type(input, 'flake')
      await userEvent.click(await screen.findByRole('option', { name: /Search transcripts for/ }))
      await screen.findByRole('option', { name: /fix the login flake — agent:/ })

      await userEvent.clear(input)
      await userEvent.keyboard('{Backspace}')
      expect(screen.queryByRole('button', { name: /Searching transcripts/ })).toBeNull()
      // the in-flight scan is told to stop when the mode is left
      expect(window.cockpit.cancelTranscriptSearch).toHaveBeenCalled()
      // jump mode again: recent sessions and the views
      await screen.findByRole('option', { name: 'Settings' })
      expect(input).toHaveFocus()
    })

    it('Escape still closes the whole palette from transcripts mode', async () => {
      vi.mocked(window.cockpit.pageSessions).mockResolvedValue({ total: 0, items: [] })
      vi.mocked(window.cockpit.searchTranscripts).mockResolvedValue(hit())
      const { onClose } = renderPalette({ scopeRepo: repo })

      await userEvent.type(screen.getByRole('combobox'), 'flake')
      await userEvent.click(await screen.findByRole('option', { name: /Search transcripts for/ }))
      await userEvent.keyboard('{Escape}')
      expect(onClose).toHaveBeenCalled()
    })
  })
})
