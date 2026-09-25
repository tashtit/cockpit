import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { COCKPIT_REPO_URL } from '../shared/feedback'
import type { AppInfo, UpdateInstallOutcome, UpdatePrefs, UpdateState } from '../shared/types'
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
import { checkOutcome, pickZip, type CheckResult, type FeedFile } from './update-install-core'

/** Where releases live — the updater's feed and the only place release notes are kept. */
export const RELEASES_URL = `${COCKPIT_REPO_URL}/releases`

/** The launch check waits for the index to settle; afterwards a quiet periodic one. */
const FIRST_CHECK_DELAY_MS = 20_000
const CHECK_INTERVAL_MS = 4 * 60 * 60_000
/** Longer than any answer GitHub Releases gives; past it the check is given up on. */
const CHECK_TIMEOUT_MS = 60_000

/**
 * An update check with a deadline, and answers taken only while a check still waits
 * for them. electron-updater's own request timeout never starts under Electron's
 * `net` — builder-util-runtime arms it on a `'socket'` event that Electron's requests
 * never emit — so a request that got no answer left the row at `checking` for good,
 * and every later check returned early on `checking` until a restart.
 */
export class CheckGate {
  private seq = 0
  /** The check an answer arriving now belongs to; null once it settled or was given up on */
  private current: number | null = null

  constructor(private readonly timeoutMs: number) {}

  /** Whether anything is still waiting for an answer — one given up on is not. */
  get open(): boolean {
    return this.current !== null
  }

  /**
   * Run `check` against the deadline. Past it the check is given up on and `onTimeout`
   * runs; the check settling later is ignored, as are the answers it brings with it.
   * A rejection inside the deadline is the caller's to handle.
   */
  async run(check: () => Promise<unknown>, onTimeout: () => void): Promise<void> {
    const id = ++this.seq
    this.current = id
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.timeoutMs)
      // a check still pending must never keep the process alive on its own
      timer.unref()
    })
    try {
      const outcome = await Promise.race([check().then(() => 'answered' as const), deadline])
      if (outcome === 'timeout' && this.current === id) {
        this.current = null
        onTimeout()
      }
    } finally {
      clearTimeout(timer)
      if (this.current === id) this.current = null
    }
  }
}

/**
 * electron-updater hands every check made while one is pending that same pending
 * promise, so a request that never answers would answer no later check either: let go
 * of it, and the next check sends a request of its own. The slot is private — renamed
 * in some release, this does nothing, and each later check times out the same way.
 */
