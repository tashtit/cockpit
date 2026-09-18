import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { Settings } from '../../src/renderer/src/Settings'
import { usageFixture } from './stub-api'

describe('Settings opened at the usage section', () => {
  it('opens on the accounts tab with the full readout', async () => {
    vi.mocked(window.cockpit.getUsage).mockResolvedValue(usageFixture())
    render(<Settings onClose={vi.fn()} section="accounts" />)
    expect(screen.getByRole('tab', { name: 'Accounts' })).toHaveAttribute('aria-selected', 'true')
    await screen.findByRole('heading', { name: 'Agent accounts & usage' })
    // the full readout is there — every window, not just the tightest one, and it
    // sits in the account's own row rather than a second list of the same accounts
    expect(await screen.findByText('weekly window')).toBeInTheDocument()
  })

  it('lands focus on the title, wherever the deep link opens', async () => {
    render(<Settings onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Settings' })).toHaveFocus())
  })
})
