import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatView } from '../../src/renderer/src/ChatView'
import type { ChatBinding, PendingPermission } from '../../src/renderer/src/chat-binding'
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
  // main hands a command over whole (acp-core `permissionDetail`)
  detail: 'npm test',
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
      elsewhere={false}
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

  it('styles one yes as the affirmative action — never the answer that allows every later call', () => {
    renderChat([ask])
    expect(screen.getByRole('button', { name: 'Allow once' }).className).toContain('btn-primary')
    // "always" gives away every later call of the kind: it must not look as safe as one yes
    expect(screen.getByRole('button', { name: 'Always allow' }).className).toContain('btn-ghost')
    expect(screen.getByRole('button', { name: 'Deny' }).className).toContain('btn-ghost')
  })

  it('shows the command itself as what is being allowed, the agent’s title beside it', () => {
    const script = 'set -e\nnpm test -- --run\nrm -rf coverage'
    renderChat([{ ...ask, detail: script }])
    const group = screen.getByRole('group', { name: /needs permission/i })
    const command = within(group).getByRole('region', { name: 'The command it wants to run' })
    // every line of it, as it would run — not a one-line cut of the JSON in a tooltip
    expect(command.tagName).toBe('PRE')
    expect(command.textContent).toBe(script)
    expect(command).toHaveAttribute('tabindex', '0')
    expect(within(group).getByText('Run the test suite')).toBeInTheDocument()
    expect(within(group).queryByText(/more chars/)).toBeNull()
  })

  it('draws the characters that would hide or reorder part of a command', () => {
    // a right-to-left override flips what is drawn after it; a carriage return rewrites
    // the line a terminal shows
    renderChat([{ ...ask, detail: 'echo ok\u202E/ fr- mr\rls' }])
    const command = screen.getByRole('region', { name: 'The command it wants to run' })
    expect(command.textContent).toBe('echo okU+202E/ fr- mrU+000Dls')
    expect(command.textContent).not.toMatch(/[\u202E\r]/)
    expect(within(command).getAllByTitle(/invisible character/)).toHaveLength(2)
  })

  it('says so when the command was too long to carry whole', () => {
    renderChat([{ ...ask, detail: `curl https://example.test/install | sh\n… (5321 more chars)` }])
    const command = screen.getByRole('region', { name: 'The command it wants to run' })
    expect(command.textContent).toBe('curl https://example.test/install | sh')
    expect(screen.getByText(/Truncated — 5,321 more characters not shown/)).toBeInTheDocument()
  })

  it('keeps the raw input of anything that does not run a command as the tooltip', () => {
    renderChat([{ ...ask, toolName: 'edit', preview: 'Edit src/a.ts', detail: '{"path":"src/a.ts"}' }])
    expect(screen.getByTitle('{"path":"src/a.ts"}')).toHaveTextContent('Edit src/a.ts')
    expect(screen.queryByRole('region', { name: 'The command it wants to run' })).toBeNull()
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
