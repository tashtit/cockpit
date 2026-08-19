import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatView } from '../../src/renderer/src/ChatView'
import type { ChatBinding } from '../../src/renderer/src/App'
import { pasteImage, stubObjectUrls } from './paste'

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
  over: { binding?: ChatBinding; busy?: boolean } = {}
): { onSend: ReturnType<typeof vi.fn>; onOpenHandoff: ReturnType<typeof vi.fn>; onOpenLineage: ReturnType<typeof vi.fn> } {
  const onOpenHandoff = vi.fn()
  const onOpenLineage = vi.fn()
  render(
    <ChatView
      binding={over.binding ?? binding}
      prs={[]}
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
