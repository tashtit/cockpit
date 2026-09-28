import { describe, it, expect, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../../src/renderer/src/App'
import type { AcpReadiness, RepoGroup, SessionControl, SessionMeta } from '../../src/shared/types'

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
  providers: ['claude'],
  hidden: false
}

function session(control: SessionControl): SessionMeta {
  return {
    id: 'claude:a',
    provider: 'claude',
    nativeId: 'a',
    source: 'claude-default',
    title: 'fix the login flake',
    cwd: '/home/dev/rocket',
    logBranch: 'main',
    gitBranch: 'main',
    startedAt: 1700000000000,
    updatedAt: 1700000600000,
    messageCount: 4,
    sourcePath: '/home/dev/.claude/projects/p/a.jsonl',
    repo: { key: repo.key, name: repo.name, fullName: repo.fullName, root: repo.root },
    control
  }
}

async function openSession(control: SessionControl): Promise<void> {
  vi.mocked(window.cockpit.listRepos).mockResolvedValue([repo])
  vi.mocked(window.cockpit.pageSessions).mockResolvedValue({ total: 1, items: [session(control)] })
  vi.mocked(window.cockpit.getSession).mockResolvedValue(session(control))
  vi.mocked(window.cockpit.getSessionMessages).mockResolvedValue([
    { role: 'user', kind: 'text', text: 'hello transcript' }
  ])
  render(<App />)
  const board = await screen.findByRole('region', { name: 'Session board' })
  await userEvent.click(await within(board).findByRole('button', { name: /fix the login flake/ }))
  // the transcript has landed — anything said after this is not overwritten by it
  await screen.findByText('hello transcript')
}

describe('App and who drives the open session', () => {
  it('reads a session from outside Cockpit, and sends only once it is taken over', async () => {
    await openSession({ holder: 'agent', how: 'outside' })
    const composer = await screen.findByRole('textbox', { name: 'Message Claude' })
    await userEvent.type(composer, 'carry on')
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()

    const taken: SessionControl = { holder: 'cockpit', how: 'taken-over', since: 5 }
    vi.mocked(window.cockpit.setSessionHolder).mockResolvedValue(taken)
    vi.mocked(window.cockpit.getSession).mockResolvedValue(session(taken))
    await userEvent.click(screen.getByRole('button', { name: 'Take over' }))
    expect(window.cockpit.setSessionHolder).toHaveBeenCalledWith('claude:a', 'cockpit')

    // the bar gives way to the composer, which kept the draft
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Who drives this session' })).toBeNull())
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(window.cockpit.sendChat).toHaveBeenCalledWith(
        expect.objectContaining({ resumeNativeId: 'a', prompt: 'carry on' })
      )
    )
  })

  it('says why a take-over main refused did not happen, and keeps Send held', async () => {
    await openSession({ holder: 'agent', how: 'outside' })
    vi.mocked(window.cockpit.setSessionHolder).mockRejectedValue(
      new Error('Its agent is working on it right now — take it over once that turn ends.')
    )
    await userEvent.click(await screen.findByRole('button', { name: 'Take over' }))
    expect(
      await screen.findByText(/Couldn't take it over: Its agent is working on it/, { ignore: '.sr-only' })
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  it("says main's reason without the wrapper Electron puts around a refused call", async () => {
    await openSession({ holder: 'agent', how: 'outside' })
    vi.mocked(window.cockpit.setSessionHolder).mockRejectedValue(
      new Error(
        "Error invoking remote method 'sessions:set-holder': Error: Its agent is working on it right now — take it over once that turn ends."
      )
    )
    await userEvent.click(await screen.findByRole('button', { name: 'Take over' }))
    const notice = await screen.findByText(/Couldn't take it over: Its agent is working on it/, { ignore: '.sr-only' })
    expect(notice).not.toHaveTextContent(/Error invoking remote method/)
  })

  it('releases a session Cockpit holds back to its agent', async () => {
    await openSession({ holder: 'cockpit', how: 'started' })
    const released: SessionControl = { holder: 'agent', how: 'released', since: 9 }
    vi.mocked(window.cockpit.setSessionHolder).mockResolvedValue(released)
    await userEvent.click(await screen.findByRole('button', { name: 'In Cockpit' }))
    await userEvent.click(screen.getByRole('button', { name: 'Release to Claude' }))
    expect(window.cockpit.setSessionHolder).toHaveBeenCalledWith('claude:a', 'agent')
    expect(await screen.findByRole('button', { name: 'Take over' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Who drives this session' })).toHaveTextContent(/released from Cockpit/)
    // the key pressed is gone: focus lands on the one that took its place, not the body
    await waitFor(() => expect(screen.getByRole('button', { name: 'Take over' })).toHaveFocus())
  })
})

describe('App and a session of an agent Cockpit only reads', () => {
  const gemini = (control: SessionControl): SessionMeta => ({
    ...session(control),
    id: 'gemini:g',
    provider: 'gemini',
    nativeId: 'g',
    source: 'gemini-default',
    sourcePath: '/home/dev/.gemini/tmp/p/chats/session-g.jsonl'
  })

  async function openGemini(control: SessionControl): Promise<(r: AcpReadiness) => void> {
    let push: (r: AcpReadiness) => void = () => {}
    vi.mocked(window.cockpit.onAcpReadiness).mockImplementation((cb) => {
      push = cb
      return () => {}
    })
    vi.mocked(window.cockpit.listRepos).mockResolvedValue([repo])
    vi.mocked(window.cockpit.pageSessions).mockResolvedValue({ total: 1, items: [gemini(control)] })
    vi.mocked(window.cockpit.getSession).mockResolvedValue(gemini(control))
    vi.mocked(window.cockpit.getSessionMessages).mockResolvedValue([
      { role: 'user', kind: 'text', text: 'hello transcript' }
    ])
    render(<App />)
    const board = await screen.findByRole('region', { name: 'Session board' })
    await userEvent.click(await within(board).findByRole('button', { name: /fix the login flake/ }))
    await screen.findByText('hello transcript')
    return (r) => act(() => push(r))
  }

  it('opens read-only, and gains its composer the moment an ACP agent answers for it', async () => {
    const answered = await openGemini({ holder: 'cockpit', how: 'taken-over', since: 5 })
    expect(screen.queryByRole('textbox', { name: 'Message Gemini' })).toBeNull()
    expect(screen.getByText(/Cockpit runs Gemini only over its ACP server/)).toBeInTheDocument()

    answered({ drivable: ['claude', 'codex', 'copilot', 'gemini'], builtinsReady: ['builtin-gemini'] })
    await userEvent.type(await screen.findByRole('textbox', { name: 'Message Gemini' }), 'carry on')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))
    await waitFor(() =>
      expect(window.cockpit.sendChat).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'gemini', resumeNativeId: 'g', prompt: 'carry on' })
      )
    )

    // and loses it again when that agent goes
    answered({ drivable: ['claude', 'codex', 'copilot'], builtinsReady: [] })
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Message Gemini' })).toBeNull())
  })
})
