import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatView } from '../../src/renderer/src/ChatView'
import type { ChatBinding } from '../../src/renderer/src/chat-binding'
import type { PrStatus, SessionMessage } from '../../src/shared/types'
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
  over: { binding?: ChatBinding; busy?: boolean; elsewhere?: boolean; prs?: PrStatus[]; anchor?: TranscriptAnchor } = {}
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
