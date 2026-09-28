import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { App } from '../../src/renderer/src/App'
import { ChatView } from '../../src/renderer/src/ChatView'
import type { ChatBinding } from '../../src/renderer/src/chat-binding'
import { setChatLog } from '../../src/renderer/src/chat-log'
import { initSideChat, resetSideChat } from '../../src/renderer/src/side-chat-log'
import type { ChatEvent, SessionMessage, SessionMeta } from '../../src/shared/types'

const binding: ChatBinding = {
  provider: 'claude',
  cwd: '/tmp/wt',
  nativeSessionId: 'sid-1',
  title: 'Fix the login flake',
  branch: 'cockpit/login-flake',
  repoRoot: '/tmp/repo',
  options: { model: 'opus', effort: 'high' },
  configDir: '/Users/me/.claude-work'
}

function renderChat(over: { binding?: Partial<ChatBinding>; busy?: boolean; log?: SessionMessage[] } = {}): void {
  if (over.log) setChatLog(over.log)
  render(
    <ChatView
      binding={{ ...binding, ...over.binding }}
      prs={[]}
      busy={over.busy ?? false}
      elsewhere={false}
      prBusy={false}
      onSend={vi.fn()}
      onCancel={() => {}}
      onCreatePr={() => {}}
      onOpenUrl={() => {}}
      onOpenHandoff={() => {}}
      onOpenLineage={() => {}}
      permissions={[]}
      onAnswerPermission={vi.fn()}
    />
  )
}

/** Main's side-chat stream, as the store hears it */
let emitSide: (ev: ChatEvent) => void = () => {}
const sideKey = (): HTMLElement => screen.getByRole('button', { name: 'Side chat' })
const question = (): HTMLElement => screen.getByRole('textbox', { name: 'Ask Claude on the side' })

beforeEach(() => {
  resetSideChat()
  vi.mocked(window.cockpit.onSideChatEvent).mockImplementation((cb) => {
    emitSide = cb
    return () => {}
  })
  initSideChat()
})

async function ask(text: string): Promise<void> {
  await userEvent.type(question(), `${text}{Enter}`)
}

