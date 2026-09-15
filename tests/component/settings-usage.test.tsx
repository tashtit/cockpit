import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { Settings } from '../../src/renderer/src/Settings'
import { usageFixture } from './stub-api'

describe('Settings opened at the usage section', () => {
  it('lands focus on the usage heading instead of the title', async () => {
    vi.mocked(window.cockpit.getUsage).mockResolvedValue(usageFixture())
    render(<Settings onClose={vi.fn()} section="usage" />)
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Subscription usage' })).toHaveFocus()
    )
    // the full readout is there — every window, not just the tightest one
    expect(await screen.findByText('weekly window')).toBeInTheDocument()
  })

  it('still lands on the title when no section is asked for', async () => {
    render(<Settings onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Settings' })).toHaveFocus())
  })
})
