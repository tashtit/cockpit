import { describe, it, expect, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HomeView } from '../../src/renderer/src/HomeView'
import type { AccountsSnapshot, Landing, RepoGroup, RoundtableMeta, SessionMeta } from '../../src/shared/types'
import { pasteImage, stubObjectUrls } from './paste'
import { clearLanded, initLanded } from '../../src/renderer/src/landed'

const repo: RepoGroup = {
  key: '/home/dev/cachely',
  name: 'cachely',
  fullName: 'dev/cachely',
  root: '/home/dev/cachely',
  sessionCount: 2,
  archivedCount: 0,
  lastActivity: 1700000000000,
  providers: ['claude'],
  hidden: false
}

const claudeSnapshot: AccountsSnapshot = {
  accounts: [
    {
      provider: 'claude',
      path: '/home/dev/.claude',
      label: 'claude-default',
      identity: 'dev@example.com',
      isDefault: true
    }
  ],
  githubUser: 'dev'
}

function renderHome(over: Partial<Parameters<typeof HomeView>[0]> = {}) {
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
    ...over
  }
  render(<HomeView {...props} />)
  return props
}

describe('HomeView composer', () => {
  it('starts the task with the selected repo, agent, mode, and account', async () => {
    vi.mocked(window.cockpit.getAccounts).mockResolvedValue(claudeSnapshot)
    const { onStart } = renderHome()

    const start = await screen.findByRole('button', { name: 'Start with Claude' })
    expect(start).toBeDisabled()

    await userEvent.type(screen.getByRole('textbox', { name: 'Task description' }), '  add dark mode  ')
    await waitFor(() => expect(start).toBeEnabled())
    await userEvent.click(start)

    expect(onStart).toHaveBeenCalledWith({
      repo,
      provider: 'claude',
      name: '',
      prompt: 'add dark mode',
      mode: 'auto-edit',
      options: {},
      account: {
        configDir: undefined,
        copilotUser: undefined,
        display: 'dev@example.com'
      }
    })
  })

  it('surfaces a start failure inline', async () => {
    vi.mocked(window.cockpit.getAccounts).mockResolvedValue(claudeSnapshot)
    renderHome({ onStart: vi.fn().mockResolvedValue('claude CLI not found on PATH') })

    await userEvent.type(
      await screen.findByRole('textbox', { name: 'Task description' }),
      'ship it'
    )
    const start = screen.getByRole('button', { name: 'Start with Claude' })
    await waitFor(() => expect(start).toBeEnabled())
    await userEvent.click(start)

    expect(await screen.findByText('claude CLI not found on PATH')).toBeInTheDocument()
  })

  it('opens the full form via "All options", carrying the typed draft', async () => {
    vi.mocked(window.cockpit.getAccounts).mockResolvedValue(claudeSnapshot)
    const { onOpenFull } = renderHome()

    await userEvent.type(
      await screen.findByRole('textbox', { name: 'Task description' }),
      'add rate limiting'
    )
    await userEvent.click(screen.getByRole('button', { name: /All options/ }))
    // third arg: pasted images released to the full form (none here)
    expect(onOpenFull).toHaveBeenCalledWith(repo, 'add rate limiting', [])
  })

  it('sends a pasted image with the task, allowing an empty prompt', async () => {
    stubObjectUrls()
    vi.mocked(window.cockpit.getAccounts).mockResolvedValue(claudeSnapshot)
    const { onStart } = renderHome()

    const start = await screen.findByRole('button', { name: 'Start with Claude' })
    expect(start).toBeDisabled()
    pasteImage(
      screen.getByRole('textbox', { name: 'Task description' }),
      new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' })
    )
    await waitFor(() => expect(screen.getByText('shot.png')).toBeInTheDocument())
    await waitFor(() => expect(start).toBeEnabled())
    await userEvent.click(start)

    expect(onStart).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: '', images: ['/tmp/chat-images/img.png'] })
    )
  })

  it('hands pasted images to the full form via "All options"', async () => {
    stubObjectUrls()
    vi.mocked(window.cockpit.getAccounts).mockResolvedValue(claudeSnapshot)
    const { onOpenFull } = renderHome()

    pasteImage(
      await screen.findByRole('textbox', { name: 'Task description' }),
      new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' })
    )
    await waitFor(() => expect(screen.getByText('shot.png')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: /All options/ }))

    expect(onOpenFull).toHaveBeenCalledWith(repo, '', [
      { path: '/tmp/chat-images/img.png', name: 'shot.png', url: 'blob:preview' }
    ])
  })

  it('shows the "not signed in" chip for an agent that has no account', async () => {
    // claude is signed in, codex is not — the composer says so per agent
    vi.mocked(window.cockpit.getAccounts).mockResolvedValue(claudeSnapshot)
    renderHome()

    await screen.findByRole('button', { name: 'Start with Claude' })
    await userEvent.click(screen.getByRole('button', { name: 'Codex' }))
    expect(await screen.findByText('not signed in')).toBeInTheDocument()
    await userEvent.type(screen.getByRole('textbox', { name: 'Task description' }), 'ship it')
    expect(screen.getByRole('button', { name: 'Start with Codex' })).toBeDisabled()
  })
})

