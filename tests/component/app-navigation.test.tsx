import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../../src/renderer/src/App'
import type { ChatEvent, RepoGroup, SessionMeta } from '../../src/shared/types'

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

const cmd = (key: string): void => {
  fireEvent.keyDown(window, { key, metaKey: true })
}

/** Board rows appear once pageSessions resolves — always await the region. */
const boardRow = async (name: RegExp): Promise<HTMLElement> =>
  within(await screen.findByRole('region', { name: 'Session board' })).findByRole('button', {
    name
  })
/**
 * Home's own marker. The view has no greeting heading any more — its only heading is
 * the board's masthead, whose text is the live counts — so this is the footer line,
 * which home renders in every state (signed in or not, board or no board).
 */
const homeHero = (): Promise<HTMLElement> =>
  screen.findByRole('button', { name: /Start a roundtable/ })
const chatComposer = (): HTMLElement => screen.getByRole('textbox', { name: 'Message Claude' })

describe('App back/forward navigation (⌘[ / ⌘])', () => {
  it('⌘[ returns to the previous view and ⌘] comes forward again', async () => {
    render(<App />)
    await homeHero()

    cmd(',')
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument()

    cmd('[')
    await homeHero()
    expect(screen.queryByRole('heading', { name: 'Settings' })).not.toBeInTheDocument()

    cmd(']')
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument()

    // history exhausted in both directions — extra presses are quiet no-ops
    cmd(']')
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument()
  })

  it('backing into the still-bound chat flips the view without refetching the transcript', async () => {
    vi.mocked(window.cockpit.pageSessions).mockResolvedValue({
      total: 1,
      items: [session('a', 'fix the login flake')]
    })
    vi.mocked(window.cockpit.getSessionMessages).mockResolvedValue([
      { role: 'user', kind: 'text', text: 'hello transcript' }
    ])
    render(<App />)

    await userEvent.click(await boardRow(/fix the login flake/))
    expect(chatComposer()).toBeInTheDocument()
    await screen.findByText('hello transcript')
    expect(window.cockpit.getSessionMessages).toHaveBeenCalledTimes(1)

    cmd(',')
    expect(screen.getByRole('heading', { name: 'Settings' })).toBeInTheDocument()

    cmd('[')
    expect(chatComposer()).toBeInTheDocument()
    // the log was never torn down, so the transcript is still there — no refetch
    expect(screen.getByText('hello transcript')).toBeInTheDocument()
    expect(window.cockpit.getSessionMessages).toHaveBeenCalledTimes(1)

    cmd('[')
    await homeHero()
    cmd(']')
    expect(chatComposer()).toBeInTheDocument()
    expect(window.cockpit.getSessionMessages).toHaveBeenCalledTimes(1)
  })

  it('re-materializes an earlier chat and resumes the session id it minted since', async () => {
    vi.mocked(window.cockpit.pageSessions).mockResolvedValue({
      total: 2,
      items: [session('a', 'fix the login flake'), session('b', 'add pagination')]
    })
    let emit: ((ev: ChatEvent) => void) | undefined
    vi.mocked(window.cockpit.onChatEvent).mockImplementation((cb) => {
      emit = cb
      return () => {}
    })
    render(<App />)

    await userEvent.click(await boardRow(/fix the login flake/))
    await userEvent.type(chatComposer(), 'hi{Enter}')
    await waitFor(() => expect(window.cockpit.sendChat).toHaveBeenCalledTimes(1))
    // the turn resumes claude, which forks a new native session id
    act(() => {
      emit?.({ turnId: 'turn-1', type: 'session', nativeSessionId: 'a2' })
      emit?.({ turnId: 'turn-1', type: 'done' })
    })

    cmd('n')
    await userEvent.click(await boardRow(/add pagination/))
    expect(window.cockpit.getSessionMessages).toHaveBeenLastCalledWith('claude:b')

    cmd('[')
    await homeHero()
    cmd('[')
    // a different conversation is bound now, so the entry reloads its transcript —
    // under the id the session event minted, not the pre-turn one
    expect(chatComposer()).toBeInTheDocument()
    expect(window.cockpit.getSessionMessages).toHaveBeenLastCalledWith('claude:a2')

    // resuming from here must continue the minted id too
    await userEvent.type(chatComposer(), 'again{Enter}')
    await waitFor(() => expect(window.cockpit.sendChat).toHaveBeenCalledTimes(2))
    expect(vi.mocked(window.cockpit.sendChat).mock.calls[1][0].resumeNativeId).toBe('a2')
  })
})

describe('App child sessions', () => {
  it('names the parent of a session another one started, and opens it from the chip', async () => {
    const parent = session('p', 'Free plan limits')
    const child = session('c', 'Account usage foundation', { parentId: 'claude:p' })
    vi.mocked(window.cockpit.pageSessions).mockResolvedValue({ total: 2, items: [parent, child] })
    vi.mocked(window.cockpit.getSession).mockImplementation(async (id) => (id === 'claude:p' ? parent : null))
    render(<App />)

    await userEvent.click(await boardRow(/Account usage foundation/))
    const chip = await screen.findByRole('button', { name: /Started by the Claude session “Free plan limits”/ })
    await userEvent.click(chip)
    await waitFor(() => expect(window.cockpit.getSessionMessages).toHaveBeenLastCalledWith('claude:p'))
    // the parent itself was started by nobody
    await waitFor(() => expect(screen.queryByRole('button', { name: /Started by/ })).not.toBeInTheDocument())
  })

  it('gives no chip when the parent is gone from the index', async () => {
    const child = session('c', 'Account usage foundation', { parentId: 'claude:gone' })
    vi.mocked(window.cockpit.pageSessions).mockResolvedValue({ total: 1, items: [child] })
    vi.mocked(window.cockpit.getSession).mockResolvedValue(null)
    render(<App />)

    await userEvent.click(await boardRow(/Account usage foundation/))
    await waitFor(() => expect(window.cockpit.getSession).toHaveBeenCalledWith('claude:gone'))
    expect(screen.queryByRole('button', { name: /Started by/ })).not.toBeInTheDocument()
  })
})
