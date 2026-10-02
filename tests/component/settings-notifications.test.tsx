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
  it('shows the four switches as main reports them, each described', async () => {
    vi.mocked(window.cockpit.getAttentionPrefs).mockResolvedValue({
      notifications: true,
      sound: false,
      badge: true,
      cleanup: false
    })
    render(<Settings onClose={vi.fn()} section="notifications" />)
    const list = await switches()

    const banner = within(list).getByRole('checkbox', { name: 'Desktop notifications' })
    await waitFor(() => expect(banner).toBeChecked())
    expect(within(list).getByRole('checkbox', { name: 'Sound' })).not.toBeChecked()
    expect(within(list).getByRole('checkbox', { name: 'Dock badge' })).toBeChecked()
    expect(banner).toHaveAccessibleDescription(/Click one to open that session/)
    const reminders = within(list).getByRole('checkbox', { name: 'Cleanup reminders' })
    expect(reminders).not.toBeChecked()
    expect(reminders).toHaveAccessibleDescription(/at most once a week/)
  })

  it('flipping a switch saves the whole set and announces the change', async () => {
    vi.mocked(window.cockpit.getAttentionPrefs).mockResolvedValue({
      notifications: true,
      sound: true,
      badge: true,
      cleanup: true
    })
    render(<Settings onClose={vi.fn()} section="notifications" />)
    const list = await switches()
    const sound = within(list).getByRole('checkbox', { name: 'Sound' })
    await waitFor(() => expect(sound).toBeChecked())

    await userEvent.click(sound)
    expect(window.cockpit.setAttentionPrefs).toHaveBeenCalledWith({
      notifications: true,
      sound: false,
      badge: true,
      cleanup: true
    })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Sound off'))
    expect(sound).not.toBeChecked()
  })

  it('a refused save puts the switch back', async () => {
    vi.mocked(window.cockpit.getAttentionPrefs).mockResolvedValue({
      notifications: true,
      sound: true,
      badge: true,
      cleanup: true
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

  it('each sound can be heard on its own, whatever the Sound switch says, and says what played', async () => {
    vi.mocked(window.cockpit.getAttentionPrefs).mockResolvedValue({
      notifications: true,
      sound: false,
      badge: true,
      cleanup: true
    })
    render(<Settings onClose={vi.fn()} section="notifications" />)
    const list = await switches()
    const keys = within(list).getByRole('group', { name: 'Hear each sound' })
    expect(within(keys).getAllByRole('button').map((b) => b.textContent)).toEqual(['Finished', 'Asks you', 'Failed'])

    await userEvent.click(within(keys).getByRole('button', { name: 'Asks you' }))
    expect(window.cockpit.playSound).toHaveBeenCalledWith('asks')
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Played the sound for an agent asking you'))

    vi.mocked(window.cockpit.playSound).mockRejectedValueOnce(new Error('no speaker'))
    await userEvent.click(within(keys).getByRole('button', { name: 'Failed' }))
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Could not play the sound: no speaker'))
  })

  it('never says it played a sound nobody heard', async () => {
    render(<Settings onClose={vi.fn()} section="notifications" />)
    const keys = within(await switches()).getByRole('group', { name: 'Hear each sound' })

    vi.mocked(window.cockpit.playSound).mockResolvedValueOnce({ played: false, why: 'muted' })
    await userEvent.click(within(keys).getByRole('button', { name: 'Finished' }))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        /The sound for a finished turn is silent: the Alert volume in System Settings › Sound is at zero/
      )
    )
    expect(screen.getByRole('status')).not.toHaveTextContent(/Played/)

    vi.mocked(window.cockpit.playSound).mockResolvedValueOnce({
      played: false,
      why: 'failed',
      message: 'Command failed: /usr/bin/afplay'
    })
    await userEvent.click(within(keys).getByRole('button', { name: 'Asks you' }))
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Could not play the sound: Command failed: /usr/bin/afplay')
    )
  })

  it('says on screen, not only to a screen reader, why a sound stayed silent', async () => {
    render(<Settings onClose={vi.fn()} section="notifications" />)
    const keys = within(await switches()).getByRole('group', { name: 'Hear each sound' })
    const row = keys.closest('li') as HTMLElement
    expect(row).toHaveTextContent('Plays it once, whether Sound is on or not.')

    vi.mocked(window.cockpit.playSound).mockResolvedValueOnce({ played: false, why: 'muted' })
    await userEvent.click(within(keys).getByRole('button', { name: 'Finished' }))
    await waitFor(() => expect(row).toHaveTextContent(/The sound for a finished turn is silent/))

    // a sound that played needs no words: the row goes back to saying what the keys do
    await userEvent.click(within(keys).getByRole('button', { name: 'Asks you' }))
    await waitFor(() => expect(row).toHaveTextContent('Plays it once, whether Sound is on or not.'))
  })

  it('a development run says the switches start off here', async () => {
    // the stub is a development run already; say so, since that is what's under test
    expect((await window.cockpit.getAppInfo()).packaged).toBe(false)
    render(<Settings onClose={vi.fn()} section="notifications" />)
    const list = await switches()
    await within(list).findByText(/Development run/)
  })
})
