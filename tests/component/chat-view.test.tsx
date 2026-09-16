import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatView } from '../../src/renderer/src/ChatView'
import type { ChatBinding } from '../../src/renderer/src/App'
import type { PrStatus } from '../../src/shared/types'
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
  over: { binding?: ChatBinding; busy?: boolean; prs?: PrStatus[] } = {}
): { onSend: ReturnType<typeof vi.fn>; onOpenHandoff: ReturnType<typeof vi.fn>; onOpenLineage: ReturnType<typeof vi.fn> } {
  const onOpenHandoff = vi.fn()
  const onOpenLineage = vi.fn()
  render(
    <ChatView
      binding={over.binding ?? binding}
      prs={over.prs ?? []}
      log={[]}
      busy={over.busy ?? false}
      prBusy={false}
      onSend={onSend}
      onCancel={() => {}}
      onCreatePr={() => {}}
      onOpenUrl={() => {}}
      onOpenHandoff={onOpenHandoff}
      onOpenLineage={onOpenLineage}
    />
  )
  return { onSend, onOpenHandoff, onOpenLineage }
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
    expect(screen.queryByRole('button', { name: /Create PR/ })).not.toBeInTheDocument()
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
