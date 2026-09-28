import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatView } from '../../src/renderer/src/ChatView'
import type { ChatBinding } from '../../src/renderer/src/chat-binding'
import type { PrStatus, SessionControl, SessionHolder, SessionMessage } from '../../src/shared/types'
import { addChatMessage, setChatLog } from '../../src/renderer/src/chat-log'
import type { TranscriptAnchor } from '../../src/renderer/src/chat-binding'
import { pasteImage, stubObjectUrls } from './paste'
import { openPr } from './stub-api'

const binding: ChatBinding = {
  provider: 'claude',
  cwd: '/tmp/wt',
  nativeSessionId: null,
  title: 'test session',
  branch: 'cockpit/test',
  repoRoot: '/tmp/repo'
}

function renderChat(
  onSend = vi.fn(),
  over: {
    binding?: ChatBinding
    busy?: boolean
    elsewhere?: boolean
    prs?: PrStatus[]
    anchor?: TranscriptAnchor
    control?: SessionControl | null
    onSetHolder?: (holder: SessionHolder) => Promise<boolean>
    onResumeInTerminal?: () => Promise<boolean>
  } = {}
): { onSend: ReturnType<typeof vi.fn>; onOpenHandoff: ReturnType<typeof vi.fn>; onOpenLineage: ReturnType<typeof vi.fn> } {
  const onOpenHandoff = vi.fn()
  const onOpenLineage = vi.fn()
  render(
    <ChatView
      binding={over.binding ?? binding}
      prs={over.prs ?? []}
      busy={over.busy ?? false}
      elsewhere={over.elsewhere ?? false}
      prBusy={false}
      onSend={onSend}
      onCancel={() => {}}
      onCreatePr={() => {}}
      onOpenUrl={() => {}}
      onOpenHandoff={onOpenHandoff}
      onOpenLineage={onOpenLineage}
      permissions={[]}
      onAnswerPermission={vi.fn()}
      control={over.control ?? null}
      onSetHolder={over.onSetHolder}
      onResumeInTerminal={over.onResumeInTerminal}
      anchor={over.anchor ?? null}
    />
  )
  return { onSend, onOpenHandoff, onOpenLineage }
}

/** A transcript of `n` numbered assistant lines, the newest last */
function longLog(n: number): SessionMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: 'assistant' as const,
    kind: 'text' as const,
    text: `line ${i} of the transcript`,
    ts: 1_000 + i
  }))
}

/** jsdom has no layout: give the scroller a height so "at the bottom" can be false */
function scrollAway(el: HTMLElement, { top = 0 }: { top?: number } = {}): void {
  Object.defineProperty(el, 'scrollHeight', { value: 5000, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: 600, configurable: true })
  Object.defineProperty(el, 'scrollTop', { value: top, writable: true, configurable: true })
  fireEvent.scroll(el)
}

beforeEach(() => {
  stubObjectUrls()
})

