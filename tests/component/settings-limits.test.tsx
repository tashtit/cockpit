import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Settings } from '../../src/renderer/src/Settings'
import { DEFAULT_ROUNDTABLE_LIMITS } from '../../src/shared/roundtable'

describe('Settings › Limits', () => {
  it('shows the three ceilings and saves a change through main', async () => {
    render(<Settings onClose={vi.fn()} section="limits" />)

    expect(await screen.findByRole('button', { name: /^Seats per table up to 4/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Turns per message up to 16/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Turns per table up to 80/ })).toBeInTheDocument()
    // the ceilings in the terms the form uses: 4 seats on 16 turns is four rounds
    expect(screen.getByText(/a message may run 4 rounds at most/)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /^Seats per table/ }))
    await userEvent.click(await screen.findByRole('option', { name: 'up to 8' }))
    expect(window.cockpit.setRoundtableLimits).toHaveBeenCalledWith({
      ...DEFAULT_ROUNDTABLE_LIMITS,
      maxSeats: 8
    })
    // what main stored is what the panel shows — and the arithmetic follows it
    expect(await screen.findByText(/a message may run 2 rounds at most/)).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Roundtable limits saved')
  })

  it('a hand-edited ceiling outside the presets still reads as itself', async () => {
    vi.mocked(window.cockpit.getRoundtableLimits).mockResolvedValue({
      ...DEFAULT_ROUNDTABLE_LIMITS,
      maxTurnsPerTable: 0,
      maxTurnsPerMessage: 10
    })
    render(<Settings onClose={vi.fn()} section="limits" />)
    expect(await screen.findByRole('button', { name: /^Turns per message up to 10/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Turns per table no ceiling/ })).toBeInTheDocument()
  })
})
