import { describe, it, expect, vi } from 'vitest'
import { act, render, screen } from '@testing-library/react'
import { ChatView } from '../../src/renderer/src/ChatView'
import { reloadChatWidth, setChatWidth } from '../../src/renderer/src/chat-width'
import type { ChatBinding } from '../../src/renderer/src/App'

const binding: ChatBinding = {
  provider: 'claude',
  cwd: '/home/dev/rocket',
  nativeSessionId: 's1',
  title: 'fix the login flake',
  branch: 'cockpit/login',
  repoRoot: '/home/dev/rocket'
}

function renderChat() {
  render(
    <ChatView
      binding={binding}
      prs={[]}
      log={[]}
      busy={false}
      prBusy={false}
      onSend={vi.fn()}
      onCancel={vi.fn()}
      onCreatePr={vi.fn()}
      onOpenUrl={vi.fn()}
    />
  )
}

describe('conversation column width preference', () => {
  it('defaults to the comfortable column and tracks the live preference', () => {
    reloadChatWidth() // setup clears localStorage between tests — resync the store
    renderChat()
    const main = screen.getByRole('main')
    expect(main.style.getPropertyValue('--chat-col')).toBe('860px')

    // a Settings change re-renders the open chat without a remount
    act(() => setChatWidth('narrow'))
    expect(main.style.getPropertyValue('--chat-col')).toBe('680px')
    act(() => setChatWidth('full'))
    expect(main.style.getPropertyValue('--chat-col')).toBe('100%')
  })

  it('persists the choice and reads it back on a fresh load', () => {
    act(() => setChatWidth('wide'))
    expect(window.localStorage.getItem('cockpit:chat-width')).toBe('wide')

    reloadChatWidth() // simulates the module's load-time read in a new window
    renderChat()
    expect(screen.getByRole('main').style.getPropertyValue('--chat-col')).toBe('1120px')
  })
})
