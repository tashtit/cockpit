import { describe, it, expect, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../../src/renderer/src/App'
import type { AcpReadiness, RepoGroup, SessionMeta } from '../../src/shared/types'

/**
 * A session of an agent Cockpit only reads, kept in a store its agent's ACP server does
 * not keep: a composer there would start the agent only to fail to reopen it, so it opens
 * read-only whatever answers — and one in the server's own store gains its composer.
 */

const repo: RepoGroup = {
  key: '/home/dev/rocket',
  name: 'rocket',
  fullName: 'acme/rocket',
  root: '/home/dev/rocket',
  sessionCount: 1,
  archivedCount: 0,
  heldCount: 0,
  byProvider: {},
  lastActivity: 1700000000000,
  providers: ['cursor'],
  hidden: false
}

function cursorSession(sourcePath: string): SessionMeta {
  return {
    id: 'cursor:c1',
    provider: 'cursor',
    nativeId: 'c1',
    source: 'cursor-ide',
    title: 'fix the login flake',
    cwd: '/home/dev/rocket',
    logBranch: null,
    gitBranch: 'main',
    startedAt: 1700000000000,
    updatedAt: 1700000600000,
    messageCount: 4,
    sourcePath,
    repo: { key: repo.key, name: repo.name, fullName: repo.fullName, root: repo.root },
    control: { holder: 'cockpit', how: 'taken-over', since: 5 }
  }
}

/** Open the session with Cursor's ACP agent answering; the push that changes that. */
async function open(sourcePath: string): Promise<(r: AcpReadiness) => void> {
  let push: (r: AcpReadiness) => void = () => {}
  vi.mocked(window.cockpit.onAcpReadiness).mockImplementation((cb) => {
    push = cb
    return () => {}
  })
  vi.mocked(window.cockpit.getAcpReadiness).mockResolvedValue({
    drivable: ['claude', 'codex', 'copilot', 'cursor'],
    builtinsReady: ['builtin-cursor']
  })
  vi.mocked(window.cockpit.listRepos).mockResolvedValue([repo])
  vi.mocked(window.cockpit.pageSessions).mockResolvedValue({ total: 1, items: [cursorSession(sourcePath)] })
  vi.mocked(window.cockpit.getSession).mockResolvedValue(cursorSession(sourcePath))
  vi.mocked(window.cockpit.getSessionMessages).mockResolvedValue([
    { role: 'user', kind: 'text', text: 'hello transcript' }
  ])
  render(<App />)
  const board = await screen.findByRole('region', { name: 'Session board' })
  await userEvent.click(await within(board).findByRole('button', { name: /fix the login flake/ }))
  await screen.findByText('hello transcript')
  return (r) => act(() => push(r))
}

describe('App and a session its agent’s ACP server does not keep', () => {
  it('opens an editor’s Cursor chat read-only while Cursor’s ACP agent answers, and says why', async () => {
    const pushed = await open('/home/dev/Library/Application Support/Cursor/User/globalStorage/state.vscdb#c1')
    await waitFor(() => expect(window.cockpit.getAcpReadiness).toHaveBeenCalled())
    // a later push says the same: still no composer
    pushed({ drivable: ['claude', 'codex', 'copilot', 'cursor'], builtinsReady: ['builtin-cursor'] })
    expect(screen.queryByRole('textbox', { name: 'Message Cursor' })).toBeNull()
    expect(screen.getByText(/Cursor's ACP server keeps its own conversations, and this one isn't among them/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Continue it with another agent…' })).toBeInTheDocument()
  })

  it('offers the composer for a conversation Cursor’s ACP server keeps', async () => {
    const pushed = await open('/home/dev/.cursor/acp-sessions/c1/store.db')
    pushed({ drivable: ['claude', 'codex', 'copilot', 'cursor'], builtinsReady: ['builtin-cursor'] })
    expect(await screen.findByRole('textbox', { name: 'Message Cursor' })).toBeInTheDocument()
  })
})
