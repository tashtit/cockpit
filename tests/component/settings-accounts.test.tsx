import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Settings } from '../../src/renderer/src/Settings'
import { usageFixture } from './stub-api'
import type { AccountsSnapshot, SourceStats } from '../../src/shared/types'

const sources: SourceStats[] = [
  {
    path: '/home/dev/.claude',
    provider: 'claude',
    label: 'claude-default',
    count: 12,
    lastUpdatedAt: Date.now() - 60_000,
    missing: false
  },
  {
    path: '/home/dev/.codex',
    provider: 'codex',
    label: 'codex-default',
    count: 3,
    lastUpdatedAt: Date.now() - 3_600_000,
    missing: false
  }
]

const accounts: AccountsSnapshot = {
  accounts: [
    {
      provider: 'claude',
      path: '/home/dev/.claude',
      label: 'claude-default',
      identity: 'dev@example.com',
      isDefault: true
    }
  ],
  githubUser: 'dev'
}

beforeEach(() => {
  vi.mocked(window.cockpit.getSourceStats).mockResolvedValue(sources)
  vi.mocked(window.cockpit.getAccounts).mockResolvedValue(accounts)
  vi.mocked(window.cockpit.getUsage).mockResolvedValue(usageFixture())
})

describe('Settings account rows', () => {
  it('carries each account’s usage in its own row, not a second list of the same accounts', async () => {
    render(<Settings onClose={vi.fn()} />)

    const claudeRow = (await screen.findByText('claude-default')).closest('li')!
    // identity, the config home, and what that subscription has spent — one object, one row
    expect(within(claudeRow).getByText('dev@example.com')).toBeInTheDocument()
    expect(within(claudeRow).getByText('/home/dev/.claude')).toBeInTheDocument()
    expect(within(claudeRow).getByText('current 5h block')).toBeInTheDocument()

    // the account appears once in the card, not once per section
    expect(screen.getAllByText('claude-default')).toHaveLength(1)
    expect(screen.queryByRole('heading', { name: 'Subscription usage' })).not.toBeInTheDocument()
  })

  it('says why usage is missing rather than leaving a blank row', async () => {
    vi.mocked(window.cockpit.getUsage).mockResolvedValue({
      at: Date.now(),
      providers: [
        {
          provider: 'codex',
          path: '/home/dev/.codex',
          label: 'codex-default',
          source: 'provider',
          windows: [],
          unavailable: 'Codex has not written a rate-limit snapshot yet.'
        }
      ]
    })
    render(<Settings onClose={vi.fn()} />)
    const codexRow = (await screen.findByText('codex-default')).closest('li')!
    expect(
      within(codexRow).getByText('Codex has not written a rate-limit snapshot yet.')
    ).toBeInTheDocument()
  })

  it('carries the unit on the session count, so the pill is a readout and not a mystery number', async () => {
    render(<Settings onClose={vi.fn()} />)
    const claudeRow = (await screen.findByText('claude-default')).closest('li')!
    expect(within(claudeRow).getByText('12')).toHaveClass('repo-count')
    expect(within(claudeRow).getByText('sessions')).toBeInTheDocument()
    const codexRow = screen.getByText('codex-default').closest('li')!
    expect(within(codexRow).getByText('sessions')).toBeInTheDocument()
  })

  it('shows main’s own words when an add is refused, not Electron’s wrapper around them', async () => {
    vi.mocked(window.cockpit.addSource).mockRejectedValue(
      new Error("Error invoking remote method 'sources:add': Error: Not a directory: /home/dev/.nope")
    )
    render(<Settings onClose={vi.fn()} />)
    await screen.findByText('claude-default')
    await userEvent.click(screen.getByRole('button', { name: 'Add a config home…' }))
    // paste, not type: a keystroke per character re-renders the whole card each time
    await userEvent.click(screen.getByLabelText('Config home'))
    await userEvent.paste('/home/dev/.nope')
    await userEvent.click(screen.getByRole('button', { name: 'Add config home' }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/^Not a directory: \/home\/dev\/.nope$/)
  })

  it('says a path is already watched instead of announcing an add that changed nothing', async () => {
    render(<Settings onClose={vi.fn()} />)
    await screen.findByText('claude-default')
    await userEvent.click(screen.getByRole('button', { name: 'Add a config home…' }))
    await userEvent.click(screen.getByLabelText('Config home'))
    await userEvent.paste('/home/dev/.claude')
    await userEvent.click(screen.getByRole('button', { name: 'Add config home' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Cockpit already watches /home/dev/.claude.')
    expect(window.cockpit.addSource).not.toHaveBeenCalled()
  })

  it('keeps the add form folded until it is asked for', async () => {
    render(<Settings onClose={vi.fn()} />)
    await screen.findByText('claude-default')
    expect(screen.queryByLabelText('Config home')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Add a config home…' }))
    const field = screen.getByLabelText('Config home')
    await waitFor(() => expect(field).toHaveFocus())

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('Config home')).not.toBeInTheDocument()
  })
})

describe('Settings › the GitHub account', () => {
  it('rides with the agent accounts on their own tab — it is an account too', async () => {
    render(<Settings onClose={vi.fn()} />)
    await screen.findByText('claude-default')
    const agents = screen.getByRole('heading', { name: 'Agent accounts & usage' })
    const github = screen.getByRole('heading', { name: 'GitHub' })
    // one tab, the agent homes first and the gh login under them
    expect(agents.compareDocumentPosition(github) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(within(screen.getByRole('tabpanel')).getByText('@dev')).toBeInTheDocument()
    // and it has no tab of its own to be looked for on
    expect(screen.queryByRole('tab', { name: 'GitHub' })).toBeNull()
  })
})

describe('Settings › Accounts sign-in', () => {
  it('flags a home whose CLI says it is signed out, though its identity is remembered', async () => {
    vi.mocked(window.cockpit.signInState).mockImplementation(async (provider) =>
      provider === 'claude' ? 'signed-out' : 'signed-in'
    )
    render(<Settings onClose={vi.fn()} />)
    const row = (await screen.findByText('claude-default')).closest('li')!
    // the remembered identity stays; the CLI's own answer sits beside it, with the fix
    expect(within(row).getByText('dev@example.com')).toBeInTheDocument()
    expect(await within(row).findByText('signed out')).toBeInTheDocument()
    expect(within(row).getByText(/in a terminal to sign in again/)).toBeInTheDocument()
    // the default home is asked with no config-home variable, as a session runs
    expect(window.cockpit.signInState).toHaveBeenCalledWith('claude', undefined)
    const codex = screen.getByText('codex-default').closest('li')!
    expect(within(codex).queryByText('signed out')).not.toBeInTheDocument()
  })
})