describe('ChatView handoff affordances', () => {
  const started: ChatBinding = { ...binding, nativeSessionId: 'abc-123' }

  it('shows Continue in… only once the session has a native id', () => {
    renderChat()
    expect(screen.queryByRole('button', { name: /Continue in/ })).not.toBeInTheDocument()
  })

  it('fires onOpenHandoff from the header button when idle', async () => {
    const { onOpenHandoff } = renderChat(vi.fn(), { binding: started })
    await userEvent.click(screen.getByRole('button', { name: /Continue in/ }))
    expect(onOpenHandoff).toHaveBeenCalledOnce()
  })

  it('disables the handoff button while a turn is streaming', () => {
    renderChat(vi.fn(), { binding: started, busy: true })
    expect(screen.getByRole('button', { name: /Continue in/ })).toBeDisabled()
  })

  it('holds Send while the session runs elsewhere, and says so', async () => {
    const { onSend } = renderChat(vi.fn(), { binding: started, elsewhere: true })
    // the annunciator names the agent, not Cockpit's own turn — on screen and for a reader
    expect(screen.getByText(/Claude is working elsewhere/, { ignore: '.sr-only' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Claude is working elsewhere…')
    expect(screen.queryByText(/Send a prompt to start this session/)).not.toBeInTheDocument()
    const send = screen.getByRole('button', { name: 'Send' })
    expect(send).toBeDisabled()
    expect(send).toHaveAttribute('title', expect.stringMatching(/waits for that turn/))
    // a draft can be typed, but Enter does not send it
    await userEvent.type(screen.getByRole('textbox', { name: 'Message Claude' }), 'wait for me{Enter}')
    expect(onSend).not.toHaveBeenCalled()
    expect(send).toBeDisabled()
  })

  it('shows one annunciator at a time: a turn of its own outranks elsewhere', () => {
    renderChat(vi.fn(), { binding: started, busy: true, elsewhere: true })
    expect(screen.getByText(/Claude is working…/, { ignore: '.sr-only' })).toBeInTheDocument()
    expect(screen.queryByText(/Claude is working elsewhere/, { ignore: '.sr-only' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
  })

  it('renders the lineage chip and navigates to the source session', async () => {
    const withLineage: ChatBinding = {
      ...started,
      continuedFrom: { id: 'claude:src-1', provider: 'claude' }
    }
    const { onOpenLineage } = renderChat(vi.fn(), { binding: withLineage })
    const chip = screen.getByRole('button', { name: /Continued from a Claude session/ })
    await userEvent.click(chip)
    expect(onOpenLineage).toHaveBeenCalledWith('claude:src-1')
  })

  it('shows no lineage chip on ordinary sessions', () => {
    renderChat(vi.fn(), { binding: started })
    expect(
      screen.queryByRole('button', { name: /Continued from/ })
    ).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Started by/ })).not.toBeInTheDocument()
  })

  it('names the session that started this one and opens it', async () => {
    const child: ChatBinding = {
      ...started,
      provider: 'copilot',
      startedBy: { id: 'copilot:parent-1', provider: 'copilot', title: 'Free plan limits' }
    }
    const { onOpenLineage } = renderChat(vi.fn(), { binding: child })
    const chip = screen.getByRole('button', { name: 'Started by the Copilot session “Free plan limits” — open it' })
    expect(chip).toHaveTextContent('by Free plan limits')
    await userEvent.click(chip)
    expect(onOpenLineage).toHaveBeenCalledWith('copilot:parent-1')
  })
})

describe('ChatView on a session of an agent Cockpit only reads', () => {
  const cursor: ChatBinding = { ...binding, provider: 'cursor', nativeSessionId: 'cur-1', readOnly: 'agent' }

  it('says why there is no composer, and offers the way on', async () => {
    const { onOpenHandoff } = renderChat(vi.fn(), { binding: cursor })
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByText(/Cockpit runs Cursor only over its ACP server/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Continue it with another agent…' }))
    // the header keeps its own handoff key too — a session to continue is exactly this
    await userEvent.click(screen.getByRole('button', { name: 'Continue in another agent…' }))
    expect(onOpenHandoff).toHaveBeenCalledTimes(2)
  })

  it('offers no take-over: Cockpit has no CLI of that agent’s to drive it with', () => {
    renderChat(vi.fn(), { binding: cursor, control: { holder: 'agent', how: 'outside' } })
    expect(screen.queryByRole('region', { name: 'Who drives this session' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Take over/ })).not.toBeInTheDocument()
    expect(document.querySelector('.hold-chip')).toBeNull()
  })

  it('once an ACP agent drives it: a composer, taken over like any, never a Terminal resume', async () => {
    const gemini: ChatBinding = { ...binding, provider: 'gemini', nativeSessionId: 'g-1' }
    const onSetHolder = vi.fn(async () => true)
    renderChat(vi.fn(), { binding: gemini, control: { holder: 'agent', how: 'outside' }, onSetHolder })
    expect(screen.getByRole('textbox', { name: 'Message Gemini' })).toBeInTheDocument()
    // it runs as whoever it is signed in as — Cockpit claims no account for it
    expect(document.querySelector('.chat-header .acct-chip.acct-gemini:not(.hold-chip)')).toBeNull()
    const bar = screen.getByRole('region', { name: 'Who drives this session' })
    expect(bar).not.toHaveTextContent('Open in Terminal')
    await userEvent.click(screen.getByRole('button', { name: 'Take over' }))
    expect(onSetHolder).toHaveBeenCalledWith('cockpit')
  })

  it('a roundtable seat stays the table’s: no handoff anywhere', () => {
    renderChat(vi.fn(), { binding: { ...binding, nativeSessionId: 'seat-1', readOnly: 'seat' } })
    expect(screen.getByText(/Talk to it at the table/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Continue in/ })).not.toBeInTheDocument()
  })
})

describe('ChatView image paste', () => {
  it('saves a pasted image via the api and shows a removable chip', async () => {
    renderChat()
    const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' })
    pasteImage(screen.getByRole('textbox'), file)

    await waitFor(() => expect(screen.getByText('shot.png')).toBeInTheDocument())
    expect(window.cockpit.saveChatImage).toHaveBeenCalledWith(expect.any(Uint8Array), 'image/png')

    await userEvent.click(screen.getByRole('button', { name: 'Remove shot.png' }))
    expect(screen.queryByText('shot.png')).not.toBeInTheDocument()
  })

  it('sends attached image paths with the prompt and clears the chips', async () => {
    const { onSend } = renderChat()
    const file = new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' })
    pasteImage(screen.getByRole('textbox'), file)
    await waitFor(() => expect(screen.getByText('shot.png')).toBeInTheDocument())

    await userEvent.type(screen.getByRole('textbox'), 'what is this?')
    await userEvent.click(screen.getByRole('button', { name: 'Send' }))

    expect(onSend).toHaveBeenCalledWith('what is this?', expect.any(String), [
      '/tmp/chat-images/img.png'
    ])
    expect(screen.queryByText('shot.png')).not.toBeInTheDocument()
  })

  it('allows sending an image with no text', async () => {
    const { onSend } = renderChat()
    const send = screen.getByRole('button', { name: 'Send' })
    expect(send).toBeDisabled()

    pasteImage(screen.getByRole('textbox'), new File([new Uint8Array([1])], 'shot.png', { type: 'image/png' }))
    await waitFor(() => expect(send).toBeEnabled())

    await userEvent.click(send)
    expect(onSend).toHaveBeenCalledWith('', expect.any(String), ['/tmp/chat-images/img.png'])
  })

  it('surfaces a save failure without attaching a chip', async () => {
    vi.mocked(window.cockpit.saveChatImage).mockRejectedValue(
      new Error("Error invoking remote method 'chat:save-image': Error: Image too large — the limit is 10MB.")
    )
    renderChat()
    pasteImage(screen.getByRole('textbox'), new File([new Uint8Array([1])], 'big.png', { type: 'image/png' }))

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Image too large — the limit is 10MB.')
    )
    expect(screen.queryByText('big.png')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled()
  })

  it('ignores plain-text paste', () => {
    renderChat()
    fireEvent.paste(screen.getByRole('textbox'), {
      clipboardData: { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] }
    })
    expect(window.cockpit.saveChatImage).not.toHaveBeenCalled()
  })
})

describe('ChatView review', () => {
  it('swaps the transcript for the changes and back, by button and by ⌘D', async () => {
    renderChat()
    expect(screen.queryByRole('region', { name: 'Changes to review' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Changes' }))
    expect(screen.getByRole('region', { name: 'Changes to review' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Changes' })).toHaveAttribute('aria-pressed', 'true')
    expect(window.cockpit.getWorkspaceDiff).toHaveBeenCalledWith('/tmp/wt', 'branch')
    // the composer stays: notes go to the agent through it
    expect(screen.getByRole('textbox', { name: 'Message Claude' })).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'd', metaKey: true })
    expect(screen.queryByRole('region', { name: 'Changes to review' })).not.toBeInTheDocument()
  })

  it('has nothing to review outside a repository or on a seat session', () => {
    renderChat(vi.fn(), { binding: { ...binding, repoRoot: null } })
    expect(screen.queryByRole('button', { name: 'Changes' })).not.toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'd', metaKey: true })
    expect(screen.queryByRole('region', { name: 'Changes to review' })).not.toBeInTheDocument()
  })

  it('drops review notes into the composer, appended to what was typed', async () => {
    vi.mocked(window.cockpit.getWorkspaceDiff).mockResolvedValue({
      cwd: '/tmp/wt',
      scope: 'branch',
      branch: 'cockpit/test',
      base: 'origin/main',
      ahead: 1,
      behind: 0,
      dirty: false,
      added: 1,
      removed: 0,
      droppedFiles: 0,
      files: [
        {
          path: 'a.ts',
          oldPath: null,
          status: 'modified',
          untracked: false,
          binary: false,
          added: 1,
          removed: 0,
          truncated: false,
          hunks: [
            { header: '', oldStart: 1, oldCount: 0, newStart: 1, newCount: 1, lines: [{ op: 'add', text: 'x', oldNo: null, newNo: 1 }] }
          ]
        }
      ]
    })
    const { onSend } = renderChat()
    const composer = screen.getByRole('textbox', { name: 'Message Claude' })
    await userEvent.type(composer, 'also:')
    await userEvent.click(screen.getByRole('button', { name: 'Changes' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Note on a.ts line 1' }))
    await userEvent.type(screen.getByRole('textbox', { name: /Note for the agent/ }), 'use y{Enter}')
    await userEvent.click(screen.getByRole('button', { name: 'Send 1 note to Claude' }))
    expect(composer).toHaveFocus()
    const value = (composer as HTMLTextAreaElement).value
    expect(value.startsWith('also:\n\nReview notes on the changes in this worktree on cockpit/test (vs origin/main):')).toBe(true)
    expect(value).toContain('1. a.ts:1')
    // and the review stays open for the next round; Enter sends as usual
    expect(screen.getByRole('region', { name: 'Changes to review' })).toBeInTheDocument()
    await userEvent.type(composer, '{Enter}')
    expect(onSend).toHaveBeenCalledOnce()
    expect(onSend.mock.calls[0][0]).toContain('use y')
  })
})

describe('ChatView header PR badge', () => {
  it('shows the branch PR in full, with its checks verdict and review outcome', () => {
    renderChat(vi.fn(), {
      prs: [openPr({ headRefName: binding.branch ?? '', checks: 'pending', review: 'approved' })]
    })
    const badge = screen.getByRole('button', { name: /pull request #42/ })
    // the full badge spells the state out; checks and review still ride the name
    expect(badge).toHaveTextContent(/^Open #42$/)
    expect(badge).toHaveAccessibleName(
      'Open pull request #42: Fix the login flake, checks pending, approved'
    )
    expect(badge.querySelector('.pr-checks.pending')).not.toBeNull()
    expect(badge.querySelector('.pr-review-mark')).toBeNull()
    expect(badge.querySelector('.pr-threads')).toBeNull()
    expect(screen.queryByRole('button', { name: /Create PR/ })).not.toBeInTheDocument()
  })

  it('shows how many review threads are waiting on a reply, after the state word', () => {
    renderChat(vi.fn(), {
      prs: [
        openPr({ headRefName: binding.branch ?? '', checks: 'failing', review: 'changes_requested', unresolvedThreads: 12 })
      ]
    })
    const badge = screen.getByRole('button', { name: /pull request #42/ })
    expect(badge).toHaveTextContent(/^Open #4212$/)
    // state, number, then the marks: checks verdict, threads, the changes-requested dot
    expect(Array.from(badge.children, (el) => el.getAttribute('class')?.split(' ')[0] ?? el.tagName)).toEqual([
      'svg',
      'pr-word',
      'pr-checks',
      'pr-threads',
      'pr-review-mark'
    ])
    expect(badge).toHaveAccessibleName(
      'Open pull request #42: Fix the login flake, checks failing, changes requested, 12 unresolved threads'
    )
    expect(badge).toHaveAttribute(
      'title',
      'Open — #42 Fix the login flake\nchecks failing\nchanges requested\n12 unresolved threads'
    )
    expect(badge.querySelector('.pr-threads')).toHaveTextContent(/^12$/)
  })
})

describe('ChatView pull-request affordance', () => {
  const inRepo: ChatBinding = { ...binding, nativeSessionId: 'abc-123' }

  it('offers Create PR on a worktree branch', async () => {
    vi.mocked(window.cockpit.getDefaultBranch).mockResolvedValue('main')
    renderChat(vi.fn(), { binding: inRepo })
    expect(await screen.findByRole('button', { name: 'Create PR' })).toBeInTheDocument()
  })

  it('never offers one on the branch a PR would target — gh refuses that', async () => {
    vi.mocked(window.cockpit.getDefaultBranch).mockResolvedValue('main')
    renderChat(vi.fn(), { binding: { ...inRepo, branch: 'main' } })
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Create PR' })).not.toBeInTheDocument()
    )
  })

  it('offers it when git cannot say what the default is', async () => {
    vi.mocked(window.cockpit.getDefaultBranch).mockResolvedValue(null)
    renderChat(vi.fn(), { binding: { ...inRepo, branch: 'main' } })
    expect(await screen.findByRole('button', { name: 'Create PR' })).toBeInTheDocument()
  })
})

describe('ChatView transcript window', () => {
  it('renders the newest rows and shows the next batch on request, keeping the offset', async () => {
    setChatLog(longLog(500))
    renderChat()
    const messages = document.querySelector<HTMLElement>('.messages')!
    expect(screen.getByText(/showing the last 400 of 500 messages/)).toBeInTheDocument()
    expect(screen.queryByText('line 99 of the transcript')).not.toBeInTheDocument()
    expect(screen.getByText('line 100 of the transcript')).toBeInTheDocument()
    // the reader is at the top of the window; the rows land above and the offset moves
    // with them, so the row they were looking at stays where it was
    scrollAway(messages, { top: 40 })
    await userEvent.click(screen.getByRole('button', { name: 'show 100 earlier' }))
    Object.defineProperty(messages, 'scrollHeight', { value: 6200, configurable: true })
    expect(screen.getByText('line 0 of the transcript')).toBeInTheDocument()
    expect(screen.queryByText(/showing the last/)).not.toBeInTheDocument()
  })

  it('a transcript hit opens at its message, rings it, and brings it into the window', () => {
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    setChatLog(longLog(500))
    renderChat(vi.fn(), {
      anchor: { role: 'assistant', snippet: '…line 12 of the transcript', timestamp: 1_012 }
    })
    // row 12 is 488 from the end — past the 400 the window opens with
    const row = document.querySelector('[data-log-key="12"]')!
    expect(row).toHaveClass('anchored')
    expect(spy).toHaveBeenCalledOnce()
    expect(spy.mock.instances[0]).toBe(row)
    expect(screen.getByRole('status')).toHaveTextContent('Showing the message that matched your search')
    spy.mockRestore()
  })

  it('a hit whose words are gone from the log opens at the bottom as before', () => {
    const spy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    setChatLog(longLog(5))
    renderChat(vi.fn(), { anchor: { role: 'user', snippet: 'not in this transcript', timestamp: null } })
    expect(document.querySelector('.anchored')).toBeNull()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('offers "New messages" only to a reader who scrolled up while rows arrived, and takes them down', async () => {
    setChatLog(longLog(3))
    renderChat()
    const messages = document.querySelector<HTMLElement>('.messages')!
    const key = screen.getByRole('button', { name: 'New messages' })
    expect(key.parentElement).not.toHaveClass('on')
    // pinned to the bottom: a new row is auto-scrolled to, nothing to offer
    act(() => addChatMessage({ role: 'assistant', kind: 'text', text: 'four' }))
    expect(key.parentElement).not.toHaveClass('on')
    // scrolled up: the next row is news
    scrollAway(messages, { top: 0 })
    act(() => addChatMessage({ role: 'assistant', kind: 'text', text: 'five' }))
    expect(key.parentElement).toHaveClass('on')
    expect(key).toHaveAttribute('tabindex', '0')
    const scrollTo = vi.spyOn(messages, 'scrollTo').mockImplementation(() => {})
    await userEvent.click(key)
    expect(scrollTo).toHaveBeenCalledWith({ top: 5000 })
    expect(key.parentElement).not.toHaveClass('on')
    expect(key).toHaveAttribute('tabindex', '-1')
  })
})

describe('the permission mode it remembers', () => {
  const composer = (): HTMLElement => screen.getByRole('textbox', { name: 'Message Claude' })

  it('sends with Auto-edit when what storage holds is not a mode', async () => {
    window.localStorage.setItem('cockpit:mode', 'bypassPermissions')
    const { onSend } = renderChat()
    await userEvent.type(composer(), 'go{Enter}')
    expect(onSend).toHaveBeenCalledWith('go', 'auto-edit', undefined)
  })

  it('sends with a remembered mode that is one — Yolo included', async () => {
    window.localStorage.setItem('cockpit:mode', 'yolo')
    const { onSend } = renderChat()
    await userEvent.type(composer(), 'go{Enter}')
    expect(onSend).toHaveBeenCalledWith('go', 'yolo', undefined)
  })
})

/**
 * Who drives the session: a session with its agent is read, never sent to, until the
 * person takes it over; one Cockpit holds can be handed back.
 */
describe('ChatView and who drives the session', () => {
  const started: ChatBinding = { ...binding, nativeSessionId: 'abc-123' }
  const outside: SessionControl = { holder: 'agent', how: 'outside' }
  const held: SessionControl = { holder: 'cockpit', how: 'started', since: 1 }

  it('holds Send on a session with its agent and offers Take over instead', async () => {
    const onSetHolder = vi.fn(async () => true)
    const { onSend } = renderChat(vi.fn(), { binding: started, control: outside, onSetHolder })
    expect(screen.getByText('In Claude', { selector: '.hold-chip .chip-text' })).toBeInTheDocument()
    const bar = screen.getByRole('region', { name: 'Who drives this session' })
    expect(bar).toHaveTextContent(/opened outside Cockpit/)
    // the draft is kept — only sending waits for the take-over
    await userEvent.type(screen.getByLabelText('Message Claude'), 'carry on{Enter}')
    const send = screen.getByRole('button', { name: 'Send' })
    expect(send).toBeDisabled()
    expect(send).toHaveAttribute('title', expect.stringMatching(/take it over to send/))
    expect(onSend).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Take over' }))
    expect(onSetHolder).toHaveBeenCalledWith('cockpit')
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/Taken over/))
  })

  it('names a released session as released', () => {
    renderChat(vi.fn(), { binding: started, control: { holder: 'agent', how: 'released', since: 2 } })
    expect(screen.getByRole('region', { name: 'Who drives this session' })).toHaveTextContent(/released from Cockpit/)
  })

  it('will not take over under a turn its agent is running', () => {
    renderChat(vi.fn(), { binding: started, control: outside, elsewhere: true })
    expect(screen.getByRole('button', { name: 'Take over' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Open in Terminal/ })).toBeDisabled()
  })

  it('keeps the bar out of the way on a session Cockpit holds, until its chip opens it', async () => {
    const onSetHolder = vi.fn(async () => true)
    renderChat(vi.fn(), { binding: started, control: held, onSetHolder })
    expect(screen.queryByRole('region', { name: 'Who drives this session' })).not.toBeInTheDocument()
    const chip = screen.getByRole('button', { name: 'In Cockpit' })
    expect(chip).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(chip)
    expect(chip).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('region', { name: 'Who drives this session' })).toHaveTextContent(/started here/)
    await userEvent.click(screen.getByRole('button', { name: 'Release to Claude' }))
    expect(onSetHolder).toHaveBeenCalledWith('agent')
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/Released to Claude/))
  })

  it('says a change of hands even after a step through your messages spoke', async () => {
    const onSetHolder = vi.fn(async () => true)
    setChatLog([
      { role: 'user', kind: 'text', text: 'first' },
      { role: 'assistant', kind: 'text', text: 'done' },
      { role: 'user', kind: 'text', text: 'second' }
    ])
    renderChat(vi.fn(), { binding: started, control: held, onSetHolder })
    fireEvent.keyDown(window, { key: 'ArrowUp', altKey: true, metaKey: true })
    expect(screen.getByRole('status')).toHaveTextContent(/message/)
    await userEvent.click(screen.getByRole('button', { name: 'In Cockpit' }))
    await userEvent.click(screen.getByRole('button', { name: 'Release to Claude' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/Released to Claude/))
  })

  it('will not release under a turn Cockpit is running, and says so where everyone reads it', async () => {
    renderChat(vi.fn(), { binding: started, control: held, busy: true })
    await userEvent.click(screen.getByRole('button', { name: 'In Cockpit' }))
    expect(screen.getByRole('button', { name: 'Release to Claude' })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Open in Terminal/ })).toBeDisabled()
    // a disabled key can't be focused, so its title alone reaches no keyboard
    expect(screen.getByRole('region', { name: 'Who drives this session' })).toHaveTextContent(
      /Cockpit is running a turn in it — stop it, or let it finish, to release it/
    )
  })

  it('hides the bar from its ×, handing focus back to the chip that opened it', async () => {
    renderChat(vi.fn(), { binding: started, control: held })
    const chip = screen.getByRole('button', { name: 'In Cockpit' })
    await userEvent.click(chip)
    const hide = screen.getByRole('button', { name: 'Hide this bar' })
    expect(hide.querySelector('svg')).not.toBeNull()
    expect(hide).not.toHaveTextContent('×')
    await userEvent.click(hide)
    expect(screen.queryByRole('region', { name: 'Who drives this session' })).not.toBeInTheDocument()
    expect(document.activeElement).toBe(chip)
  })

  it('resumes it in Terminal from the bar', async () => {
    const onResumeInTerminal = vi.fn(async () => true)
    renderChat(vi.fn(), { binding: started, control: outside, onResumeInTerminal })
    await userEvent.click(screen.getByRole('button', { name: /Open in Terminal/ }))
    expect(onResumeInTerminal).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/resumed in Terminal/))
  })

  it('shows no chip and no bar for a seat, which its table drives', () => {
    renderChat(vi.fn(), { binding: { ...started, readOnly: 'seat' }, control: outside })
    expect(screen.queryByRole('region', { name: 'Who drives this session' })).not.toBeInTheDocument()
    expect(document.querySelector('.hold-chip')).toBeNull()
  })
})

describe('ChatView hold bar under a turn in a terminal', () => {
  it('will not open a second CLI on a session Cockpit holds while it runs elsewhere', async () => {
    renderChat(vi.fn(), {
      binding: { ...binding, nativeSessionId: 'abc-123' },
      control: { holder: 'cockpit', how: 'taken-over', since: 1 },
      elsewhere: true
    })
    await userEvent.click(screen.getByRole('button', { name: 'In Cockpit' }))
    expect(screen.getByRole('button', { name: /Open in Terminal/ })).toBeDisabled()
    expect(screen.getByRole('region', { name: 'Who drives this session' })).toHaveTextContent(
      /Open in Terminal waits for that turn to end/
    )
    // handing it back to where it is running is exactly right, though
    expect(screen.getByRole('button', { name: 'Release to Claude' })).toBeEnabled()
  })
})

describe('ChatView names where a session with its agent lives', () => {
  const started: ChatBinding = { ...binding, nativeSessionId: 'abc-123' }

  it('says the place its log names — and to close it there before taking it over', () => {
    renderChat(vi.fn(), { binding: started, control: { holder: 'agent', how: 'outside', surface: 'app' } })
    expect(screen.getByText('In the Claude app', { selector: '.hold-chip .chip-text' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Who drives this session' })).toHaveTextContent(
      /close it in the Claude app and take it over/
    )
  })

  it('says where the turn it waits on is running', () => {
    renderChat(vi.fn(), {
      binding: started,
      control: { holder: 'agent', how: 'outside', surface: 'app' },
      elsewhere: true
    })
    expect(screen.getByRole('region', { name: 'Who drives this session' })).toHaveTextContent(
      /Claude is working on it in the Claude app right now/
    )
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute(
      'title',
      expect.stringContaining('working on this session in the Claude app')
    )
  })

  it('says a turn stopped on its question waits for an answer there, not for the turn to end', () => {
    setChatLog([
      {
        role: 'assistant',
        kind: 'tool_call',
        toolName: 'AskUserQuestion',
        text: '{}',
        asks: [{ question: 'Which org?', multiSelect: false, options: [{ label: 'acme' }, { label: 'tashtit' }] }]
      }
    ])
    renderChat(vi.fn(), {
      binding: started,
      control: { holder: 'agent', how: 'outside', surface: 'terminal' },
      elsewhere: true
    })
    const bar = screen.getByRole('region', { name: 'Who drives this session' })
    expect(bar).toHaveTextContent(/Claude is waiting for your answer in a terminal — answer it there, then take it over/)
    expect(bar).not.toHaveTextContent(/once that turn ends/)
    expect(screen.getByRole('button', { name: 'Take over' })).toHaveAttribute(
      'title',
      expect.stringContaining('waiting for your answer in it — answer it there first')
    )
    expect(screen.getByRole('button', { name: 'Send' })).toHaveAttribute(
      'title',
      'Claude is waiting for your answer in a terminal — answer it there, then take it over'
    )
  })

  it('names a terminal', () => {
    renderChat(vi.fn(), { binding: started, control: { holder: 'agent', how: 'outside', surface: 'terminal' } })
    expect(screen.getByText('In a terminal', { selector: '.hold-chip .chip-text' })).toBeInTheDocument()
  })

  it('says a headless run was one, with no place to close it in', () => {
    renderChat(vi.fn(), { binding: started, control: { holder: 'agent', how: 'outside', surface: 'headless' } })
    expect(screen.getByText('In Claude', { selector: '.hold-chip .chip-text' })).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Who drives this session' })).toHaveTextContent(/run headless outside Cockpit/)
  })

  it('does not name the place it was opened once it was released — it went wherever it was resumed', () => {
    renderChat(vi.fn(), { binding: started, control: { holder: 'agent', how: 'released', since: 2, surface: 'app' } })
    expect(screen.getByText('In Claude', { selector: '.hold-chip .chip-text' })).toBeInTheDocument()
  })
})
