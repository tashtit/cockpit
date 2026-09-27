import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatView } from '../../src/renderer/src/ChatView'
import { setChatLog } from '../../src/renderer/src/chat-log'
import type { ChatBinding } from '../../src/renderer/src/chat-binding'
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
  over: { busy?: boolean; elsewhere?: boolean; binding?: ChatBinding } = {}
): ReturnType<typeof vi.fn> {
  const onSend = vi.fn()
  setChatLog(log)
  render(
    <ChatView
      binding={over.binding ?? binding}
      prs={[]}
      busy={over.busy ?? false}
      elsewhere={over.elsewhere ?? false}
      prBusy={false}
      onSend={onSend}
      onCancel={() => {}}
      onCreatePr={() => {}}
      onOpenUrl={() => {}}
      onOpenHandoff={() => {}}
      onOpenLineage={() => {}}
      permissions={[]}
      onAnswerPermission={() => {}}
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

  it('Other takes an answer of your own when none of the offered ones fits', async () => {
    const user = userEvent.setup()
    const onSend = renderChat([ask])
    const send = screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement
    await user.click(screen.getByRole('radio', { name: /Other/ }))
    const own = screen.getByRole('textbox', { name: /Your own answer to: Which owner/ })
    // opened because it was asked for: typing goes straight in
    expect(own).toHaveFocus()
    // picked but empty is no answer yet
    expect(send.disabled).toBe(true)
    await user.type(own, 'Neither — keep it in a fork for now')
    expect(send.disabled).toBe(false)
    await user.click(send)
    expect(onSend).toHaveBeenCalledWith(
      'Answering your question:\n- Which owner should the repo live under? → Neither — keep it in a fork for now',
      expect.any(String)
    )
  })

  it('a single answer is one answer: an offered pick sets the written one aside, and back', async () => {
    const user = userEvent.setup()
    const onSend = renderChat([ask])
    await user.click(screen.getByRole('radio', { name: /Other/ }))
    await user.type(screen.getByRole('textbox', { name: /Your own answer/ }), 'a fork')
    await user.click(screen.getByRole('radio', { name: /tashtit/ }))
    expect(screen.queryByRole('textbox', { name: /Your own answer/ })).toBeNull()
    expect((screen.getByRole('radio', { name: /Other/ }) as HTMLInputElement).checked).toBe(false)
    // what was written is kept for when Other is picked again
    await user.click(screen.getByRole('radio', { name: /Other/ }))
    expect((screen.getByRole('radio', { name: /tashtit/ }) as HTMLInputElement).checked).toBe(false)
    const own = screen.getByRole('textbox', { name: /Your own answer/ })
    expect(own).toHaveValue('a fork')
    // Enter sends, as it does in the composer; Shift+Enter is a new line
    await user.type(own, '{Shift>}{Enter}{/Shift}for now{Enter}')
    expect(onSend).toHaveBeenCalledWith(
      'Answering your question:\n- Which owner should the repo live under? → a fork\n  for now',
      expect.any(String)
    )
  })

  it('on a pick-any question Other is one more answer beside the offered ones', async () => {
    const user = userEvent.setup()
    const multi: SessionMessage = {
      ...ask,
      asks: [{ question: 'Where?', multiSelect: true, options: [{ label: 'Sign-in' }, { label: 'Empty states' }] }]
    }
    const onSend = renderChat([multi])
    await user.click(screen.getByRole('checkbox', { name: /Sign-in/ }))
    await user.click(screen.getByRole('checkbox', { name: /Other/ }))
    await user.type(screen.getByRole('textbox', { name: /Your own answer/ }), 'the settings page')
    await user.click(screen.getByRole('button', { name: 'Send answer' }))
    expect(onSend).toHaveBeenCalledWith('Answering your question:\n- Where? → Sign-in, the settings page', expect.any(String))
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
    expect((screen.getByRole('radio', { name: /Other/ }) as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('a question still open in a terminal says to answer it there, not that the agent is working', () => {
    renderChat([ask], { elsewhere: true })
    expect((screen.getByRole('button', { name: 'Send answer' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/waiting for this in a terminal or its own app — answer it there/)).toBeTruthy()
    expect(screen.queryByText(/is working elsewhere/)).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('Claude is waiting for your answer elsewhere…')
  })

  it('a read-only seat session gets no picker — the table owns its conversation', () => {
    renderChat([ask], { binding: { ...binding, readOnly: 'seat' } })
    expect(screen.queryByRole('button', { name: 'Send answer' })).toBeNull()
    expect(screen.getByText('AskUserQuestion')).toBeTruthy()
  })
})
