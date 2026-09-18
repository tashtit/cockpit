import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { ChatView } from '../../src/renderer/src/ChatView'
import type { ChatBinding } from '../../src/renderer/src/chat-binding'
import {
  addChatMessage,
  addChatNotice,
  announceChat,
  endChatStream,
  setChatLog,
  streamChatText
} from '../../src/renderer/src/chat-log'

const binding: ChatBinding = {
  provider: 'claude',
  cwd: '/tmp/wt',
  nativeSessionId: 'abc',
  title: 'fix the flake',
  branch: 'cockpit/fix',
  repoRoot: '/tmp/repo'
}

function renderChat(busy = false): void {
  render(
    <ChatView
      binding={binding}
      prs={[]}
      busy={busy}
      prBusy={false}
      onSend={vi.fn()}
      onCancel={vi.fn()}
      onCreatePr={vi.fn()}
      onOpenUrl={vi.fn()}
      onOpenHandoff={vi.fn()}
      onOpenLineage={vi.fn()}
      permissions={[]}
      onAnswerPermission={vi.fn()}
    />
  )
}

const status = (): string => screen.getByRole('status', { hidden: true }).textContent ?? ''
/** The transcript alone — a notice is also in the sr-only status region. */
const transcript = (): ReturnType<typeof within> =>
  within(document.querySelector('.messages') as HTMLElement)

describe('chat transcript store', () => {
  it('folds streamed chunks into one assistant row', async () => {
    renderChat(true)
    streamChatText('Let me ')
    streamChatText('reproduce it.')
    await waitFor(() => expect(screen.getByText('Let me reproduce it.')).toBeInTheDocument())
  })

  it('keeps the streamed text when the turn ends', async () => {
    renderChat(true)
    streamChatText('half a thought')
    endChatStream({ keepText: true })
    await waitFor(() => expect(screen.getByText('half a thought')).toBeInTheDocument())
  })

  it('drops a cancelled turn’s unflushed text — it never arrived', async () => {
    renderChat(true)
    streamChatText('half a thought')
    endChatStream({ keepText: false })
    await waitFor(() => expect(screen.queryByText('half a thought')).not.toBeInTheDocument())
  })

  it('orders a buffered chunk before the row that follows it', async () => {
    renderChat(true)
    streamChatText('I will run the tests.')
    addChatMessage({ role: 'assistant', kind: 'tool_call', toolName: 'Bash', text: 'npm test' })
    await waitFor(() => expect(screen.getByText('I will run the tests.')).toBeInTheDocument())
    const rows = screen.getByText('I will run the tests.').closest('.messages')?.textContent ?? ''
    expect(rows.indexOf('I will run the tests.')).toBeLessThan(rows.indexOf('npm test'))
  })
})

describe('what a screen reader hears', () => {
  it('says nothing about a system row the user has already passed', async () => {
    // the bug this replaces: the status region mirrored the last system row, so
    // every turn end re-announced the worktree notice from the top of the session
    setChatLog([
      { role: 'system', kind: 'system', text: 'Worktree ready on cockpit/fix — running isolated.' },
      { role: 'user', kind: 'text', text: 'go' }
    ])
    renderChat(true)
    announceChat('Claude finished')
    await waitFor(() => expect(status()).toBe('Claude finished'))
    expect(status()).not.toMatch(/Worktree ready/)
  })

  it('announces a notice once, when it happens', async () => {
    renderChat()
    addChatNotice('PR created: https://example.test/pr/1')
    await waitFor(() => expect(status()).toBe('PR created: https://example.test/pr/1'))
    // …and the same words are in the transcript
    expect(transcript().getByText('PR created: https://example.test/pr/1')).toBeInTheDocument()
  })

  it('can say something different from the row it adds', async () => {
    renderChat()
    addChatNotice('spawn failed: ENOENT', 'Claude: spawn failed: ENOENT')
    await waitFor(() => expect(status()).toBe('Claude: spawn failed: ENOENT'))
    expect(transcript().getByText('spawn failed: ENOENT')).toBeInTheDocument()
  })

  it('goes quiet when another session is opened', async () => {
    renderChat()
    announceChat('Claude finished')
    await waitFor(() => expect(status()).toBe('Claude finished'))
    setChatLog([{ role: 'user', kind: 'text', text: 'a different conversation' }])
    await waitFor(() => expect(status()).toBe(''))
  })
})
