import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HomeView } from '../../src/renderer/src/HomeView'
import type { AccountsSnapshot, RepoGroup, SessionMeta } from '../../src/shared/types'
import { pasteImage, stubObjectUrls } from './paste'

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
    indexVersion: 0,
    busy: false,
    onStart: vi.fn().mockResolvedValue(null),
    onOpenSession: vi.fn(),
    onOpenFull: vi.fn(),
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

  it('keeps start disabled and shows "not signed in" when the agent has no account', async () => {
    // snapshot loaded, but it holds no claude accounts
    vi.mocked(window.cockpit.getAccounts).mockResolvedValue({ accounts: [], githubUser: null })
    renderHome()

    expect(await screen.findByText('not signed in')).toBeInTheDocument()
    await userEvent.type(screen.getByRole('textbox', { name: 'Task description' }), 'ship it')
    expect(screen.getByRole('button', { name: 'Start with Claude' })).toBeDisabled()
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
