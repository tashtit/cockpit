import { useEffect, useState, type JSX } from 'react'
import type { CliStatus } from '../../shared/types'
import { compareVersions, homebrewUpdateCommand, runsHomebrew } from '../../shared/agent-cli'
import { shortPath } from '../../shared/library'
import { ErrorAlert } from './ErrorAlert'
import { ProviderMark, PROVIDER_LABEL } from './logos'
import { useCliUpdates } from './use-cli-updates'
import { api } from './api'

/**
 * The agent CLIs themselves — what Cockpit actually runs: the version here against the
 * latest release, how it was installed, and the update, run in Terminal the way that
 * install expects (Homebrew, npm, or the CLI's own updater). Desktop-owned tools show
 * their app as the update owner and offer no independent update. Checked when the tab opens
 * (the latest release is cached for an hour), and watched after an update until the
 * new version shows (`useCliUpdates`, which the home's updates list shares).
 */
export function AgentClis({ onStatus }: { onStatus: (s: string) => void }): JSX.Element {
  const [clis, setClis] = useState<readonly CliStatus[] | null>(null)
  const [checking, setChecking] = useState(false)
  const cli = useCliUpdates({ onChecked: setClis, onStatus })
  const { updating, refreshing } = cli

  const load = (force: boolean): void => {
    setChecking(true)
    void api
      .listCliStatus(force)
      .then((next) => {
        setClis(next)
        cli.settle(next)
      })
      .catch(() => setClis([]))
      .finally(() => setChecking(false))
  }
  useEffect(() => load(false), [])

  // Two Homebrew CLIs behind: one window can update both — one `brew update`, no turns
  // to take. Not one already opened on its own; that window has it.
  const together = (clis ?? []).filter(
    (c) =>
      c.updateAvailable &&
      c.updateCommand !== null &&
      runsHomebrew(c.updateCommand) &&
      updating[c.provider] === undefined
  )
  const togetherNames = together.map((c) => PROVIDER_LABEL[c.provider]).join(' and ')

  return (
    <>
      <h3 className="ns-label">Agent CLIs</h3>
      <p className="ns-hint ns-prose">
        The command-line tools Cockpit runs for sessions and roundtables. It can reuse the
        desktop apps’ copies, which update through those apps.{' '}
        <button className="link-btn" disabled={checking} onClick={() => load(true)}>
          {checking ? 'Checking…' : 'Check for updates'}
        </button>
        {together.length > 1 && (
          <>
            <span className="link-sep" aria-hidden="true">·</span>
            <button
              className="link-btn"
              title={homebrewUpdateCommand(together) ?? undefined}
              onClick={() => void cli.updateTogether(together)}
            >
              Update {togetherNames} together…
            </button>
          </>
        )}
      </p>
      {cli.error && <ErrorAlert>{cli.error}</ErrorAlert>}
      <ul className="source-list">
        {clis === null ? (
          <li className="source-row"><span className="ns-hint">checking…</span></li>
        ) : (
          clis.map((c) => (
            <li key={c.provider} className={`source-row tint-${c.provider}`}>
              <ProviderMark p={c.provider} decorative />
              <div className="source-body">
                <div className="source-label">
                  {PROVIDER_LABEL[c.provider]}
                  {c.version && <span className={`acct-chip acct-${c.provider}`}>{c.version}</span>}
                  {c.channel && <span className="source-origin">via {c.channel}</span>}
                </div>
                {c.path && <div className="source-path" title={c.path}>{shortPath(c.path)}</div>}
                {updating[c.provider] !== undefined && (
                  <div className="source-note">
                    {cli.inTerminal('Finish the update in the Terminal window', c.provider, clis)}
                  </div>
                )}
                {/* a channel can lag the release: say so, rather than offer an update
                    that `brew upgrade` can't deliver. Homebrew only knows what its last
                    `brew update` fetched, so that much can be refreshed from here */}
                {!c.updateAvailable &&
                  c.installed &&
                  c.upstream !== null &&
                  c.version !== null &&
                  compareVersions(c.upstream, c.version) > 0 && (
                    <div className="source-note">
                      {refreshing[c.provider] !== undefined ? (
                        cli.inTerminal('Refreshing in the Terminal window', c.provider, clis)
                      ) : (
                        <>
                          {c.upstream} is out, but {c.channel} hasn’t packaged it yet — this is as
                          new as {c.channel} goes.
                        </>
                      )}{' '}
                      {(c.install === 'brew-cask' || c.install === 'brew-formula') && (
                        <button
                          className="link-btn"
                          title="Runs `brew update` in a terminal — it only refreshes what Homebrew knows about"
                          onClick={() => void cli.refreshChannel(c)}
                        >
                          {refreshing[c.provider] !== undefined
                            ? 'Open Terminal again'
                            : `Refresh ${c.channel}`}
                        </button>
                      )}
                    </div>
                  )}
              </div>
              <div className="source-health">
                {!c.installed ? (
                  <span className="source-warn">not installed</span>
                ) : c.install === 'desktop' ? (
                  <span title={`Open ${c.channel} to check for updates`}>updated by desktop app</span>
                ) : c.updateAvailable ? (
                  <>
                    <span className="source-warn">{c.latest} available</span>
                    <button
                      className="btn-ghost small"
                      title={c.updateCommand ?? undefined}
                      onClick={() => void cli.update(c.provider, c.version)}
                    >
                      {updating[c.provider] !== undefined ? 'Open Terminal again' : 'Update…'}
                    </button>
                  </>
                ) : c.latest === null ? (
                  <span>couldn’t check {c.channel ?? 'for updates'}</span>
                ) : (
                  <span>up to date</span>
                )}
              </div>
            </li>
          ))
        )}
      </ul>
    </>
  )
}
