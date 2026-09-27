import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatView } from '../../src/renderer/src/ChatView'
import { addChatMessage, setChatLog } from '../../src/renderer/src/chat-log'
import type { ChatBinding } from '../../src/renderer/src/chat-binding'
import type { SessionMessage } from '../../src/shared/types'

const binding: ChatBinding = {
  provider: 'claude',
  cwd: '/tmp/wt',
  nativeSessionId: 'abc',
  title: 'fix the flake',
  branch: 'cockpit/fix',
  repoRoot: '/tmp/repo'
}

const ask = (text: string): SessionMessage => ({ role: 'user', kind: 'text', text })
const say = (text: string): SessionMessage => ({ role: 'assistant', kind: 'text', text })

/** A log of `n` replies with the person's messages at `at` (a log read fresh keys each row by its offset) */
function logWith(n: number, at: readonly number[]): SessionMessage[] {
  return Array.from({ length: n }, (_, i) => (at.includes(i) ? ask(`question ${i}`) : say(`answer line ${i}`)))
}

function renderChat(log: SessionMessage[]): HTMLElement {
  setChatLog(log)
  render(
    <ChatView
      binding={binding}
      prs={[]}
      busy={false}
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
  return document.querySelector<HTMLElement>('.messages')!
}

const ROW = 100
const VIEW = 600

/**
 * jsdom has no layout: the row under log key k starts 16px + k rows down the transcript
 * (its top padding, then 100px a row), and the scroller clamps like a real one.
 */
function layOut(messages: HTMLElement, rows: number): { readonly end: number } {
  const height = 32 + rows * ROW
  let top = 0
  Object.defineProperty(messages, 'clientHeight', { value: VIEW, configurable: true })
  Object.defineProperty(messages, 'scrollHeight', { value: height, configurable: true })
  Object.defineProperty(messages, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => {
      top = Math.max(0, Math.min(height - VIEW, v))
    }
  })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const key = this.getAttribute('data-log-key')
    const y = key === null ? 0 : 16 + Number(key) * ROW - top
    return { top: y, bottom: y + ROW, left: 0, right: 0, width: 0, height: ROW, x: 0, y, toJSON: () => ({}) }
  })
  return { end: height - VIEW }
}

/** The reader scrolls to `top` */
function scrollTo(messages: HTMLElement, top: number): void {
  messages.scrollTop = top
  fireEvent.scroll(messages)
}

const mark = (n: number, of: number): HTMLElement =>
  screen.getByRole('button', { name: new RegExp(`^Message ${n} of ${of}:`) })

const stepKey = (key: 'ArrowUp' | 'ArrowDown'): void => {
  fireEvent.keyDown(window, { key, altKey: true, metaKey: true })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the rail of your own messages', () => {
  it('marks each message once there are two to move between, named by its words', () => {
    renderChat([ask('fix the login flake'), say('on it')])
    expect(screen.queryByRole('navigation', { name: 'Your messages' })).not.toBeInTheDocument()
    act(() => addChatMessage(ask('now add a regression test')))
    const rail = screen.getByRole('navigation', { name: 'Your messages' })
    expect(rail.querySelectorAll('button')).toHaveLength(2)
    expect(mark(1, 2)).toHaveAccessibleName('Message 1 of 2: fix the login flake')
    expect(mark(2, 2)).toHaveAccessibleName('Message 2 of 2: now add a regression test')
    expect(document.querySelector('.chat-transcript')).toHaveClass('railed')
  })

  it('a mark takes the transcript to its message, at the top, and marks it as the one being read', async () => {
    const messages = renderChat(logWith(12, [0, 4, 8]))
    const { end } = layOut(messages, 12)
    scrollTo(messages, end)
    // at the end of the transcript the latest message is the one being read
    await waitFor(() => expect(mark(3, 3)).toHaveAttribute('aria-current', 'location'))
    await userEvent.click(mark(2, 3))
    // row 4 starts 16 + 400 down: it lands 16px under the top edge, as the first row does
    expect(messages.scrollTop).toBe(400)
    expect(mark(2, 3)).toHaveAttribute('aria-current', 'location')
    expect(mark(3, 3)).not.toHaveAttribute('aria-current')
    // and the one being read follows the reader's own scroll
    scrollTo(messages, 0)
    await waitFor(() => expect(mark(1, 3)).toHaveAttribute('aria-current', 'location'))
  })

  it('shows the message a mark stands for on pointing at it', async () => {
    renderChat(logWith(6, [0, 3]))
    await userEvent.hover(mark(1, 2))
    expect(document.querySelector('.prompt-peek')).toHaveTextContent('1 of 2')
    expect(document.querySelector('.prompt-peek')).toHaveTextContent('question 0')
    await userEvent.unhover(mark(1, 2))
    expect(document.querySelector('.prompt-peek')).toBeNull()
  })

  it('is one tab stop whose arrow keys walk the messages from the one being read', async () => {
    const messages = renderChat(logWith(12, [0, 4, 8]))
    const { end } = layOut(messages, 12)
    scrollTo(messages, end)
    await waitFor(() => expect(mark(3, 3)).toHaveAttribute('tabindex', '0'))
    expect(mark(1, 3)).toHaveAttribute('tabindex', '-1')
    mark(3, 3).focus()
    await userEvent.keyboard('{ArrowUp}')
    expect(mark(2, 3)).toHaveFocus()
    expect(messages.scrollTop).toBe(400)
    await userEvent.keyboard('{Home}')
    expect(mark(1, 3)).toHaveFocus()
    expect(messages.scrollTop).toBe(0)
    await userEvent.keyboard('{End}')
    expect(mark(3, 3)).toHaveFocus()
  })
})