function abandonPendingCheck(): void {
  const updater = autoUpdater as unknown as { checkForUpdatesPromise?: unknown }
  if ('checkForUpdatesPromise' in updater) updater.checkForUpdatesPromise = null
}

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
 *
 * Checking never stops, not even with a build downloaded and waiting: that build is
 * the answer to a check that turns up the same version (it is never fetched twice)
 * or none at all, but a release newer than it supersedes it and takes its place on
 * disk. Exactly one download is ever kept, and one that will not be installed —
 * interrupted by a quit, or a version this app has since passed — goes at launch.
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
  private readonly gate = new CheckGate(CHECK_TIMEOUT_MS)

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
    // `ready` is deliberately not among these: a build waiting to be installed
    // must never be what stops Cockpit from learning that a newer one exists.
    // The three that are have nothing a check could act on — one is already in
    // flight, bytes are coming down, or the swap is armed and the app is leaving.
    if (s === 'unsupported' || s === 'checking' || s === 'downloading' || this.armed) {
      return this.state
    }
    try {
      await this.gate.run(
        () => autoUpdater.checkForUpdates(),
        () => {
          abandonPendingCheck()
          this.checked({ kind: 'failed', message: 'GitHub Releases did not answer within a minute.' })
        }
      )
    } catch (err) {
      this.checked({ kind: 'failed', message: err instanceof Error ? err.message : String(err) })
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

  /**
   * Quit, swap the new build in and reopen it — only once one is downloaded, and
   * never under running agent turns unless the request says to stop them: this is
   * one click on a prompt that stays up for as long as the build waits, and the
   * quit takes every turn Cockpit is running down with it.
   *
   * What decides is the build on disk, not the status: a check run with it already
   * downloaded reports `checking` for a moment, and a restart asked for in that
   * moment is still a restart into that build.
   */
  install(req: { readonly runningTurns: number; readonly stopRunning: boolean }): UpdateInstallOutcome {
    if (!this.staged || this.armed) return { restarting: false }
    if (req.runningTurns > 0 && !req.stopRunning) return { restarting: false, runningTurns: req.runningTurns }
    const target = runningBundle()
    if (!target) return { restarting: false }
    try {
      armSwap(this.staged, target, true)
      this.armed = true
    } catch (err) {
      this.fail(err)
      return { restarting: false }
    }
    app.quit()
    return { restarting: true }
  }

  /**
   * Called on the way out: a downloaded build swaps itself in behind the quit the
   * user already asked for. Nothing is interrupted — by here the agents Cockpit
   * spawned are going away regardless.
   */
  installOnQuit(): void {
    // what is on disk decides, not what the row last said: a check that could not
    // reach GitHub must not cost an offline Mac the update it already has. A swap
    // that rolled back is the one downloaded build never handed over again.
    if (this.armed || !this.staged || !this.prefs.install || this.failure) return
    const target = runningBundle()
    if (!target) return
    try {
      armSwap(this.staged, target, false)
      this.armed = true
    } catch (err) {
      console.error('[updates] could not hand over the install:', err)
    }
  }

  /**
   * Act on what a check came back with. Weighing it against a build already
   * downloaded is `checkOutcome`'s decision; what is left here is carrying it out —
   * fetch a newer release if that is the switch, and let a superseded download go.
   */
  private checked(result: CheckResult): void {
    const { state, sweep } = checkOutcome(result, this.staged?.version ?? null, Date.now())
    this.set(state)
    if (state.status !== 'available') return
    // a download clears the stage dir itself, and an rm racing it would take the
    // new build with it — so a superseded one is only swept when none follows
    if (this.prefs.download && !this.failure) void this.download()
    else if (sweep) this.dropStaged()
  }

  /** Let go of a downloaded build nobody is going to install, and its ~300MB with it. */
  private dropStaged(): void {
    this.staged = null
    void discardStaged()
  }

  private wire(): void {
    // electron-updater never downloads or installs here: both are Cockpit's own
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.allowPrerelease = false
    autoUpdater.on('checking-for-update', () => this.set({ status: 'checking' }))
    // an answer to a check that was given up on comes after the row moved on — to
    // the timeout's failure, or whatever followed it — and must not replace that
    autoUpdater.on('update-available', (info) => {
      if (!this.gate.open) return
      this.offered = pickZip((info.files ?? []) as FeedFile[], process.arch)
      // a release with no zip for this Mac is nothing this build can act on, so
      // it is reported the way an unreachable feed is rather than as an offer
      this.checked(
        this.offered
          ? { kind: 'offer', version: info.version }
          : {
              kind: 'failed',
              message: `Release ${info.version} publishes nothing for this Mac (${process.arch}).`
            }
      )
    })
    autoUpdater.on('update-not-available', () => {
      if (this.gate.open) this.checked({ kind: 'none' })
    })
    // still listened to when nothing waits: an 'error' with no listener throws
    autoUpdater.on('error', (err) => {
      if (!this.gate.open) return
      this.checked({ kind: 'failed', message: err instanceof Error ? err.message : String(err) })
    })

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
    // resuming also sweeps: anything left in the stage dir that is not going to be
    // installed is hundreds of MB, and this is the only pass that reaches it
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

  /** A download or a swap that failed — a check reports itself through `checked`. */
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
    // Electron's own reading of the product version; os.release() is Darwin's
    osVersion: process.getSystemVersion(),
    arch: process.arch,
    electron: process.versions.electron ?? '',
    releasesUrl: RELEASES_URL
  }
}
