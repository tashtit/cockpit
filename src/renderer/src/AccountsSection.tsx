import { useEffect, useState, type JSX } from 'react'
import type {
  AccountsSnapshot,
  Provider,
  ProviderUsage,
  SourceDir,
  SourceStats,
  UsageSnapshot,
  UsageTokens,
  UsageWindow
} from '../../shared/types'
import { api } from './api'
import { ConfirmRemove, useArmedConfirm } from './ConfirmRemove'
import { fmtAgo, fmtCount, fmtResetIn } from './format'
import { ipcErrorText } from './ipc-error'
import { OrgIcon, ProviderLogo, PROVIDER_LABEL } from './logos'
import { Select } from './Select'

const PROVIDERS: Provider[] = ['claude', 'codex', 'copilot']

/** Where a row's usage numbers come from — the tooltip on its usage readout. */
const USAGE_SOURCE: Record<Provider, string> = {
  claude: 'Measured locally from this home’s session logs',
  codex: 'From the rate-limit snapshots the Codex CLI writes',
  copilot: 'Premium requests from the GitHub billing API'
}

function tokensTitle(t: UsageTokens): string {
  return `input ${fmtCount(t.input)} · output ${fmtCount(t.output)} · cache write ${fmtCount(
    t.cacheCreate
  )} · cache read ${fmtCount(t.cacheRead)}`
}

/** How long ago a measurement was taken — only worth saying once it is stale. */
function measuredAgo(u: ProviderUsage | undefined): string | null {
  if (!u || u.unavailable || u.measuredAt === undefined) return null
  return Date.now() - u.measuredAt > 15 * 60_000 ? fmtAgo(u.measuredAt) : null
}

/** The usage half of an account row: its windows, the reason there are none, or nothing. */
function UsageBody({ u, loading }: { u: ProviderUsage | undefined; loading: boolean }): JSX.Element | null {
  if (!u) return loading ? <div className="source-note">measuring usage…</div> : null
  if (u.unavailable) return <div className="source-note">{u.unavailable}</div>
  return (
    <div className="usage-windows" title={USAGE_SOURCE[u.provider]}>
      {u.windows.map((w) => (
        <UsageWindowRow key={w.label} provider={u.provider} w={w} />
      ))}
    </div>
  )
}

function UsageWindowRow({ provider, w }: { provider: Provider; w: UsageWindow }): JSX.Element {
  const pct = typeof w.usedPercent === 'number' ? Math.round(w.usedPercent) : null
  const idle = w.tokens && w.requests === 0
  return (
    <div className="usage-window">
      <span className="usage-win-label">{w.label}</span>
      {pct !== null && (
        <>
          <span
            className="usage-meter"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-label={`${w.label}: ${pct}% used`}
          >
            <span
              className={`usage-fill usage-fill-${provider}${pct >= 90 ? ' hot' : ''}`}
              style={{ width: `${pct}%` }}
            />
          </span>
          <span className="usage-num">{pct}%</span>
        </>
      )}
      {w.tokens &&
        (idle ? (
          <span>no activity</span>
        ) : (
          <span className="usage-num" title={tokensTitle(w.tokens)}>
            {fmtCount(w.tokens.input + w.tokens.output)} tokens
            {typeof w.requests === 'number' && ` · ${fmtCount(w.requests)} requests`}
          </span>
        ))}
      {!w.tokens && pct === null && typeof w.requests === 'number' && (
        <span className="usage-num">
          {fmtCount(w.requests)} used
          {(w.requestsBilled ?? 0) > 0 && ` · ${fmtCount(w.requestsBilled!)} billed beyond plan`}
        </span>
      )}
      {w.resetsAt && (
        <time dateTime={new Date(w.resetsAt).toISOString()}>{fmtResetIn(w.resetsAt)}</time>
      )}
    </div>
  )
}

/**
 * The Accounts tab: every config home Cockpit watches — who it is signed in as, what
 * that subscription has spent, whether it is healthy — and the `gh` account underneath
 * it, which is an account too and so belongs here rather than after the preferences.
 *
 * It owns its own reads: the tab mounts when it is opened, so nothing here is fetched
 * for someone who came to Settings to flip a switch on another tab.
 */