describe('⌥⌘↑ and ⌥⌘↓', () => {
  it('step through your messages from wherever you are, and say where they landed', async () => {
    const messages = renderChat(logWith(12, [0, 4, 8]))
    const { end } = layOut(messages, 12)
    scrollTo(messages, end)
    const status = screen.getByRole('status')
    stepKey('ArrowUp')
    // the latest message is on screen below the top: up is the one before it
    expect(messages.scrollTop).toBe(400)
    expect(status).toHaveTextContent('Your message 2 of 3')
    stepKey('ArrowUp')
    expect(messages.scrollTop).toBe(0)
    expect(status).toHaveTextContent('Your message 1 of 3')
    stepKey('ArrowUp')
    expect(messages.scrollTop).toBe(0)
    expect(status).toHaveTextContent('No earlier message of yours')
    stepKey('ArrowDown')
    stepKey('ArrowDown')
    // the latest cannot reach the top — the transcript ends first — and it is still the
    // one a step goes on from
    expect(messages.scrollTop).toBe(end)
    expect(status).toHaveTextContent('Your message 3 of 3')
    await waitFor(() => expect(mark(3, 3)).toHaveAttribute('aria-current', 'location'))
    stepKey('ArrowDown')
    expect(status).toHaveTextContent('No later message of yours')
  })

  it('go back to the start of the message whose answer you are part-way through', () => {
    const messages = renderChat(logWith(20, [0, 4, 15]))
    layOut(messages, 20)
    // reading row 7: message 2 (row 4) started above the top edge
    scrollTo(messages, 700)
    stepKey('ArrowUp')
    expect(messages.scrollTop).toBe(400)
    expect(screen.getByRole('status')).toHaveTextContent('Your message 2 of 3')
  })

  it('bring a message older than the DOM window into it and land on it', () => {
    const messages = renderChat(logWith(500, [10, 450]))
    layOut(messages, 500)
    // the window opens on the newest 400 rows: row 10 is not in the DOM
    expect(document.querySelector('[data-log-key="10"]')).toBeNull()
    // message 2 (row 450) at the top: up is message 1
    scrollTo(messages, 45_000)
    stepKey('ArrowUp')
    expect(document.querySelector('[data-log-key="10"]')).not.toBeNull()
    expect(messages.scrollTop).toBe(1_000)
    expect(mark(1, 2)).toHaveAttribute('aria-current', 'location')
  })

  it('leave the keys alone while the review has the transcript’s place', async () => {
    const messages = renderChat(logWith(12, [0, 4, 8]))
    layOut(messages, 12)
    await userEvent.click(screen.getByRole('button', { name: 'Changes' }))
    const key = new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, metaKey: true, cancelable: true })
    window.dispatchEvent(key)
    expect(key.defaultPrevented).toBe(false)
    expect(screen.getByRole('status')).not.toHaveTextContent('Your message')
  })
})
