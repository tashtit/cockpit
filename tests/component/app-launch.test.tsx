import { describe, it, expect, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../../src/renderer/src/App'
import type { AccountsSnapshot, ChatEvent, RepoGroup } from '../../src/shared/types'

/**
 * The conversations Cockpit starts itself: a new session in a worktree of its own, and a
 * handoff that continues one in the same directory on another agent.
 */

const repo: RepoGroup = {
  key: '/home/dev/rocket',
  name: 'rocket',
  fullName: 'acme/rocket',
  root: '/home/dev/rocket',
  sessionCount: 0,
  archivedCount: 0,
  heldCount: 0,
  lastActivity: 1700000000000,
  providers: ['claude'],
  hidden: false
}

const accounts: AccountsSnapshot = {
  accounts: [
    { provider: 'claude', path: '/home/dev/.claude', label: 'claude-default', identity: 'dev@example.com', isDefault: true },
    { provider: 'codex', path: '/home/dev/.codex', label: 'codex-default', identity: 'dev@example.com', isDefault: true }
  ],
  githubUser: 'dev'
}

const WORKTREE = '/home/dev/.cockpit/worktrees/rocket/add-dark-mode'

/** Accounts, a repo and a worktree to start in; returns the chat stream's push. */
function wire(): { chat: (ev: ChatEvent) => void } {
  vi.mocked(window.cockpit.listRepos).mockResolvedValue([repo])
  vi.mocked(window.cockpit.getAccounts).mockResolvedValue(accounts)
  vi.mocked(window.cockpit.createWorkspace).mockResolvedValue({ cwd: WORKTREE, branch: 'cockpit/add-dark-mode' })
  const pushes = { chat: (_ev: ChatEvent): void => {} }
  vi.mocked(window.cockpit.onChatEvent).mockImplementation((cb) => {
    pushes.chat = cb
    return () => {}
  })
  return pushes
}

/** Start "add dark mode" with Claude from home's composer, and wait for its chat. */
async function startFromHome(): Promise<void> {
  render(<App />)
  await userEvent.type(await screen.findByRole('textbox', { name: 'Task description' }), 'add dark mode')
  const start = screen.getByRole('button', { name: 'Start with Claude' })
  await waitFor(() => expect(start).toBeEnabled())
  await userEvent.click(start)
  await screen.findByText(/Worktree ready on cockpit\/add-dark-mode/)
}

describe('App starts conversations of its own', () => {
  it('starts a session in a fresh worktree and sends the task as its first turn', async () => {
    wire()
    await startFromHome()
    expect(window.cockpit.createWorkspace).toHaveBeenCalledWith('/home/dev/rocket', expect.any(String))
    await waitFor(() => expect(window.cockpit.sendChat).toHaveBeenCalledTimes(1))
    const req = vi.mocked(window.cockpit.sendChat).mock.calls[0][0]
    expect(req).toMatchObject({
      provider: 'claude',
      cwd: WORKTREE,
      prompt: 'add dark mode',
      permissionMode: 'auto-edit'
    })
    // a new session resumes nothing
    expect(req.resumeNativeId).toBeUndefined()
    expect(screen.getByText('add dark mode', { selector: '.msg *' })).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: 'Stop' })).toBeInTheDocument()
  })

  it('hands the session to another agent in the same worktree, the briefing as its first turn', async () => {
    const pushes = wire()
    vi.mocked(window.cockpit.getHandoffBriefing).mockResolvedValue({ briefing: 'the story so far', cwdExists: true })
    await startFromHome()
    await waitFor(() => expect(window.cockpit.sendChat).toHaveBeenCalledTimes(1))
    act(() => {
      pushes.chat({ turnId: 'turn-1', type: 'session', nativeSessionId: 'n1' })
      pushes.chat({ turnId: 'turn-1', type: 'done' })
    })

    await userEvent.click(await screen.findByRole('button', { name: 'Continue in another agent…' }))
    await waitFor(() => expect(screen.getByLabelText('Briefing')).toHaveValue('the story so far'))
    await userEvent.click(screen.getByRole('button', { name: 'Continue in Codex' }))

    await screen.findByText(/Continuing from Claude in/)
    await waitFor(() => expect(window.cockpit.sendChat).toHaveBeenCalledTimes(2))
    expect(vi.mocked(window.cockpit.sendChat).mock.calls[1][0]).toMatchObject({
      provider: 'codex',
      cwd: WORKTREE,
      prompt: 'the story so far',
      handoffFrom: 'claude:n1'
    })
    expect(vi.mocked(window.cockpit.sendChat).mock.calls[1][0].resumeNativeId).toBeUndefined()
  })

  it("says why a worktree could not be made in main's words, on the form it was started from", async () => {
    wire()
    vi.mocked(window.cockpit.createWorkspace).mockRejectedValue(
      new Error("Error invoking remote method 'workspace:create': Error: the branch name is already taken")
    )
    render(<App />)
    await userEvent.type(await screen.findByRole('textbox', { name: 'Task description' }), 'add dark mode')
    const start = screen.getByRole('button', { name: 'Start with Claude' })
    await waitFor(() => expect(start).toBeEnabled())
    await userEvent.click(start)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('the branch name is already taken')
    expect(alert).not.toHaveTextContent(/Error invoking remote method/)
    expect(window.cockpit.sendChat).not.toHaveBeenCalled()
  })
})