describe('side chat', () => {
  it('is offered on a started Claude or Codex session that takes input — never Copilot, a seat or a new chat', () => {
    renderChat()
    expect(sideKey()).toHaveAttribute('aria-pressed', 'false')
    for (const b of [{ nativeSessionId: null }, { provider: 'copilot' as const }, { readOnly: 'seat' as const }]) {
      document.body.innerHTML = ''
      renderChat({ binding: b })
      expect(screen.queryByRole('button', { name: 'Side chat' })).not.toBeInTheDocument()
    }
    document.body.innerHTML = ''
    renderChat({ binding: { provider: 'codex' } })
    expect(sideKey()).toBeInTheDocument()
  })

  it('asks a copy of the session mid-turn, and the answer stays out of the transcript', async () => {
    renderChat({ busy: true, log: [{ role: 'user', kind: 'text', text: 'fix the flake' }] })
    // the session's own Send waits on its turn; a side question does not
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
    await userEvent.click(sideKey())
    expect(sideKey()).toHaveAttribute('aria-pressed', 'true')
    expect(question()).toHaveFocus()

    await ask('why retries = 3?')
    expect(window.cockpit.askSideChat).toHaveBeenCalledWith({
      provider: 'claude',
      cwd: '/tmp/wt',
      nativeSessionId: 'sid-1',
      options: { model: 'opus', effort: 'high' },
      configDir: '/Users/me/.claude-work',
      question: 'why retries = 3?',
      history: []
    })
    const panel = screen.getByRole('complementary', { name: 'Side chat' })
    expect(within(panel).getByText('Claude is answering…')).toBeInTheDocument()
    expect(question()).toHaveValue('')

    act(() => {
      emitSide({ turnId: 'side-turn-1', type: 'tool', toolName: 'Read', detail: '{}', preview: 'Read src/login.ts' })
    })
    expect(within(panel).getByText('Claude is looking: Read src/login.ts')).toBeInTheDocument()
    act(() => {
      emitSide({ turnId: 'side-turn-1', type: 'text', text: 'Two retries still flaked under load.' })
    })
    // a reply still coming wears no mark of its own: the line under it says it is live
    expect(await within(panel).findByText('Two retries still flaked under load.')).toBeInTheDocument()
    expect(panel.querySelector('.msg-assistant')).not.toHaveClass('streaming')
    act(() => {
      emitSide({ turnId: 'side-turn-1', type: 'done' })
    })
    expect(within(panel).getByText('1 step · Read')).toBeInTheDocument()
    // the conversation never heard of it
    const transcript = document.querySelector('.messages') as HTMLElement
    expect(within(transcript).queryByText(/Two retries/)).not.toBeInTheDocument()
    expect(within(transcript).queryByText(/why retries/)).not.toBeInTheDocument()
    expect(window.cockpit.sendChat).not.toHaveBeenCalled()
  })

  it('carries the answered exchanges into the next question, not the ones that failed', async () => {
    renderChat()
    await userEvent.click(sideKey())
    await ask('first?')
    act(() => {
      emitSide({ turnId: 'side-turn-1', type: 'text', text: 'First answer.' })
      emitSide({ turnId: 'side-turn-1', type: 'done' })
    })
    vi.mocked(window.cockpit.askSideChat).mockResolvedValueOnce('side-turn-2')
    await ask('second?')
    act(() => {
      emitSide({ turnId: 'side-turn-2', type: 'error', message: 'claude exited with code 1' })
      emitSide({ turnId: 'side-turn-2', type: 'done' })
    })
    expect(await screen.findByText('Side question failed: claude exited with code 1')).toBeInTheDocument()
    vi.mocked(window.cockpit.askSideChat).mockResolvedValueOnce('side-turn-3')
    await ask('third?')
    expect(vi.mocked(window.cockpit.askSideChat).mock.calls[2][0].history).toEqual([
      { question: 'first?', answer: 'First answer.' }
    ])
  })

  it('stops a question being answered, and what its process says after is the kill', async () => {
    renderChat()
    await userEvent.click(sideKey())
    await ask('slow one?')
    await userEvent.click(within(screen.getByRole('complementary', { name: 'Side chat' })).getByRole('button', { name: 'Stop' }))
    expect(window.cockpit.cancelSideChat).toHaveBeenCalledWith('side-turn-1')
    act(() => {
      emitSide({ turnId: 'side-turn-1', type: 'error', message: 'claude exited with code null' })
      emitSide({ turnId: 'side-turn-1', type: 'done' })
    })
    expect(screen.getByText('Stopped.')).toBeInTheDocument()
    expect(screen.queryByText(/exited with code null/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Ask' })).toBeInTheDocument()
  })

  it('hears a turn that failed before main said which one it was', async () => {
    let resolve: (id: string) => void = () => {}
    vi.mocked(window.cockpit.askSideChat).mockImplementationOnce(() => new Promise((r) => (resolve = r)))
    renderChat()
    await userEvent.click(sideKey())
    await ask('where?')
    act(() => {
      emitSide({ turnId: 'side-turn-9', type: 'error', message: 'Working directory no longer exists: /tmp/wt' })
      emitSide({ turnId: 'side-turn-9', type: 'done' })
    })
    await act(async () => resolve('side-turn-9'))
    expect(await screen.findByText(/Side question failed: Working directory no longer exists/)).toBeInTheDocument()
  })

  it('says why main refused the question, in its own words', async () => {
    vi.mocked(window.cockpit.askSideChat).mockRejectedValueOnce(
      new Error("Error invoking remote method 'side-chat:ask': Error: unknown working directory: /tmp/wt")
    )
    renderChat()
    await userEvent.click(sideKey())
    await ask('hm?')
    expect(await screen.findByText('Side question failed: unknown working directory: /tmp/wt')).toBeInTheDocument()
  })

  it('hands an answer to the composer, where the person edits it before it is sent', async () => {
    renderChat()
    await userEvent.click(sideKey())
    await ask('summary?')
    act(() => {
      emitSide({ turnId: 'side-turn-1', type: 'text', text: 'Use a backoff, not more retries.' })
      emitSide({ turnId: 'side-turn-1', type: 'done' })
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Add to message' }))
    const composer = screen.getByRole('textbox', { name: 'Message Claude' })
    expect(composer).toHaveValue('Use a backoff, not more retries.')
    expect(composer).toHaveFocus()
  })

  it('shares one slot with Work, keeps a half-typed question through Escape, and ⌘L toggles it', async () => {
    renderChat({
      log: [
        {
          role: 'assistant',
          kind: 'tool_call',
          toolName: 'TodoWrite',
          text: '{}',
          artifact: { kind: 'todos', items: [{ text: 'fix it', status: 'in_progress' }] }
        }
      ]
    })
    await userEvent.click(sideKey())
    await userEvent.type(question(), 'half a thought')
    await userEvent.click(screen.getByRole('button', { name: 'Work' }))
    expect(screen.queryByRole('complementary', { name: 'Side chat' })).not.toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Work' })).toBeInTheDocument()

    await userEvent.click(sideKey())
    expect(screen.queryByRole('complementary', { name: 'Work' })).not.toBeInTheDocument()
    expect(question()).toHaveValue('half a thought')
    // first Escape leaves the field for the thread, the second closes the panel and hands
    // focus back — two presses in a row, nothing between them
    await userEvent.keyboard('{Escape}')
    expect(document.activeElement).toBe(screen.getByRole('region', { name: 'Side questions and answers' }))
    expect(screen.getByRole('complementary', { name: 'Side chat' })).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('complementary', { name: 'Side chat' })).not.toBeInTheDocument()
    expect(sideKey()).toHaveFocus()

    await userEvent.keyboard('{Meta>}l{/Meta}')
    expect(question()).toHaveValue('half a thought')
    await userEvent.keyboard('{Meta>}l{/Meta}')
    expect(screen.queryByRole('complementary', { name: 'Side chat' })).not.toBeInTheDocument()
  })

  it('follows the id a resumed turn mints: the thread, the draft and the answer in flight stay', async () => {
    const meta: SessionMeta = {
      id: 'claude:sid-1',
      provider: 'claude',
      nativeId: 'sid-1',
      source: 'claude-default',
      title: 'Fix the login flake',
      cwd: '/tmp/wt',
      logBranch: 'cockpit/login-flake',
      startedAt: 1700000000000,
      updatedAt: 1700000600000,
      messageCount: 2,
      sourcePath: '/Users/me/.claude/projects/p/sid-1.jsonl'
    }
    vi.mocked(window.cockpit.pageSessions).mockResolvedValue({ total: 1, items: [meta] })
    let emitChat: (ev: ChatEvent) => void = () => {}
    vi.mocked(window.cockpit.onChatEvent).mockImplementation((cb) => {
      emitChat = cb
      return () => {}
    })
    render(<App />)
    const board = await screen.findByRole('region', { name: 'Session board' })
    await userEvent.click(await within(board).findByRole('button', { name: /Fix the login flake/ }))
    await userEvent.click(sideKey())
    await ask('why retries = 3?')
    await userEvent.type(question(), 'and the timeout')

    // a message in the chat's own composer resumes claude, which forks a new session id
    await userEvent.type(screen.getByRole('textbox', { name: 'Message Claude' }), 'go on{Enter}')
    await waitFor(() => expect(window.cockpit.sendChat).toHaveBeenCalledTimes(1))
    act(() => emitChat({ turnId: 'turn-1', type: 'session', nativeSessionId: 'sid-2' }))

    const panel = screen.getByRole('complementary', { name: 'Side chat' })
    expect(within(panel).getByText('why retries = 3?')).toBeInTheDocument()
    expect(within(panel).getByText('Claude is answering…')).toBeInTheDocument()
    expect(question()).toHaveValue('and the timeout')
    // still one question at a time: the one in flight is the one being answered
    expect(within(panel).getByRole('button', { name: 'Stop' })).toBeInTheDocument()
    act(() => {
      emitSide({ turnId: 'side-turn-1', type: 'text', text: 'Two retries still flaked under load.' })
      emitSide({ turnId: 'side-turn-1', type: 'done' })
    })
    expect(await within(panel).findByText('Two retries still flaked under load.')).toBeInTheDocument()
    // and the next question asks a copy of the conversation as it is now
    await userEvent.clear(question())
    await ask('and now?')
    expect(vi.mocked(window.cockpit.askSideChat).mock.calls[1][0]).toMatchObject({
      nativeSessionId: 'sid-2',
      history: [{ question: 'why retries = 3?', answer: 'Two retries still flaked under load.' }]
    })
  })
})
