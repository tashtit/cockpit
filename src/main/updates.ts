import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { AppInfo, UpdatePrefs, UpdateState } from '../shared/types'
import { updatePrefs } from './config'
import {
  armSwap,
  clearInstallResult,
  discardStaged,
  readInstallResult,
  resumeStaged,
  runningBundle,
  stageUpdate,
  type Staged
} from './update-install'
import { pickZip, type FeedFile } from './update-install-core'

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
 * `latest-mac.yml` off the newest release and compares versions — that check is all
 * it is used for here. Downloading and installing are Cockpit's own
 * (`update-install.ts`), because electron-updater's macOS installer is Squirrel.Mac,
 * which only ever swaps in a bundle whose Developer ID signature matches the running
 * one, and Cockpit's releases are ad-hoc signed while it is pre-1.0. Doing it here
 * is also what lets the quarantine flag be cleared before the new app lands instead
 * of leaving Gatekeeper to block it afterwards.
 *
 * Left alone it keeps itself current: it checks on launch and every four hours,
 * fetches what it finds, and swaps the new build in the next time you quit. Both of
 * those are switches (Settings › About) and neither ever interrupts a session — the
 * swap happens when Cockpit is on its way out, never under a running agent.
 */
export class UpdateManager {
  private state: UpdateState
  private prefs: UpdatePrefs
  /** The zip the current offer resolves to, kept from the check that found it */
  private offered: FeedFile | null = null
  private staged: Staged | null = null
  /** Why the last swap rolled back; suppresses the automatic path until cleared */
  private failure: string | null = null
  /** The script is spawned once — quitting to install must not spawn a second */
  private armed = false

  constructor(private readonly onChange: (state: UpdateState) => void) {
    this.state = initialState()
    this.prefs = updatePrefs()
    if (this.state.status !== 'unsupported') this.wire()
  }

  get current(): UpdateState {
    return this.state
  }

  get currentPrefs(): UpdatePrefs {
    return this.prefs
  }

  setPrefs(next: UpdatePrefs): UpdatePrefs {
    this.prefs = next
    // switching auto-download on with an offer already on the table acts on it now
    if (next.download && this.state.status === 'available') void this.download()
    return this.prefs
  }

  /**
   * Ask GitHub Releases for a newer build. Asked for by hand this also forgets a
   * rolled-back install: the user choosing to check again is the one signal that
   * the automatic path should be allowed to try once more.
   */
  async check(): Promise<UpdateState> {
    if (this.failure) {
      this.failure = null
      void clearInstallResult()
      // the download itself was fine — the swap is what rolled back — so it is
      // offered again rather than fetched a second time
      this.set(this.staged ? { status: 'ready', version: this.staged.version } : { status: 'idle' })
    }
    return this.runCheck()
  }

  private async runCheck(): Promise<UpdateState> {
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

  /** Fetch the offered build and verify it; progress streams through `downloading`. */
  async download(): Promise<UpdateState> {
    if (this.state.status !== 'available' || !this.offered) return this.state
    const version = this.state.version ?? ''
    // staging clears the dir first, so whatever was there stops being installable now
    this.staged = null
    this.set({ status: 'downloading', version, percent: 0 })
    try {
      const bundle = runningBundle()
      if (!bundle) throw new Error('Cockpit is not running from an application bundle')
      this.staged = await stageUpdate({
        version,
        file: this.offered,
        releasesUrl: RELEASES_URL,
        bundle,
        onProgress: (percent) => {
          if (this.state.status === 'downloading') this.set({ status: 'downloading', version, percent })
        }
      })
      this.set({ status: 'ready', version: this.staged.version })
    } catch (err) {
      void discardStaged()
      this.fail(err)
    }
    return this.state
  }

  /** Quit, swap the new build in and reopen it — only once one is downloaded. */
  install(): boolean {
    if (this.state.status !== 'ready' || !this.staged || this.armed) return false
    const target = runningBundle()
    if (!target) return false
    try {
      armSwap(this.staged, target, true)
      this.armed = true
    } catch (err) {
      this.fail(err)
      return false
    }
    app.quit()
    return true
  }

  /**
   * Called on the way out: a downloaded build swaps itself in behind the quit the
   * user already asked for. Nothing is interrupted — by here the agents Cockpit
   * spawned are going away regardless.
   */
  installOnQuit(): void {
    if (this.armed || !this.staged || !this.prefs.install) return
    if (this.state.status !== 'ready') return
    const target = runningBundle()
    if (!target) return
    try {
      armSwap(this.staged, target, false)
      this.armed = true
    } catch (err) {
      console.error('[updates] could not hand over the install:', err)
    }
  }

  private wire(): void {
    // electron-updater never downloads or installs here: both are Cockpit's own
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.allowPrerelease = false
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking' }))
    autoUpdater.on('update-available', (info) => {
      this.offered = pickZip((info.files ?? []) as FeedFile[], process.arch)
      if (!this.offered) {
        this.set({
          status: 'error',
          version: info.version,
          message: `Release ${info.version} publishes nothing for this Mac (${process.arch}).`,
          checkedAt: Date.now()
        })
        return
      }
      this.set({ status: 'available', version: info.version, checkedAt: Date.now() })
      if (this.prefs.download && !this.failure) void this.download()
    })
    autoUpdater.on('update-not-available', () =>
      this.set({ status: 'up-to-date', checkedAt: Date.now() })
    )
    autoUpdater.on('error', (err) => this.fail(err))

    void this.restore()

    // unref'd: a pending check must never keep the process alive after the last window closes
    const first = setTimeout(() => {
      void this.runCheck()
      setInterval(() => void this.runCheck(), CHECK_INTERVAL_MS).unref()
    }, FIRST_CHECK_DELAY_MS)
    first.unref()
  }

  /** What the last run left behind: a rolled-back install, or a download to reuse. */
  private async restore(): Promise<void> {
    this.failure = await readInstallResult()
    const staged = await resumeStaged(app.getVersion())
    if (staged) this.staged = staged
    // a rolled-back install holds the offer back until it is asked for by hand,
    // but the build stays staged so saying yes again costs no second download
    if (this.failure) this.set({ status: 'idle' })
    else if (staged) this.set({ status: 'ready', version: staged.version })
  }

  private set(next: UpdateState): void {
    this.state = this.failure ? { ...next, installFailure: this.failure } : next
    this.onChange(this.state)
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
