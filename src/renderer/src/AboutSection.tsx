import { useEffect, useState, type JSX } from 'react'
import type { AppInfo, UpdatePrefs, UpdateState } from '../../shared/types'
import { api } from './api'
import { fmtAgo } from './format'
import { ipcErrorText } from './ipc-error'
import { CockpitLogo } from './logos'

const UPDATE_SWITCHES: ReadonlyArray<{
  readonly key: keyof UpdatePrefs
  readonly label: string
  readonly note: string
}> = [
  {
    key: 'download',
    label: 'Download updates automatically',
    note: 'Fetch a new release as soon as a check finds one, in the background. Off leaves the download to you.'
  },
  {
    key: 'install',
    label: 'Install when I quit',
    note: 'Swap the downloaded build in on the way out, so the next launch is the new one. Never under a running session — and “Restart now” installs it sooner.'
  }
]

/** The About row's one-line readout of where the updater stands. */
export function updateLine(u: UpdateState | null, prefs: UpdatePrefs | null): string {
  if (!u) return 'loading…'
  switch (u.status) {
    case 'unsupported':
      return u.message ?? 'Updates are not available in this build.'
    case 'idle':
      return 'Not checked yet.'
    case 'checking':
      return 'Checking for updates…'
    case 'up-to-date':
      return `Up to date${u.checkedAt ? ` — checked ${fmtAgo(u.checkedAt)}` : ''}`
    case 'available':
      return `Version ${u.version} is available.`
    case 'downloading':
      return `Downloading ${u.version} · ${u.percent ?? 0}%`
    case 'ready':
      return prefs?.install
        ? `Version ${u.version} is downloaded — it installs when you quit Cockpit.`
        : `Version ${u.version} is downloaded — restart to install.`
    case 'error':
      return u.version ? `Could not install ${u.version}: ${u.message}` : `Update check failed: ${u.message}`
  }
}

/**
 * The About tab: what this build is, and the whole of the updater's control surface.
 *
 * The update state itself is the shell's, not this tab's — main pushes transitions
 * whether or not About is the tab on screen, and the card's status region has to
 * announce them from wherever the user is.
 */
export function AboutSection({
  appInfo,
  update,
  onUpdate,
  onStatus
}: {
  appInfo: AppInfo | null
  update: UpdateState | null
  onUpdate: (u: UpdateState) => void
  onStatus: (s: string) => void
}): JSX.Element {
  const [prefs, setPrefs] = useState<UpdatePrefs | null>(null)
  const [licensesError, setLicensesError] = useState<string | null>(null)

  useEffect(() => {
    void api.getUpdatePrefs().then(setPrefs)
  }, [])

  const checkUpdates = async (): Promise<void> => {
    onUpdate({ status: 'checking' })
    onUpdate(await api.checkForUpdates())
  }
  const downloadUpdate = async (): Promise<void> => {
    onUpdate(await api.downloadUpdate())
  }
  const flipUpdatePref = async (key: keyof UpdatePrefs, on: boolean): Promise<void> => {
    if (!prefs) return
    const name = UPDATE_SWITCHES.find((u) => u.key === key)?.label ?? key
    const next = { ...prefs, [key]: on }
    setPrefs(next)
    try {
      setPrefs(await api.setUpdatePrefs(next))
      onStatus(`${name} ${on ? 'on' : 'off'}`)
    } catch (err) {
      setPrefs(prefs)
      onStatus(`Could not change ${name}: ${ipcErrorText(err)}`)
    }
  }

  /** The About row's single action — one control at a time, so heights never mix. */
  const updateAction = (u: UpdateState): JSX.Element | null => {
    switch (u.status) {
      case 'idle':
      case 'up-to-date':
      case 'error':
        return (
          <button className="btn-ghost small" onClick={() => void checkUpdates()}>
            Check for updates
          </button>
        )
      case 'checking':
        return (
          <button className="btn-ghost small" disabled>
            Checking…
          </button>
        )
      case 'available':
        return (
          <button className="btn-ghost small" onClick={() => void downloadUpdate()}>
            Download {u.version}
          </button>
        )
      case 'downloading':
        return (
          <button className="btn-ghost small" disabled>
            Downloading…
          </button>
        )
      case 'ready':
        return (
          <button className="btn-ghost small" onClick={() => void api.installUpdate()}>
            Restart now
          </button>
        )
      case 'unsupported':
        return null
    }
  }

  return (
    <>
      <ul className="source-list">
        <li className="source-row">
          <span className="plogo" aria-hidden="true">
            <CockpitLogo size={13} />
          </span>
          <div className="source-body">
            <div className="source-label">
              Cockpit
              {appInfo && <span className="acct-chip">v{appInfo.version}</span>}
              {appInfo && (
                <span className="source-origin">
                  {appInfo.packaged ? `installed · ${appInfo.arch}` : 'development run'}
                </span>
              )}
            </div>
            <div className="source-note">{updateLine(update, prefs)}</div>
          </div>
          <div className="source-health">{update && updateAction(update)}</div>
        </li>
        {update?.status !== 'unsupported' &&
          UPDATE_SWITCHES.map((u) => (
            <li key={u.key}>
              <label className="source-row attn-switch">
                {/* same recipe as the notification switches: the row is the click
                    target, but the name is the label span alone */}
                <input
                  type="checkbox"
                  checked={prefs?.[u.key] ?? false}
                  disabled={prefs === null}
                  aria-labelledby={`upd-${u.key}-label`}
                  aria-describedby={`upd-${u.key}-note`}
                  onChange={(e) => void flipUpdatePref(u.key, e.currentTarget.checked)}
                />
                <span className="source-body">
                  <span className="source-label" id={`upd-${u.key}-label`}>
                    {u.label}
                  </span>
                  <span className="source-note" id={`upd-${u.key}-note`}>
                    {u.note}
                  </span>
                </span>
              </label>
            </li>
          ))}
      </ul>
      {update?.installFailure && (
        <div role="alert" className="new-error">
          The last update could not be installed, so the version you had was put back:{' '}
          {update.installFailure} Nothing downloads on its own until you check for updates
          again.
        </div>
      )}
      <p className="ns-hint ns-prose">
        Installed builds check GitHub Releases on launch and every few hours, then keep
        themselves current on their own. Cockpit downloads and installs its own updates rather
        than leaving it to macOS, which is what lets it clear the quarantine flag Gatekeeper
        would otherwise block the new build on.{' '}
        {appInfo && (
          <>
            <button
              className="link-btn"
              onClick={() => void api.openExternal(appInfo.releasesUrl)}
            >
              Release notes
            </button>
            <span className="link-sep" aria-hidden="true">·</span>
          </>
        )}
        <button
          className="link-btn"
          onClick={() => {
            setLicensesError(null)
            void api.openLicenseNotices().then(setLicensesError)
          }}
        >
          Open source licenses
        </button>
      </p>
      {licensesError && (
        <div role="alert" className="new-error">
          {licensesError}
        </div>
      )}
    </>
  )
}
