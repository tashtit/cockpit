import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatView } from '../../src/renderer/src/ChatView'
import type { ChatBinding } from '../../src/renderer/src/App'
import type { SessionMessage } from '../../src/shared/types'

const binding: ChatBinding = {
  provider: 'claude',
  cwd: '/tmp/wt',
  nativeSessionId: 'abc',
  title: 'test session',
  branch: 'cockpit/test',
  repoRoot: '/tmp/repo'
}

const ask: SessionMessage = {
  role: 'assistant',
  kind: 'tool_call',
  toolName: 'AskUserQuestion',
  text: '{}',
  preview: 'Which owner?',
  asks: [
    {
      question: 'Which owner should the repo live under?',
      header: 'Owner',
      options: [
        { label: 'tashtit', description: 'the shared org' },
        { label: 'titan-ron', description: 'personal' }
      ]
    }
  ]
}

function renderChat(
  log: SessionMessage[],
  over: { busy?: boolean; binding?: ChatBinding } = {}
): ReturnType<typeof vi.fn> {
  const onSend = vi.fn()
  render(
    <ChatView
      binding={over.binding ?? binding}
      prs={[]}
      log={log}
      busy={over.busy ?? false}
      prBusy={false}
      onSend={onSend}
      onCancel={() => {}}
      onCreatePr={() => {}}
      onOpenUrl={() => {}}
      onOpenHandoff={() => {}}
      onOpenLineage={() => {}}
    />
  )
  return onSend
}

describe('AskPicker in the transcript', () => {
  it('renders the question and its options instead of a collapsed tool row', () => {
    renderChat([{ role: 'assistant', kind: 'text', text: 'One question first.' }, ask])
    expect(screen.getByText('Which owner should the repo live under?')).toBeTruthy()
    expect(screen.getByRole('radio', { name: /tashtit/ })).toBeTruthy()
    expect(screen.getByText('the shared org')).toBeTruthy()
    // the raw tool row is gone: the options are the message
    expect(screen.queryByText('AskUserQuestion')).toBeNull()
  })

  it('sends the pick as a message that repeats the question', async () => {
    const user = userEvent.setup()
    const onSend = renderChat([ask])
    const send = screen.getByRole('button', { name: 'Send answer' })
    expect((send as HTMLButtonElement).disabled).toBe(true)
    await user.click(screen.getByRole('radio', { name: /titan-ron/ }))
    await user.click(send)
    expect(onSend).toHaveBeenCalledWith(
      'Answering your question:\n- Which owner should the repo live under? → titan-ron',
      expect.any(String)
    )
  })

  it('takes several picks when the agent allows them, and every question needs one', async () => {
    const user = userEvent.setup()
    const multi: SessionMessage = {
      ...ask,
      asks: [
        { question: 'Where?', multiSelect: true, options: [{ label: 'Sign-in' }, { label: 'Empty states' }] },
        { question: 'When?', options: [{ label: 'Now' }, { label: 'Later' }] }
      ]
    }
    const onSend = renderChat([multi])
    await user.click(screen.getByRole('checkbox', { name: /Sign-in/ }))
    await user.click(screen.getByRole('checkbox', { name: /Empty states/ }))
    // the second question is still unanswered — nothing may go yet
    expect((screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement).disabled).toBe(true)
    await user.click(screen.getByRole('radio', { name: /Now/ }))
    await user.click(screen.getByRole('button', { name: 'Send answer' }))
    expect(onSend).toHaveBeenCalledWith(
      'Answering your questions:\n- Where? → Sign-in, Empty states\n- When? → Now',
      expect.any(String)
    )
  })

  it('an answered question is history — the tool row comes back', () => {
    renderChat([ask, { role: 'tool', kind: 'tool_result', text: 'Your questions have been answered' }])
    expect(screen.queryByRole('button', { name: 'Send answer' })).toBeNull()
    expect(screen.getByText('AskUserQuestion')).toBeTruthy()
  })

  it('a question the conversation moved past is history too', () => {
    renderChat([ask, { role: 'assistant', kind: 'text', text: 'Never mind, I worked it out.' }])
    expect(screen.queryByRole('button', { name: 'Send answer' })).toBeNull()
  })

  it('a running turn shows the options but cannot send them', () => {
    renderChat([ask], { busy: true })
    expect((screen.getByRole('radio', { name: /tashtit/ }) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('a read-only seat session gets no picker — the table owns its conversation', () => {
    renderChat([ask], { binding: { ...binding, readOnly: true } })
    expect(screen.queryByRole('button', { name: 'Send answer' })).toBeNull()
    expect(screen.getByText('AskUserQuestion')).toBeTruthy()
  })
})