describe('HomeView first run', () => {
  it('replaces the composer with the steps Cockpit is waiting on', async () => {
    // a window with no agent signed in and nothing indexed cannot start anything:
    // a disabled button that says nothing is replaced by what to do about it
    vi.mocked(window.cockpit.getAccounts).mockResolvedValue({ accounts: [], githubUser: null })
    renderHome({ repos: [] })

    expect(await screen.findByText('Sign in to an agent')).toBeInTheDocument()
    expect(screen.getByText('Connect GitHub for pull requests')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Task description' })).not.toBeInTheDocument()
  })

  it('ticks the steps already satisfied and offers the one that is not', async () => {
    vi.mocked(window.cockpit.getAccounts).mockResolvedValue(claudeSnapshot)
    const { onOpenSettings } = renderHome({ repos: [] })

    const signIn = (await screen.findByText('Sign in to an agent')).closest('li')!
    expect(signIn.className).toContain('done')
    // gh is signed in too (claudeSnapshot), so the open step is the index
    expect(screen.getByText(/Pull requests as @dev/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Add a config home' }))
    expect(onOpenSettings).toHaveBeenCalledOnce()
  })

  it('shows neither the composer nor setup while accounts are still loading', async () => {
    // either guess would be swapped for the other a moment later — a flash both ways
    vi.mocked(window.cockpit.getAccounts).mockReturnValue(new Promise(() => {}))
    renderHome()
    // the footer line is the one thing the view renders in every state
    expect(await screen.findByRole('button', { name: /Start a roundtable/ })).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Task description' })).not.toBeInTheDocument()
    expect(screen.queryByText('Sign in to an agent')).not.toBeInTheDocument()
  })

  it('never flashes setup at someone whose sessions are still being read', async () => {
    // signed in, but the first scan has not finished: no repos yet proves nothing
    vi.mocked(window.cockpit.getAccounts).mockResolvedValue(claudeSnapshot)
    renderHome({ repos: [], indexed: false })
    await waitFor(() => expect(window.cockpit.getAccounts).toHaveBeenCalled())
    await act(async () => {})
    expect(screen.queryByText('Sign in to an agent')).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Task description' })).not.toBeInTheDocument()
  })

  it('never takes focus from what the person is already using when the composer appears late', async () => {
    // accounts (and with them the composer) can answer seconds after the view opened —
    // by then the person may be in the tree, and stealing focus also folds away the row
    // actions they were reaching for
    let answer: (s: AccountsSnapshot) => void = () => {}
    vi.mocked(window.cockpit.getAccounts).mockReturnValue(
      new Promise<AccountsSnapshot>((r) => {
        answer = r
      })
    )
    renderHome()
    const elsewhere = document.createElement('button')
    document.body.append(elsewhere)
    elsewhere.focus()

    await act(async () => answer(claudeSnapshot))
    const prompt = await screen.findByRole('textbox', { name: 'Task description' })
    expect(prompt).not.toHaveFocus()
    expect(elsewhere).toHaveFocus()
    elsewhere.remove()
  })

  it('leaves focus alone while a surface is layered over the view', async () => {
    // a dialog can be on screen a beat before it has focused its own field: nothing
    // holds focus, but the home is not what the person is using
    let answer: (s: AccountsSnapshot) => void = () => {}
    vi.mocked(window.cockpit.getAccounts).mockReturnValue(
      new Promise<AccountsSnapshot>((r) => {
        answer = r
      })
    )
    renderHome()
    const overlay = document.createElement('div')
    overlay.setAttribute('role', 'dialog')
    document.body.append(overlay)

    await act(async () => answer(claudeSnapshot))
    const prompt = await screen.findByRole('textbox', { name: 'Task description' })
    expect(prompt).not.toHaveFocus()
    overlay.remove()
  })

  it('shows the composer, focused, as soon as there is an account and a repo', async () => {
    // no need to wait for the scan to finish: a repo already read is proof enough
    vi.mocked(window.cockpit.getAccounts).mockResolvedValue(claudeSnapshot)
    renderHome({ indexed: false })
    const prompt = await screen.findByRole('textbox', { name: 'Task description' })
    // the textarea is in the DOM one commit before the effect that focuses it runs —
    // asserting focus straight off the find is a race a slow machine loses
    await waitFor(() => expect(prompt).toHaveFocus())
  })
})

describe('HomeView recent activity', () => {
  it('lists recent sessions and opens one on click', async () => {
    const session: SessionMeta = {
      id: 'claude:abc',
      provider: 'claude',
      nativeId: 'abc',
      source: '/home/dev/.claude',
      title: 'Fix the flaky indexer test',
      cwd: repo.root,
      logBranch: 'dev/fix-indexer',
      gitBranch: 'dev/fix-indexer',
      startedAt: 1700000000000,
      updatedAt: 1700000100000,
      messageCount: 3,
      sourcePath: '/home/dev/.claude/projects/x/abc.jsonl',
      repo: { key: repo.key, name: repo.name, fullName: repo.fullName, root: repo.root }
    }
    vi.mocked(window.cockpit.pageSessions).mockResolvedValue({ total: 1, items: [session] })
    const { onOpenSession } = renderHome()

    await userEvent.click(await screen.findByRole('button', { name: /Fix the flaky indexer test/ }))
    expect(onOpenSession).toHaveBeenCalledWith(session)
  })
})

describe('HomeView on an index push', () => {
  it('reads the tables again but listens for their rounds once', async () => {
    const props = {
      repos: [repo],
      indexed: true,
      busy: false,
      onStart: vi.fn().mockResolvedValue(null),
      onOpenSession: vi.fn(),
      onOpenFull: vi.fn(),
      onNewRoundtable: vi.fn(),
      onOpenRoundtable: vi.fn(),
      onOpenSettings: vi.fn()
    }
    const { rerender } = render(<HomeView {...props} indexVersion={0} />)
    rerender(<HomeView {...props} indexVersion={1} />)
    rerender(<HomeView {...props} indexVersion={2} />)
    await waitFor(() => expect(window.cockpit.listRoundtables).toHaveBeenCalledTimes(3))
    expect(window.cockpit.onRoundtableEvent).toHaveBeenCalledTimes(1)
  })

  it('looks a session that needs you up once per piece of news, even when the index has none', async () => {
    const idle: SessionMeta = {
      id: 'claude:old',
      provider: 'claude',
      nativeId: 'old',
      source: '/home/dev/.claude',
      title: 'An idle session that landed',
      cwd: repo.root,
      logBranch: null,
      startedAt: 1700000000000,
      updatedAt: 1700000100000,
      messageCount: 3,
      sourcePath: '/home/dev/.claude/projects/x/old.jsonl'
    }
    let push: (list: Landing[]) => void = () => {}
    vi.mocked(window.cockpit.onLandings).mockImplementation((cb) => {
      push = cb
      return () => {}
    })
    vi.mocked(window.cockpit.getSession).mockImplementation(async (id) => (id === idle.id ? idle : null))
    const stop = initLanded()
    try {
      act(() =>
        push([
          { id: idle.id, at: 1, kind: 'landed' },
          { id: 'claude:gone', at: 1, kind: 'landed' }
        ])
      )
      const props = {
        repos: [repo],
        indexed: true,
        busy: false,
        onStart: vi.fn().mockResolvedValue(null),
        onOpenSession: vi.fn(),
        onOpenFull: vi.fn(),
        onNewRoundtable: vi.fn(),
        onOpenRoundtable: vi.fn(),
        onOpenSettings: vi.fn()
      }
      const { rerender } = render(<HomeView {...props} indexVersion={0} />)
      await screen.findByRole('button', { name: /An idle session that landed/ })
      expect(window.cockpit.getSession).toHaveBeenCalledTimes(2)
      rerender(<HomeView {...props} indexVersion={1} />)
      rerender(<HomeView {...props} indexVersion={2} />)
      await waitFor(() => expect(window.cockpit.pageSessions).toHaveBeenCalledTimes(3))
      await act(async () => {})
      // neither the one it found nor the one it didn't is asked for again
      expect(window.cockpit.getSession).toHaveBeenCalledTimes(2)
      expect(screen.getByRole('button', { name: /An idle session that landed/ })).toBeInTheDocument()
      // news again for the one it could not find: that is a reason to look again
      act(() =>
        push([
          { id: idle.id, at: 1, kind: 'landed' },
          { id: 'claude:gone', at: 2, kind: 'landed' }
        ])
      )
      await waitFor(() => expect(window.cockpit.getSession).toHaveBeenCalledTimes(3))
      expect(window.cockpit.getSession).toHaveBeenLastCalledWith('claude:gone')
    } finally {
      stop()
      clearLanded()
    }
  })
})

describe('HomeView board with roundtables', () => {
  const table = (id: string, over: Partial<RoundtableMeta> = {}): RoundtableMeta => ({
    id,
    title: `table ${id}`,
    updatedAt: 1700000000000,
    providers: ['claude', 'codex'],
    archived: false,
    entryCount: 4,
    running: false,
    branch: null,
    repoRoot: null,
    ...over
  })

  it('keeps an archived table off the board', async () => {
    vi.mocked(window.cockpit.getAccounts).mockResolvedValue(claudeSnapshot)
    vi.mocked(window.cockpit.listRoundtables).mockResolvedValue([
      table('rt-1'),
      table('rt-2', { title: 'table rt-2', archived: true })
    ])
    renderHome()

    expect(await screen.findByText('table rt-1')).toBeInTheDocument()
    expect(screen.queryByText('table rt-2')).not.toBeInTheDocument()
  })

  it('puts tables on the one board, not a second panel', async () => {
    vi.mocked(window.cockpit.listRoundtables).mockResolvedValue([table('a'), table('b')])
    renderHome()
    expect(await screen.findByText('table a')).toBeInTheDocument()
    expect(document.querySelectorAll('section.board')).toHaveLength(1)
    expect(screen.queryByRole('heading', { name: 'roundtables' })).not.toBeInTheDocument()
  })

  it('counts a table mid-round as flying and leads with it', async () => {
    vi.mocked(window.cockpit.listRoundtables).mockResolvedValue([table('live', { running: true })])
    renderHome()
    expect(await screen.findByText(/1 flying/)).toBeInTheDocument()
    expect(screen.getByText('in round')).toBeInTheDocument()
  })
})
