import { describe, it, expect, vi } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Settings } from '../../src/renderer/src/Settings'
import type { AppInfo, UpdateState } from '../../src/shared/types'

const installed: AppInfo = {
  version: '1.4.2',
  packaged: true,
  platform: 'darwin',
  arch: 'arm64',
  electron: '44.2.0',
  releasesUrl: 'https://github.com/tashtit/cockpit/releases'
}

describe('Settings › About', () => {
  it('shows the installed version and checks for updates on demand', async () => {
    vi.mocked(window.cockpit.getAppInfo).mockResolvedValue(installed)
    vi.mocked(window.cockpit.getUpdateState).mockResolvedValue({ status: 'idle' })
    vi.mocked(window.cockpit.checkForUpdates).mockResolvedValue({
      status: 'available',
      version: '1.5.0',
      checkedAt: Date.now()
    })
    render(<Settings onClose={vi.fn()} section="about" />)

    expect(await screen.findByText('v1.4.2')).toBeInTheDocument()
    expect(screen.getByText('installed · arm64')).toBeInTheDocument()
    expect(screen.getByText('Not checked yet.')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Check for updates' }))
    expect(window.cockpit.checkForUpdates).toHaveBeenCalled()
    expect(await screen.findByText('Version 1.5.0 is available.')).toBeInTheDocument()

    // still reachable by hand, which is all there is when auto-download is off
    await userEvent.click(screen.getByRole('button', { name: 'Download 1.5.0' }))
    expect(window.cockpit.downloadUpdate).toHaveBeenCalled()
  })

  it('follows pushed state from download progress to restart', async () => {
    const pushed: { cb: ((s: UpdateState) => void) | null } = { cb: null }
    vi.mocked(window.cockpit.onUpdateState).mockImplementation((cb) => {
      pushed.cb = cb
      return () => {}
    })
    vi.mocked(window.cockpit.getAppInfo).mockResolvedValue(installed)
    vi.mocked(window.cockpit.getUpdateState).mockResolvedValue({ status: 'idle' })
    render(<Settings onClose={vi.fn()} section="about" />)
    await screen.findByText('v1.4.2')

    act(() => pushed.cb?.({ status: 'downloading', version: '1.5.0', percent: 42 }))
    expect(screen.getByText('Downloading 1.5.0 · 42%')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Downloading…' })).toBeDisabled()

    act(() => pushed.cb?.({ status: 'ready', version: '1.5.0' }))
    expect(screen.getByRole('status')).toHaveTextContent('1.5.0 downloaded')
    // the quit that was going to happen anyway is the install; the button is only sooner
    expect(screen.getByText(/installs when you quit Cockpit/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Restart now' }))
    expect(window.cockpit.installUpdate).toHaveBeenCalled()
  })

  it('keeps checking reachable with a build already downloaded', async () => {
    const pushed: { cb: ((s: UpdateState) => void) | null } = { cb: null }
    vi.mocked(window.cockpit.onUpdateState).mockImplementation((cb) => {
      pushed.cb = cb
      return () => {}
    })
    vi.mocked(window.cockpit.getAppInfo).mockResolvedValue(installed)
    vi.mocked(window.cockpit.getUpdateState).mockResolvedValue({ status: 'ready', version: '1.5.0' })
    vi.mocked(window.cockpit.checkForUpdates).mockResolvedValue({
      status: 'available',
      version: '1.6.0',
      checkedAt: Date.now()
    })
    render(<Settings onClose={vi.fn()} section="about" />)
    await screen.findByText('v1.4.2')

    // a downloaded build is not the end of updating: a newer release has to stay
    // reachable without installing this one first
    await userEvent.click(screen.getByRole('button', { name: 'Check again' }))
    expect(window.cockpit.checkForUpdates).toHaveBeenCalled()
    expect(await screen.findByText('Version 1.6.0 is available.')).toBeInTheDocument()
  })

  it('says a check failed after the build it could not better, never in place of it', async () => {
    vi.mocked(window.cockpit.getAppInfo).mockResolvedValue(installed)
    vi.mocked(window.cockpit.getUpdateState).mockResolvedValue({
      status: 'ready',
      version: '1.5.0',
      message: 'net::ERR_INTERNET_DISCONNECTED'
    })
    render(<Settings onClose={vi.fn()} section="about" />)

    expect(
      await screen.findByText(/downloaded.*Could not check for a newer one: net::ERR_INTERNET_DISCONNECTED/)
    ).toBeInTheDocument()
    // and the build is still one press from installed
    expect(screen.getByRole('button', { name: 'Restart now' })).toBeEnabled()
  })

  it('offers the two automatic steps as switches, and saves a flip', async () => {
    vi.mocked(window.cockpit.getAppInfo).mockResolvedValue(installed)
    vi.mocked(window.cockpit.getUpdateState).mockResolvedValue({ status: 'idle' })
    vi.mocked(window.cockpit.setUpdatePrefs).mockResolvedValue({ download: false, install: true })
    render(<Settings onClose={vi.fn()} section="about" />)

    const auto = await screen.findByRole('checkbox', { name: 'Download updates automatically' })
    const onQuit = screen.getByRole('checkbox', { name: 'Install when I quit' })
    expect(auto).toBeChecked()
    expect(onQuit).toBeChecked()

    await userEvent.click(auto)
    expect(window.cockpit.setUpdatePrefs).toHaveBeenCalledWith({ download: false, install: true })
    expect(auto).not.toBeChecked()
    expect(screen.getByRole('status')).toHaveTextContent('Download updates automatically off')
  })

  it('says a rolled-back install is why nothing is happening on its own', async () => {
    vi.mocked(window.cockpit.getAppInfo).mockResolvedValue(installed)
    vi.mocked(window.cockpit.getUpdateState).mockResolvedValue({
      status: 'idle',
      installFailure: 'Could not move /Applications/Cockpit.app aside.'
    })
    render(<Settings onClose={vi.fn()} section="about" />)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /put back: Could not move \/Applications\/Cockpit.app aside\./
    )
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeEnabled()
  })

  it('reports a failed check without hiding the retry', async () => {
    const pushed: { cb: ((s: UpdateState) => void) | null } = { cb: null }
    vi.mocked(window.cockpit.onUpdateState).mockImplementation((cb) => {
      pushed.cb = cb
      return () => {}
    })
    vi.mocked(window.cockpit.getAppInfo).mockResolvedValue(installed)
    vi.mocked(window.cockpit.getUpdateState).mockResolvedValue({ status: 'idle' })
    render(<Settings onClose={vi.fn()} section="about" />)
    await screen.findByText('v1.4.2')

    act(() => pushed.cb?.({ status: 'error', message: 'net::ERR_INTERNET_DISCONNECTED' }))
    expect(screen.getByText(/Update check failed: net::ERR_INTERNET_DISCONNECTED/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check for updates' })).toBeEnabled()
  })

  it('explains that a development run cannot update, with no controls to press', async () => {
    // the stub's defaults are the dev-run shape: 0.0.0, not packaged, unsupported
    render(<Settings onClose={vi.fn()} section="about" />)
    expect(await screen.findByText('v0.0.0')).toBeInTheDocument()
    expect(screen.getByText('development run')).toBeInTheDocument()
    expect(screen.getByText(/installed builds only/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Check for updates' })).toBeNull()
    // nothing to switch on either: this build could not act on them
    expect(screen.queryByRole('checkbox', { name: 'Install when I quit' })).toBeNull()
  })

  it('opens the release notes externally', async () => {
    vi.mocked(window.cockpit.getAppInfo).mockResolvedValue(installed)
    render(<Settings onClose={vi.fn()} section="about" />)
    await userEvent.click(await screen.findByRole('button', { name: 'Release notes' }))
    expect(window.cockpit.openExternal).toHaveBeenCalledWith(installed.releasesUrl)
  })

  it('opens the third-party notices, and says why when it cannot', async () => {
    vi.mocked(window.cockpit.getAppInfo).mockResolvedValue(installed)
    vi.mocked(window.cockpit.getUpdateState).mockResolvedValue({ status: 'idle' })
    vi.mocked(window.cockpit.openLicenseNotices).mockResolvedValueOnce(null)
    render(<Settings onClose={vi.fn()} section="about" />)
    await screen.findByText('v1.4.2')

    const link = screen.getByRole('button', { name: 'Open source licenses' })
    await userEvent.click(link)
    expect(window.cockpit.openLicenseNotices).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    vi.mocked(window.cockpit.openLicenseNotices).mockResolvedValueOnce('No application can open this file.')
    await userEvent.click(link)
    expect(await screen.findByRole('alert')).toHaveTextContent('No application can open this file.')
  })
})
