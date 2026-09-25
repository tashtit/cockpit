import { describe, it, expect, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import { ChatView } from '../../src/renderer/src/ChatView'
import type { ChatBinding } from '../../src/renderer/src/chat-binding'
import {
  addChatMessage,
  addChatNotice,
  announceChat,
  endChatStream,
  reconcileLog,
  refreshChatLog,
  setChatLog,
  streamChatText
} from '../../src/renderer/src/chat-log'
import type { SessionMessage } from '../../src/shared/types'

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
      elsewhere={false}
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

/** A log's rows as a disk read hands them over: fresh objects, whatever they say. */
const reread = (rows: readonly SessionMessage[]): SessionMessage[] => rows.map((m) => structuredClone(m))
const line = (i: number): SessionMessage => ({ role: 'assistant', kind: 'text', text: `reply ${i}`, ts: 1_000 + i })
const OMITTED: SessionMessage = { role: 'system', kind: 'system', text: '(older messages omitted — transcript is very large)' }

describe('a log read again from disk', () => {
  const first = { messages: [line(0), line(1), line(2)], keys: [0, 1, 2] }

  it('comes back as the rows on screen when it says nothing new', () => {
    const out = reconcileLog(first, reread(first.messages), 3)
    expect(out.messages).toBe(first.messages)
    expect(out.keys).toBe(first.keys)
    expect(out.nextKey).toBe(3)
  })

  it('keeps every row it shares — object and key — and keys what is new after them', () => {
    const out = reconcileLog(first, reread([...first.messages, line(3)]), 3)
    first.messages.forEach((m, i) => expect(out.messages[i]).toBe(m))
    expect(out.keys).toEqual([0, 1, 2, 3])
    expect(out.nextKey).toBe(4)
  })

  it('past the tail window, keeps the keys of the rows that survive the front being dropped', () => {
    // main reads the last 4MB: a longer log starts further in, under the omitted notice
    const before = { messages: [OMITTED, ...Array.from({ length: 20 }, (_, i) => line(i))], keys: [...Array(21).keys()] }
    const after = reread([OMITTED, ...Array.from({ length: 14 }, (_, i) => line(i + 6)), line(20), line(21)])
    const out = reconcileLog(before, after, 21)
    expect(out.messages[0]).toBe(before.messages[0])
    // `reply 6` was row 7 on screen, and keeps the key it rendered under
    expect(out.keys.slice(0, 3)).toEqual([0, 7, 8])
    expect(out.messages[1]).toBe(before.messages[7])
    expect(out.keys.slice(-2)).toEqual([21, 22])
  })

  it('lets a row rewritten in place keep its key with its new words, and keys an inserted one anew', () => {
    const call: SessionMessage = { role: 'assistant', kind: 'tool_call', toolName: 'Bash', text: 'npm test', ts: 5 }
    const before = { messages: [line(0), call, line(2)], keys: [0, 1, 2] }
    const failed = reconcileLog(before, reread([line(0), { ...call, failed: true }, line(2)]), 3)
    expect(failed.keys).toEqual([0, 1, 2])
    expect(failed.messages[1]).toMatchObject({ failed: true })
    expect(failed.messages[2]).toBe(before.messages[2])
    const inserted = reconcileLog(before, reread([line(0), line(1), call, line(2)]), 3)
    expect(inserted.keys).toEqual([0, 3, 1, 2])
  })

  it('leaves what the reader opened on a row where it was, while the window slides under it', async () => {
    // prose between the calls, so no run of them folds away
    const turn = (i: number): SessionMessage[] => [
      line(i),
      { role: 'assistant', kind: 'tool_call', toolName: 'Bash', text: `step ${i}`, ts: 2_000 + i }
    ]
    setChatLog([OMITTED, ...Array.from({ length: 12 }, (_, i) => turn(i)).flat()])
    renderChat()
    const preview = (): HTMLElement => screen.getByText('step 9', { selector: 'code' })
    const row = preview().closest('details')!
    row.open = true
    const key = row.getAttribute('data-log-key')
    act(() => refreshChatLog(reread([OMITTED, ...Array.from({ length: 8 }, (_, i) => turn(i + 4)).flat(), line(99)])))
    await waitFor(() => expect(screen.getByText('reply 99')).toBeInTheDocument())
    expect(screen.queryByText('reply 0')).not.toBeInTheDocument()
    // the same element, still open, under the same key
    expect(preview().closest('details')).toBe(row)
    expect(row.open).toBe(true)
    expect(row.getAttribute('data-log-key')).toBe(key)
  })
})
