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
