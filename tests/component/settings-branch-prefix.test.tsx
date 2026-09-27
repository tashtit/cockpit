import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Settings } from '../../src/renderer/src/Settings'
import { NewSession } from '../../src/renderer/src/NewSession'
import { BranchChip } from '../../src/renderer/src/logos'
import { initBranchPrefix } from '../../src/renderer/src/branch-prefix'
import type { RepoGroup } from '../../src/shared/types'

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

/** The store is module state: point it at what main would answer. */
async function mainSays(prefix: string): Promise<void> {
  vi.mocked(window.cockpit.getBranchPrefix).mockResolvedValue(prefix)
  await act(() => initBranchPrefix())
}

beforeEach(async () => {
  await mainSays('cockpit/')
})

afterEach(async () => {
  await mainSays('cockpit/')
})

describe('Settings › Accounts › Branch prefix', () => {
  const row = async (): Promise<HTMLElement> =>
    (await screen.findByText('Branch prefix', { selector: '.source-label' })).closest('li')!

  it('shows the prefix in force and the branch name it makes', async () => {
    render(<Settings onClose={vi.fn()} />)
    const r = await row()
    expect(within(r).getByRole('textbox', { name: 'Branch prefix' })).toHaveValue('cockpit/')
    expect(within(r).getByText('cockpit/fix-login-flake')).toBeInTheDocument()
    // nothing to save until something changes
    expect(within(r).getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('previews the name as it is typed, saves it, and says so', async () => {
    vi.mocked(window.cockpit.setBranchPrefix).mockResolvedValue('titan/')
    render(<Settings onClose={vi.fn()} />)
    const r = await row()
    const input = within(r).getByRole('textbox', { name: 'Branch prefix' })
    await userEvent.clear(input)
    await userEvent.type(input, 'titan')
    // a bare name means a folder of branches
    expect(within(r).getByText('titan/fix-login-flake')).toBeInTheDocument()
    await userEvent.click(within(r).getByRole('button', { name: 'Save' }))
    expect(window.cockpit.setBranchPrefix).toHaveBeenCalledWith('titan')
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Branch prefix set to titan/'))
    expect(input).toHaveValue('titan/')
    expect(within(r).getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('explains a name git would refuse, and will not send it', async () => {
    render(<Settings onClose={vi.fn()} />)
    const r = await row()
    const input = within(r).getByRole('textbox', { name: 'Branch prefix' })
    await userEvent.clear(input)
    await userEvent.type(input, 'my team/')
    expect(within(r).getByRole('alert')).toHaveTextContent(/letters, digits/)
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(within(r).getByRole('button', { name: 'Save' })).toBeDisabled()
    // the example keeps showing what is in force, not what cannot be
    expect(within(r).getByText('cockpit/fix-login-flake')).toBeInTheDocument()
    // Escape backs out of the edit
    await userEvent.type(input, '{Escape}')
    expect(input).toHaveValue('cockpit/')
    expect(within(r).queryByRole('alert')).not.toBeInTheDocument()
    expect(window.cockpit.setBranchPrefix).not.toHaveBeenCalled()
  })

  it('shows main’s refusal verbatim when it says no', async () => {
    vi.mocked(window.cockpit.setBranchPrefix).mockRejectedValue(
      new Error("Error invoking remote method 'workspace:set-branch-prefix': Error: config is unreadable")
    )
    render(<Settings onClose={vi.fn()} />)
    const r = await row()
    const input = within(r).getByRole('textbox', { name: 'Branch prefix' })
    await userEvent.clear(input)
    await userEvent.type(input, 'titan/{Enter}')
    expect(await within(r).findByRole('alert')).toHaveTextContent('config is unreadable')
  })
})

describe('where the prefix shows', () => {
  it('the New session form puts it before the branch name', async () => {
    await mainSays('titan/')
    render(<NewSession repo={repo} repos={[repo]} busy={false} onStart={vi.fn()} onCancel={() => {}} />)
    expect(screen.getByText('titan/', { selector: '.ns-branch-prefix' })).toBeInTheDocument()
  })

  it('the branch pill dims it, and the default one branches cut before it still carry', async () => {
    await mainSays('titan/')
    const { container } = render(
      <>
        <BranchChip branch="titan/fix-login" />
        <BranchChip branch="cockpit/older-work" />
        <BranchChip branch="main" />
      </>
    )
    const pres = [...container.querySelectorAll('.chip-pre')].map((e) => e.textContent)
    expect(pres).toEqual(['t/', 'c/'])
    expect(container.textContent).toContain('fix-login')
    expect(container.textContent).toContain('main')
    expect(screen.getByTitle('⎇ titan/fix-login')).toBeInTheDocument()
  })
})
