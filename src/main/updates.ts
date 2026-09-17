import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { AppInfo, UpdateState } from '../shared/types'

/** Where releases live — the updater's feed and the only place release notes are kept. */
export const RELEASES_URL = 'https://github.com/tashtit/cockpit/releases'

/** The launch check waits for the index to settle; afterwards a quiet periodic one. */
const FIRST_CHECK_DELAY_MS = 20_000
const CHECK_INTERVAL_MS = 4 * 60 * 60_000

/**
 * Only an installed macOS build can update itself: `npm run dev` and the e2e runs
 * against out/ are not bundles, and nothing is published for Linux. Everything else
 * reports why and never touches the network.
 */
function initialState(): UpdateState {
  if (!app.isPackaged) {
    return {
      status: 'unsupported',
      message: 'Updates apply to installed builds only — this is a development run.'
    }
  }
  if (process.platform !== 'darwin') {
    return { status: 'unsupported', message: 'Releases are published for macOS only.' }
  }
  return { status: 'idle' }
}

/**
 * App updates from GitHub Releases. electron-updater reads the bundle's
 * `app-update.yml` (electron-builder writes it from the `publish` config), fetches
 * `latest-mac.yml` off the newest release and compares versions. Nothing downloads
 * until the user asks — autoDownload is off on purpose: this is a developer tool
 * that spawns agents, and a silent 100 MB fetch is not ours to start — but a
 * downloaded update installs itself on the next quit either way.
 *
 * macOS refuses to swap in a bundle that is not code-signed, so an unsigned release
 * ends in the `error` state at install time (CONTRIBUTING.md, "Releases").
 */
export class UpdateManager {
  private state: UpdateState

  constructor(private readonly onChange: (state: UpdateState) => void) {
    this.state = initialState()
    if (this.state.status !== 'unsupported') this.wire()
  }

  get current(): UpdateState {
    return this.state
  }

  /** Ask GitHub Releases for a newer build; a no-op while one is in flight or ready. */
  async check(): Promise<UpdateState> {
    const s = this.state.status
    if (s === 'unsupported' || s === 'checking' || s === 'downloading' || s === 'ready') {
      return this.state
    }
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      this.fail(err)
    }
    return this.state
  }

  /** Fetch the offered build; progress streams through `downloading` into `ready`. */
  async download(): Promise<UpdateState> {
    if (this.state.status !== 'available') return this.state
    this.set({ status: 'downloading', version: this.state.version, percent: 0 })
    try {
      await autoUpdater.downloadUpdate()
    } catch (err) {
      this.fail(err)
    }
    return this.state
  }

  /** Quit and hand over to the installer — only once a build is downloaded. */
  install(): boolean {
    if (this.state.status !== 'ready') return false
    autoUpdater.quitAndInstall()
    return true
  }

  private wire(): void {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = false
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking' }))
    autoUpdater.on('update-available', (info) =>
      this.set({ status: 'available', version: info.version, checkedAt: Date.now() })
    )
    autoUpdater.on('update-not-available', () =>
      this.set({ status: 'up-to-date', checkedAt: Date.now() })
    )
    autoUpdater.on('download-progress', (p) =>
      this.set({ status: 'downloading', version: this.state.version, percent: Math.round(p.percent) })
    )
    autoUpdater.on('update-downloaded', (info) => this.set({ status: 'ready', version: info.version }))
    autoUpdater.on('error', (err) => this.fail(err))

    // unref'd: a pending check must never keep the process alive after the last window closes
    const first = setTimeout(() => {
      void this.check()
      setInterval(() => void this.check(), CHECK_INTERVAL_MS).unref()
    }, FIRST_CHECK_DELAY_MS)
    first.unref()
  }

  private set(next: UpdateState): void {
    this.state = next
    this.onChange(next)
  }

  private fail(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err)
    this.set({ status: 'error', message, version: this.state.version, checkedAt: Date.now() })
  }
}

export function appInfo(): AppInfo {
  return {
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron ?? '',
    releasesUrl: RELEASES_URL
  }
}
