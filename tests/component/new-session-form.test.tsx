import { describe, it, expect, vi } from 'vitest'
import { act } from 'react'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { NewSession } from '../../src/renderer/src/NewSession'
import { initAcpReadiness } from '../../src/renderer/src/acp-readiness'
import type { RepoGroup, SessionProvider } from '../../src/shared/types'

const repo: RepoGroup = {
  key: '/home/dev/rocket',
  name: 'rocket',
  fullName: 'acme/rocket',
  root: '/home/dev/rocket',
  sessionCount: 2,
  archivedCount: 0,
  heldCount: 0,
  byProvider: {},
  lastActivity: 1700000000000,
  providers: ['claude'],
  hidden: false
}

function renderForm(): void {
  render(<NewSession repo={repo} repos={[repo]} busy={false} onStart={vi.fn()} onCancel={() => {}} />)
}

describe('NewSession form order', () => {
  it('asks for the task before where it runs and who runs it', () => {
    renderForm()
    const task = screen.getByLabelText('Task', { exact: true })
    const project = screen.getByRole('button', { name: /^Project/ })
    // DOCUMENT_POSITION_FOLLOWING: the project control comes after the task
    expect(task.compareDocumentPosition(project) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(task).toHaveFocus()
  })

  // the stub answers with no accounts, which is the state the form opens in while
  // they load: a div there carried an aria-labelledby the browser drops, so the
  // readout read as labelled in the source and was nameless in the tree
  it('gives the read-only account a role that can carry its label', () => {
    renderForm()
    const readout = screen.getByRole('status', { name: 'Account' })
    expect(readout.tagName).toBe('OUTPUT')
  })

  it('previews the branch the task will produce, before anything is typed into it', async () => {
    renderForm()
    const branch = screen.getByLabelText('Branch')
    expect(branch).toHaveAttribute('placeholder', 'auto-generated')

    await userEvent.type(screen.getByLabelText('Task', { exact: true }), 'Add a CHANGELOG entry for the retry fix')
    expect(branch).toHaveAttribute('placeholder', 'add-changelog-entry-retry-fix')
  })
})

describe('NewSession with an agent Cockpit only reads', () => {
  async function driving(agents: SessionProvider[]): Promise<void> {
    vi.mocked(window.cockpit.getAcpReadiness).mockResolvedValue({ drivable: agents, builtinsReady: [] })
    await act(async () => {
      initAcpReadiness()
    })
  }

  it('offers none of them while no ACP agent answers for one', () => {
    renderForm()
    const agents = screen.getByRole('group', { name: 'Agent' })
    expect(within(agents).getAllByRole('button').map((b) => b.querySelector('.ns-provider-name')?.textContent)).toEqual([
      'Claude',
      'Codex',
      'Copilot'
    ])
  })

  it('offers one an ACP agent drives, with none of a headless CLI’s knobs', async () => {
    await driving(['claude', 'codex', 'copilot', 'gemini'])
    const onStart = vi.fn(async () => null)
    render(<NewSession repo={repo} repos={[repo]} busy={false} onStart={onStart} onCancel={() => {}} />)
    const card = within(screen.getByRole('group', { name: 'Agent' })).getByRole('button', { name: /Gemini/ })
    expect(card).toHaveTextContent('Runs over its ACP server')
    expect(card).toHaveTextContent('over ACP')
    await userEvent.click(card)
    expect(card).toHaveAttribute('aria-pressed', 'true')
    // its model and account are its own settings — Cockpit never learns them
    expect(screen.queryByRole('status', { name: 'Account' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Model/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Thinking/ })).toBeNull()
    expect(screen.getByText(/Gemini runs over its ACP server/)).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('Task', { exact: true }), 'tidy the README')
    await userEvent.click(screen.getByRole('button', { name: 'Start session' }))
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ provider: 'gemini', options: {} }))
  })

  it('opens on Claude when the agent last used has no ACP agent any more', () => {
    window.localStorage.setItem('cockpit:provider', 'gemini')
    renderForm()
    expect(within(screen.getByRole('group', { name: 'Agent' })).getByRole('button', { name: /Claude/ })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
  })
})

describe('NewSession remembered choice', () => {
  it('opens on Claude when the remembered agent is not one', () => {
    window.localStorage.setItem('cockpit:provider', 'aider')
    renderForm()
    expect(screen.getByRole('button', { pressed: true })).toHaveAccessibleName(/Claude/)
  })

  // a private window or blocked site data makes every storage call throw — the form
  // opens on its defaults rather than failing to render
  it('opens on its defaults when storage refuses to be read', () => {
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    })
    try {
      renderForm()
      expect(screen.getByRole('button', { pressed: true })).toHaveAccessibleName(/Claude/)
      expect(screen.getByRole('button', { name: /^Permissions/ })).toHaveTextContent('Accept edits')
    } finally {
      read.mockRestore()
    }
  })
})
