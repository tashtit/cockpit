import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatView } from '../../src/renderer/src/ChatView'
import { setChatLog } from '../../src/renderer/src/chat-log'
import type { ChatBinding, PendingPermission } from '../../src/renderer/src/App'
import { stubObjectUrls } from './paste'

const binding: ChatBinding = {
  provider: 'copilot',
  cwd: '/tmp/wt',
  nativeSessionId: 'sess-1',
  title: 'test session',
  branch: 'cockpit/test',
  repoRoot: '/tmp/repo'
}

const ask: PendingPermission = {
  turnId: 't1',
  requestId: '7',
  toolName: 'shell',
  preview: 'Run the test suite',
  detail: '{"command":"npm test"}',
  options: [
    { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
    { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow' },
    { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' }
  ]
}

function renderChat(permissions: PendingPermission[]): ReturnType<typeof vi.fn> {
  stubObjectUrls()
  const onAnswerPermission = vi.fn()
  render(
    <ChatView
      binding={binding}
      prs={[]}
      busy={true}
      prBusy={false}
      onSend={vi.fn()}
      onCancel={() => {}}
      onCreatePr={() => {}}
      onOpenUrl={() => {}}
      onOpenHandoff={vi.fn()}
      onOpenLineage={vi.fn()}
      permissions={permissions}
      onAnswerPermission={onAnswerPermission}
    />
  )
  return onAnswerPermission
}

/** The docked prompt an ACP agent is blocked on — see `PermissionAsk` in ChatView. */
describe('permission prompt', () => {
  it('shows what the agent wants to do and every answer it will take', () => {
    renderChat([ask])
    const group = screen.getByRole('group', { name: /needs permission: Run the test suite/i })
    expect(within(group).getByText('shell')).toBeTruthy()
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual([
      'Allow once',
      'Always allow',
      'Deny'
    ])
  })

  it('answers with the option that was clicked', async () => {
    const onAnswerPermission = renderChat([ask])
    await userEvent.click(screen.getByRole('button', { name: 'Deny' }))
    expect(onAnswerPermission).toHaveBeenCalledWith(ask, 'reject_once')
  })

  it('styles only the allowing answers as the affirmative action', () => {
    renderChat([ask])
    expect(screen.getByRole('button', { name: 'Allow once' }).className).toContain('btn-primary')
    expect(screen.getByRole('button', { name: 'Always allow' }).className).toContain('btn-primary')
    // the safe answer must never be the one styled to be clicked without reading
    expect(screen.getByRole('button', { name: 'Deny' }).className).toContain('btn-ghost')
  })

  it('carries the raw tool input as the tooltip, so a click is informed', () => {
    renderChat([ask])
    expect(screen.getByTitle('{"command":"npm test"}')).toBeTruthy()
  })

  it('announces the question over the generic working line', () => {
    renderChat([ask])
    const live = screen.getByRole('status')
    expect(live.textContent).toBe('Permission needed: Run the test suite')
  })

  it('says the agent is working when nothing is being asked', () => {
    renderChat([])
    expect(screen.getByRole('status').textContent).toBe('Copilot is working…')
    expect(screen.queryByRole('group', { name: /needs permission/i })).toBeNull()
  })

  it('shows every open question when an agent asks more than one', () => {
    renderChat([ask, { ...ask, requestId: '8', preview: 'Delete build output' }])
    expect(screen.getAllByRole('group', { name: /needs permission/i })).toHaveLength(2)
  })

  it('wears the agent’s livery, the same signal the sidebar gives', () => {
    renderChat([ask])
    expect(screen.getByRole('group', { name: /needs permission/i }).className).toContain('tint-copilot')
  })
})
