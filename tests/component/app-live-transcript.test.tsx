import { describe, it, expect, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../../src/renderer/src/App'
import type { BusySession, ChatEvent, RepoGroup, SessionMeta } from '../../src/shared/types'

/**
 * A session run in a terminal or the provider's own app keeps writing its log under
 * the open chat: the transcript follows it, and Send waits while it is flying.
 */

const repo: RepoGroup = {
  key: '/home/dev/rocket',
  name: 'rocket',
  fullName: 'acme/rocket',
  root: '/home/dev/rocket',
  sessionCount: 1,
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

const boardRow = async (name: RegExp): Promise<HTMLElement> =>
  within(await screen.findByRole('region', { name: 'Session board' })).findByRole('button', {
    name
  })
const chatComposer = (): HTMLElement => screen.getByRole('textbox', { name: 'Message Claude' })
const sendButton = (): HTMLElement => screen.getByRole('button', { name: 'Send' })

type Pushes = {
  indexUpdated: () => void
  busy: (sessions: BusySession[]) => void
  chat: (ev: ChatEvent) => void
}

/** Wire the three pushes the behaviour rides on and land on the session's chat. */
async function openSession(): Promise<Pushes> {
  const meta = session('a', 'fix the login flake')
  vi.mocked(window.cockpit.pageSessions).mockResolvedValue({ total: 1, items: [meta] })
  vi.mocked(window.cockpit.getSession).mockImplementation(async (id) => (id === meta.id ? meta : null))
  vi.mocked(window.cockpit.getSessionMessages).mockResolvedValue([
    { role: 'user', kind: 'text', text: 'hello transcript' }
  ])
  const pushes: Pushes = { indexUpdated: () => {}, busy: () => {}, chat: () => {} }
  vi.mocked(window.cockpit.onIndexUpdated).mockImplementation((cb) => {
    pushes.indexUpdated = cb
    return () => {}
  })
  vi.mocked(window.cockpit.onBusySessions).mockImplementation((cb) => {
    pushes.busy = cb
    return () => {}
  })
  vi.mocked(window.cockpit.onChatEvent).mockImplementation((cb) => {
    pushes.chat = cb
    return () => {}
  })
  render(<App />)
  await userEvent.click(await boardRow(/fix the login flake/))
  await screen.findByText('hello transcript')
  expect(window.cockpit.getSessionMessages).toHaveBeenCalledTimes(1)
  return pushes
}

/** The index now says the session's log moved on (or not) since the chat read it. */
function logMovedOn(moved: boolean): void {
  const meta = session('a', 'fix the login flake', {
    updatedAt: moved ? Date.now() + 60_000 : 1700000600000
  })
  vi.mocked(window.cockpit.getSession).mockImplementation(async (id) => (id === meta.id ? meta : null))
}

describe('App follows the open transcript on disk', () => {
  it('re-reads the transcript when an index update says the log moved past the read on screen', async () => {
    const pushes = await openSession()
    vi.mocked(window.cockpit.getSessionMessages).mockResolvedValue([
      { role: 'user', kind: 'text', text: 'hello transcript' },
      { role: 'assistant', kind: 'text', text: 'written from a terminal' }
    ])
    logMovedOn(true)
    act(() => pushes.indexUpdated())
    await screen.findByText('written from a terminal')
    expect(window.cockpit.getSessionMessages).toHaveBeenCalledTimes(2)
    expect(window.cockpit.getSessionMessages).toHaveBeenLastCalledWith('claude:a')
  })

  it('leaves the transcript alone when the index update is about other sessions', async () => {
    const pushes = await openSession()
    logMovedOn(false)
    act(() => pushes.indexUpdated())
    // the meta lookup is the cheap check; the tail read never happens
    await waitFor(() => expect(window.cockpit.getSession).toHaveBeenCalled())
    expect(window.cockpit.getSessionMessages).toHaveBeenCalledTimes(1)
    expect(screen.getByText('hello transcript')).toBeInTheDocument()
  })

  it('never re-reads over a turn Cockpit is streaming itself', async () => {
    const pushes = await openSession()
    await userEvent.type(chatComposer(), 'go{Enter}')
    await waitFor(() => expect(window.cockpit.sendChat).toHaveBeenCalledTimes(1))
    act(() => pushes.chat({ turnId: 'turn-1', type: 'text', text: 'streaming…' }))
    await screen.findByText('streaming…')
    logMovedOn(true)
    act(() => pushes.indexUpdated())
    // nothing to await: the guard is synchronous, so give the microtasks a turn
    await act(async () => {})
    expect(window.cockpit.getSessionMessages).toHaveBeenCalledTimes(1)
    expect(screen.getByText('streaming…')).toBeInTheDocument()
    // once the turn is over, a later write from a terminal shows up again
    act(() => pushes.chat({ turnId: 'turn-1', type: 'done' }))
    vi.mocked(window.cockpit.getSessionMessages).mockResolvedValue([
      { role: 'assistant', kind: 'text', text: 'after the turn, from a terminal' }
    ])
    logMovedOn(true)
    act(() => pushes.indexUpdated())
    await screen.findByText('after the turn, from a terminal')
    expect(window.cockpit.getSessionMessages).toHaveBeenCalledTimes(2)
  })
})

describe('App holds Send while the session runs elsewhere', () => {
  it('disables Send on an observed busy entry for the open session and frees it when the entry goes', async () => {
    const pushes = await openSession()
    await userEvent.type(chatComposer(), 'a draft')
    expect(sendButton()).toBeEnabled()

    act(() => pushes.busy([{ id: 'claude:a', startedAt: Date.now(), source: 'observed' }]))
    expect(sendButton()).toBeDisabled()
    expect(screen.getByText(/Claude is working elsewhere/, { ignore: '.sr-only' })).toBeInTheDocument()
    await userEvent.type(chatComposer(), '{Enter}')
    expect(window.cockpit.sendChat).not.toHaveBeenCalled()

    act(() => pushes.busy([]))
    expect(sendButton()).toBeEnabled()
    expect(screen.queryByText(/Claude is working elsewhere/, { ignore: '.sr-only' })).not.toBeInTheDocument()
  })

  it('ignores observed entries for other sessions', async () => {
    const pushes = await openSession()
    await userEvent.type(chatComposer(), 'a draft')
    act(() => pushes.busy([{ id: 'claude:someone-else', startedAt: Date.now(), source: 'observed' }]))
    expect(sendButton()).toBeEnabled()
    expect(screen.queryByText(/Claude is working elsewhere/, { ignore: '.sr-only' })).not.toBeInTheDocument()
  })
})
