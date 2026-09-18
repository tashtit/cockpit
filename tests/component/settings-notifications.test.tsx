import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Settings } from '../../src/renderer/src/Settings'
import type { NotificationDelivery } from '../../src/shared/types'

/** The switch list on the Notifications tab — the panel's own list, not the card's. */
async function switches(): Promise<HTMLElement> {
  const panel = await screen.findByRole('tabpanel')
  return panel.querySelector('ul') as HTMLElement
}

describe('Settings notifications', () => {
  it('shows the three switches as main reports them, each described', async () => {
    vi.mocked(window.cockpit.getAttentionPrefs).mockResolvedValue({
      notifications: true,
      sound: false,
      badge: true
    })
    render(<Settings onClose={vi.fn()} section="notifications" />)
    const list = await switches()

    const banner = within(list).getByRole('checkbox', { name: 'Desktop notifications' })
    await waitFor(() => expect(banner).toBeChecked())
    expect(within(list).getByRole('checkbox', { name: 'Sound' })).not.toBeChecked()
    expect(within(list).getByRole('checkbox', { name: 'Dock badge' })).toBeChecked()
    expect(banner).toHaveAccessibleDescription(/Click one to open that session/)
  })

  it('flipping a switch saves the whole set and announces the change', async () => {
    vi.mocked(window.cockpit.getAttentionPrefs).mockResolvedValue({
      notifications: true,
      sound: true,
      badge: true
    })
    render(<Settings onClose={vi.fn()} section="notifications" />)
    const list = await switches()
    const sound = within(list).getByRole('checkbox', { name: 'Sound' })
    await waitFor(() => expect(sound).toBeChecked())

    await userEvent.click(sound)
    expect(window.cockpit.setAttentionPrefs).toHaveBeenCalledWith({
      notifications: true,
      sound: false,
      badge: true
    })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Sound off'))
    expect(sound).not.toBeChecked()
  })

  it('a refused save puts the switch back', async () => {
    vi.mocked(window.cockpit.getAttentionPrefs).mockResolvedValue({
      notifications: true,
      sound: true,
      badge: true
    })
    vi.mocked(window.cockpit.setAttentionPrefs).mockRejectedValue(new Error('disk full'))
    render(<Settings onClose={vi.fn()} section="notifications" />)
    const list = await switches()
    const badge = within(list).getByRole('checkbox', { name: 'Dock badge' })
    await waitFor(() => expect(badge).toBeChecked())

    await userEvent.click(badge)
    await waitFor(() => expect(badge).toBeChecked())
    expect(screen.getByRole('status')).toHaveTextContent('Could not change Dock badge: disk full')
  })

  it('the test says what macOS did — a refusal explains the unsigned build and quotes macOS', async () => {
    let answer: (d: NotificationDelivery) => void = () => {}
    vi.mocked(window.cockpit.testNotification).mockReturnValue(
      new Promise((r) => {
        answer = r
      })
    )
    render(<Settings onClose={vi.fn()} section="notifications" />)
    const list = await switches()

    await userEvent.click(within(list).getByRole('button', { name: 'Send a test notification' }))
    // macOS can take seconds to answer: the button says so and can't be pressed twice
    expect(within(list).getByRole('button', { name: 'Sending…' })).toBeDisabled()

    answer({ status: 'refused', message: 'UNErrorDomain error 1' })
    await within(list).findByText(/Builds without an Apple Developer ID signature/)
    expect(within(list).getByText('UNErrorDomain error 1')).toBeInTheDocument()
    expect(within(list).getByRole('button', { name: 'Send a test notification' })).toBeEnabled()
  })

  it('a development run says the switches start off here', async () => {
    // the stub is a development run already; say so, since that is what's under test
    expect((await window.cockpit.getAppInfo()).packaged).toBe(false)
    render(<Settings onClose={vi.fn()} section="notifications" />)
    const list = await switches()
    await within(list).findByText(/Development run/)
  })
})
