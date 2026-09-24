import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../../src/renderer/src/App'
import type { BusySession, ChatEvent, RepoGroup, SessionMessage, SessionMeta } from '../../src/shared/types'

/**
 * A session run in a terminal or the provider's own app keeps writing its log under
 * the open chat: the transcript follows it, and Send waits while it is flying. One
 * Cockpit is running itself is rejoined when it is opened again.
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
const stopButton = (): HTMLElement => screen.getByRole('button', { name: 'Stop' })

type Pushes = {
  indexUpdated: () => void
  busy: (sessions: BusySession[]) => void
  chat: (ev: ChatEvent) => void
}

/** Wire the three pushes the behaviour rides on, over these sessions and this log. */
function wire(
  log: SessionMessage[] = [{ role: 'user', kind: 'text', text: 'hello transcript' }],
  metas: SessionMeta[] = [session('a', 'fix the login flake')]
): Pushes {
  vi.mocked(window.cockpit.pageSessions).mockResolvedValue({ total: metas.length, items: metas })
  vi.mocked(window.cockpit.getSession).mockImplementation(
    async (id) => metas.find((m) => m.id === id) ?? null
  )
  vi.mocked(window.cockpit.getSessionMessages).mockResolvedValue(log)
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
  return pushes
}

/** Wire the pushes and land on the session's chat. */
async function openSession(): Promise<Pushes> {
  const pushes = wire()
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

describe('App rejoins a turn of its own that is still running when its session opens', () => {
  const running = (turnId: string, id = 'claude:a'): BusySession => ({
    id,
    startedAt: Date.now() - 5000,
    source: 'spawned',
    turnId
  })
  const cmd = (key: string): void => {
    fireEvent.keyDown(window, { key, metaKey: true })
  }
  /** Render and wait for the board — by then the busy seed has landed, and a push after
   *  it is not overwritten by it. */
  const mount = async (): Promise<void> => {
    render(<App />)
    await screen.findByRole('region', { name: 'Session board' })
    await waitFor(() => expect(window.cockpit.getBusySessions).toHaveBeenCalled())
    await act(async () => {})
  }

  it('after a reload: Stop instead of Send, the log from disk once, and the stream from there', async () => {
    const pushes = wire([
      { role: 'user', kind: 'text', text: 'hello transcript' },
      { role: 'assistant', kind: 'text', text: 'written before the reload' }
    ])
    // a new window; main is still running the turn the old one started
    vi.mocked(window.cockpit.getBusySessions).mockResolvedValue([running('turn-9')])
    render(<App />)
    // the turn's events reach the window before it knows the turn — its log has them
    act(() => pushes.chat({ turnId: 'turn-9', type: 'text', text: 'written before the reload' }))
    await userEvent.click(await boardRow(/fix the login flake/))
    await screen.findByText('written before the reload')
    expect(stopButton()).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument()
    expect(screen.getAllByText('written before the reload')).toHaveLength(1)

    act(() => pushes.chat({ turnId: 'turn-9', type: 'text', text: 'fresh from the stream' }))
    await screen.findByText('fresh from the stream')
    await userEvent.click(stopButton())
    expect(window.cockpit.cancelChat).toHaveBeenCalledWith('turn-9')
    expect(sendButton()).toBeInTheDocument()
  })

  it('frees Send when the rejoined turn ends, and the next message resumes the session', async () => {
    const pushes = wire()
    await mount()
    act(() => pushes.busy([running('turn-9')]))
    await userEvent.click(await boardRow(/fix the login flake/))
    await screen.findByText('hello transcript')
    expect(stopButton()).toBeInTheDocument()

    act(() => {
      pushes.chat({ turnId: 'turn-9', type: 'done' })
      pushes.busy([])
    })
    await userEvent.type(chatComposer(), 'now the tests{Enter}')
    await waitFor(() => expect(window.cockpit.sendChat).toHaveBeenCalledTimes(1))
    expect(window.cockpit.sendChat).toHaveBeenCalledWith(
      expect.objectContaining({ resumeNativeId: 'a', prompt: 'now the tests' })
    )
  })

  it('shows a row the stream re-sends while the log is being read only once', async () => {
    const pushes = wire()
    let land!: (log: SessionMessage[]) => void
    vi.mocked(window.cockpit.getSessionMessages).mockImplementation(
      () => new Promise((resolve) => (land = resolve))
    )
    await mount()
    act(() => pushes.busy([running('turn-9')]))
    await userEvent.click(await boardRow(/fix the login flake/))
    // the CLI wrote the first to its log and printed both while the window read the log
    act(() => {
      pushes.chat({ turnId: 'turn-9', type: 'text', text: 'the last line on disk' })
      pushes.chat({ turnId: 'turn-9', type: 'text', text: 'the first line after it' })
    })
    await act(async () =>
      land([
        { role: 'user', kind: 'text', text: 'hello transcript' },
        { role: 'assistant', kind: 'text', text: 'the last line on disk' }
      ])
    )
    await screen.findByText('the first line after it')
    expect(screen.getAllByText('the last line on disk')).toHaveLength(1)
  })

  it('keeps the live log when the conversation on screen is opened again mid-turn', async () => {
    const pushes = await openSession()
    await userEvent.type(chatComposer(), 'go{Enter}')
    await waitFor(() => expect(window.cockpit.sendChat).toHaveBeenCalledTimes(1))
    act(() => pushes.busy([running('turn-1')]))
    act(() => pushes.chat({ turnId: 'turn-1', type: 'text', text: 'streaming…' }))
    await screen.findByText('streaming…')

    // home, and back in through the board's card for the same session
    cmd('n')
    await userEvent.click(await boardRow(/fix the login flake/))
    expect(stopButton()).toBeInTheDocument()
    expect(screen.getByText('streaming…')).toBeInTheDocument()
    expect(window.cockpit.getSessionMessages).toHaveBeenCalledTimes(1)
    act(() => pushes.chat({ turnId: 'turn-1', type: 'text', text: ' and on' }))
    await screen.findByText('streaming… and on')
  })

  it('keeps a question the turn asked for its own chat, shown whenever that chat is', async () => {
    const pushes = wire(undefined, [session('a', 'fix the login flake'), session('b', 'add pagination')])
    await mount()
    act(() => pushes.busy([running('turn-9')]))
    // asked while no chat was open
    act(() =>
      pushes.chat({
        turnId: 'turn-9',
        type: 'permission',
        requestId: '7',
        toolName: 'shell',
        detail: '{"command":"npm test"}',
        preview: 'Run the test suite',
        options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' }]
      })
    )
    const asks = (): HTMLElement | null =>
      screen.queryByRole('group', { name: 'Claude needs permission: Run the test suite' })

    await userEvent.click(await boardRow(/add pagination/))
    await screen.findByText('hello transcript')
    expect(asks()).not.toBeInTheDocument()

    cmd('n')
    await userEvent.click(await boardRow(/fix the login flake/))
    await waitFor(() => expect(asks()).toBeInTheDocument())

    // another conversation never wears it
    cmd('n')
    await userEvent.click(await boardRow(/add pagination/))
    await waitFor(() => expect(asks()).not.toBeInTheDocument())
  })

  it('keeps a question asked while another conversation’s turn held the screen', async () => {
    const pushes = wire(undefined, [session('a', 'fix the login flake'), session('b', 'add pagination')])
    await mount()
    await userEvent.click(await boardRow(/add pagination/))
    await screen.findByText('hello transcript')
    await userEvent.type(chatComposer(), 'go{Enter}')
    await waitFor(() => expect(window.cockpit.sendChat).toHaveBeenCalledTimes(1))
    act(() => pushes.busy([running('turn-9'), running('turn-1', 'claude:b')]))
    // a's turn asks while b's own turn is the one on screen
    act(() =>
      pushes.chat({
        turnId: 'turn-9',
        type: 'permission',
        requestId: '1000',
        toolName: 'shell',
        detail: '{"command":"npm test"}',
        preview: 'Run the test suite',
        options: [{ optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' }]
      })
    )
    const asks = (): HTMLElement | null =>
      screen.queryByRole('group', { name: 'Claude needs permission: Run the test suite' })
    expect(asks()).not.toBeInTheDocument()

    cmd('n')
    await userEvent.click(await boardRow(/fix the login flake/))
    await waitFor(() => expect(asks()).toBeInTheDocument())
    await userEvent.click(within(asks()!).getByRole('button', { name: 'Allow once' }))
    expect(window.cockpit.respondPermission).toHaveBeenCalledWith('turn-9', '1000', 'allow_once')
    expect(asks()).not.toBeInTheDocument()
  })

  it('never rejoins a roundtable seat’s turn — that streams at its table', async () => {
    const pushes = wire(undefined, [session('a', 'seat of the table', { roundtableId: 'rt-1' })])
    await mount()
    act(() => pushes.busy([running('turn-9')]))
    await userEvent.click(await boardRow(/seat of the table/))
    await screen.findByText('hello transcript')
    expect(screen.getByText(/Seat session of a roundtable/)).toBeInTheDocument()
    expect(screen.queryByText(/Claude is working…/, { ignore: '.sr-only' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
  })
})