export function AccountsSection({ onStatus }: { onStatus: (s: string) => void }): JSX.Element {
  const [stats, setStats] = useState<SourceStats[]>([])
  const [accounts, setAccounts] = useState<AccountsSnapshot | null>(null)
  const [usage, setUsage] = useState<UsageSnapshot | null>(null)
  const [path, setPath] = useState('')
  /** The add form is a task, not a permanent fixture: the tab opens as a readout */
  const [addOpen, setAddOpen] = useState(false)
  const [provider, setProvider] = useState<Provider>('claude')
  const [label, setLabel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [lastRemoved, setLastRemoved] = useState<SourceDir | null>(null)
  /** Removal failures get their own slot — `error` belongs to the add form below */
  const [removeError, setRemoveError] = useState<string | null>(null)
  const confirm = useArmedConfirm()

  const refresh = (): void => {
    void api.getSourceStats().then(setStats)
    void api.getAccounts().then(setAccounts)
    api.getUsage().then(setUsage, () => {})
  }
  useEffect(() => {
    refresh()
    // counts stay live while the indexer works
    return api.onIndexUpdated(refresh)
  }, [])

  /** The usage measured for this config home. Copilot reports no path (its quota is
   *  the GitHub account's, not a directory's), so it matches on provider alone. */
  const usageFor = (s: SourceStats): ProviderUsage | undefined =>
    usage?.providers.find(
      (u) => u.provider === s.provider && (u.path === s.path || u.path === '')
    )
  const orphanUsage = (usage?.providers ?? []).filter(
    (u) => !stats.some((s) => usageFor(s) === u)
  )

  const identityOf = (p: string): string | null =>
    accounts?.accounts.find((a) => a.path === p)?.identity ?? null
  const isDefault = (p: string): boolean =>
    accounts?.accounts.find((a) => a.path === p)?.isDefault ?? false

  const add = async (): Promise<void> => {
    const p = path.trim()
    if (!p) return
    setError(null)
    // main quietly keeps a path it already watches (restores lean on that); typed in
    // here it is a slip, so say so instead of announcing an add that changed nothing
    if (stats.some((s) => s.path.replace(/\/+$/, '') === p.replace(/\/+$/, ''))) {
      setError(`Cockpit already watches ${p}.`)
      return
    }
    try {
      await api.addSource(p, provider, label.trim() || `${provider}-extra`)
      setPath('')
      setLabel('')
      setAddOpen(false)
      onStatus(`Added ${label.trim() || p} — indexing started`)
      refresh()
    } catch (err) {
      setError(ipcErrorText(err))
    }
  }

  const browse = async (): Promise<void> => {
    const p = await api.pickDirectory()
    if (p) {
      setPath(p)
      setError(null)
    }
  }

  const remove = async (s: SourceStats): Promise<void> => {
    confirm.disarm()
    setRemoveError(null)
    try {
      await api.removeSource(s.path)
    } catch (err) {
      // its own state, not the add form's: `error` is aria-wired to the Add-source
      // field, so reusing it would announce an untouched input as invalid
      setRemoveError(`Could not remove ${s.label}: ${ipcErrorText(err)}`)
      return
    }
    setLastRemoved({ path: s.path, provider: s.provider, label: s.label })
    onStatus(`Removed ${s.label}`)
    refresh()
  }

  const undoRemove = async (): Promise<void> => {
    if (!lastRemoved) return
    try {
      await api.addSource(lastRemoved.path, lastRemoved.provider, lastRemoved.label)
      onStatus(`Restored ${lastRemoved.label}`)
      setLastRemoved(null)
      refresh()
    } catch (err) {
      setError(ipcErrorText(err))
    }
  }

  const totalSessions = stats.reduce((n, s) => n + s.count, 0)

  return (
    <>
      <h3 className="ns-label">Agent accounts &amp; usage</h3>
      <p className="ns-hint ns-prose">
        One row per config home Cockpit watches: who it&apos;s signed in as, what that
        subscription has spent, and whether it&apos;s healthy. Usage comes from each agent&apos;s
        own logs, or GitHub&apos;s billing API for Copilot; nothing here reads credentials.
        {stats.length > 0 && (
          <> Currently {stats.length} config home{stats.length === 1 ? '' : 's'} · {totalSessions} sessions.</>
        )}
      </p>
      <ul className="source-list">
        {stats.map((s) => (
          <li key={s.path} className={`source-row tint-${s.provider}`}>
            <span className={`plogo plogo-${s.provider}`} aria-hidden="true">
              <ProviderLogo p={s.provider} size={13} />
            </span>
            <div className="source-body">
              <div className="source-label">
                {s.label}
                {identityOf(s.path) ? (
                  <span className={`acct-chip acct-${s.provider}`}>{identityOf(s.path)}</span>
                ) : (
                  <span className="acct-chip missing">not signed in</span>
                )}
                {isDefault(s.path) && <span className="source-origin">auto-detected</span>}
                {usageFor(s)?.plan && (
                  <span className="source-origin">{usageFor(s)?.plan} plan</span>
                )}
                {measuredAgo(usageFor(s)) && (
                  <span className="source-origin">as of {measuredAgo(usageFor(s))}</span>
                )}
              </div>
              <div className="source-path" title={s.path}>{s.path}</div>
              {/* the subscription this home spends — the identity above is whose it is */}
              <UsageBody u={usageFor(s)} loading={usage === null} />
            </div>
            <div className="source-health">
              {s.missing ? (
                <span className="source-warn">path missing</span>
              ) : s.count === 0 ? (
                <span className="source-warn">no sessions yet</span>
              ) : (
                <>
                  <span className="repo-count">{s.count}</span>
                  <span>{s.count === 1 ? 'session' : 'sessions'}</span>
                  {s.lastUpdatedAt && (
                    <time dateTime={new Date(s.lastUpdatedAt).toISOString()}>
                      · active {fmtAgo(s.lastUpdatedAt)}
                    </time>
                  )}
                </>
              )}
            </div>
            <ConfirmRemove
              id={s.path}
              armed={confirm.armed}
              label={`Remove config home ${s.label} — ${s.path}`}
              confirmLabel={`Confirm removing ${s.label} — it won't be re-detected automatically`}
              confirmTitle="Stops indexing this directory. Defaults are only auto-detected on first run — you'd re-add it by hand. Files on disk are untouched."
              onArm={confirm.arm}
              onDisarm={confirm.disarm}
              onConfirm={() => void remove(s)}
            />
          </li>
        ))}
        {stats.length === 0 && (
          <li className="tree-empty">
            no config homes yet — add one below, and Cockpit indexes the sessions it finds
          </li>
        )}
        {/* usage Cockpit measured for a home it no longer indexes still belongs on screen */}
        {orphanUsage.map((u) => (
          <li key={`${u.provider}:${u.path}`} className={`source-row tint-${u.provider}`}>
            <span className={`plogo plogo-${u.provider}`} aria-hidden="true">
              <ProviderLogo p={u.provider} size={13} />
            </span>
            <div className="source-body">
              <div className="source-label">
                {u.label}
                {u.identity && (
                  <span className={`acct-chip acct-${u.provider}`}>{u.identity}</span>
                )}
                {u.plan && <span className="source-origin">{u.plan} plan</span>}
              </div>
              <UsageBody u={u} loading={false} />
            </div>
          </li>
        ))}
      </ul>
      {removeError && (
        <div role="alert" className="new-error">{removeError}</div>
      )}
      {lastRemoved && (
        <p className="ns-hint">
          Removed <code>{lastRemoved.label}</code> ({lastRemoved.path}) —{' '}
          <button className="link-btn" onClick={() => void undoRemove()}>Undo</button>
        </p>
      )}

      {/* adding a config home belongs with the list it extends — and stays folded
          until asked for, so the tab opens as the status readout it is */}
      {!addOpen && (
        <div className="source-add-open">
          <button className="btn-ghost small" onClick={() => setAddOpen(true)}>
            Add a config home…
          </button>
        </div>
      )}
      {addOpen && (
        <form
          className="source-add"
          onSubmit={(e) => {
            e.preventDefault()
            void add()
          }}
        >
          <div className="ns-options">
            <div className="ns-opt">
              <label className="ns-label" htmlFor="src-provider">Agent</label>
              <Select
                id="src-provider"
                ariaLabel="Agent"
                value={provider}
                options={PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABEL[p] }))}
                onChange={(v) => setProvider(v as Provider)}
              />
            </div>
            <div className="ns-opt source-opt-path">
              <label className="ns-label" htmlFor="src-path">Config home</label>
              <div className="source-browse-row">
                <input
                  id="src-path"
                  autoFocus
                  placeholder="/Users/you/.claude-work"
                  value={path}
                  aria-invalid={!!error}
                  aria-describedby={error ? 'source-add-error' : undefined}
                  onChange={(e) => {
                    setPath(e.target.value)
                    setError(null)
                  }}
                />
                <button type="button" className="btn-ghost" onClick={() => void browse()}>
                  Browse…
                </button>
              </div>
            </div>
            <div className="ns-opt">
              <label className="ns-label" htmlFor="src-label">Label · optional</label>
              <input
                id="src-label"
                placeholder="work-account"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
          </div>
          <p className="ns-hint">
            Usually a second account&apos;s home — the directory its <code>CLAUDE_CONFIG_DIR</code>{' '}
            points at. The defaults were found on first run.
          </p>
          {error && (
            <div id="source-add-error" role="alert" className="new-error">{error}</div>
          )}
          <div className="ns-actions">
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setAddOpen(false)
                setError(null)
              }}
            >
              Cancel
            </button>
            <button type="submit" className="btn-primary" disabled={!path.trim()}>
              Add config home
            </button>
          </div>
        </form>
      )}

      {/* GitHub is an account too — it sits with the others, under the same tab */}
      <h3 className="ns-label">GitHub</h3>
      <ul className="source-list">
        <li className="source-row">
          <span className="plogo" aria-hidden="true">
            <OrgIcon size={13} />
          </span>
          <div className="source-body">
            <div className="source-label">
              gh CLI
              {accounts?.githubUser ? (
                <span className="acct-chip">@{accounts.githubUser}</span>
              ) : (
                <span className="acct-chip missing">not signed in</span>
              )}
            </div>
            <div className="source-note">
              {accounts?.githubUser ? (
                'Pull requests are created and tracked as this user.'
              ) : (
                <>Run <code>gh auth login</code> to enable PR creation and status.</>
              )}
            </div>
          </div>
        </li>
      </ul>
    </>
  )
}
