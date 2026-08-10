import { useEffect, useRef, useState } from 'react'
import type {
  AccountsSnapshot,
  Provider,
  SourceDir,
  SourceStats,
  UsageSnapshot,
  UsageTokens,
  UsageWindow
} from '../../shared/types'
import { api } from './api'
import { OrgIcon, ProviderLogo, PROVIDER_LABEL } from './logos'
import { Select } from './Select'

const PROVIDERS: Provider[] = ['claude', 'codex', 'copilot']

/** History window presets; value is days as a string, '0' = all history. */
const HISTORY_OPTIONS = [
  { value: '0', label: 'All history' },
  { value: '3', label: 'Last 3 days' },
  { value: '7', label: 'Last 7 days' },
  { value: '14', label: 'Last 14 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '365', label: 'Last year' }
]

function fmtAgo(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const h = Math.round(mins / 60)
  if (h < 24) return `${h}h ago`
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function fmtCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

/** "resets in 2h 15m" / "resets in 3d 4h" */
function fmtResetIn(at: number): string {
  const mins = Math.max(0, Math.round((at - Date.now()) / 60000))
  if (mins < 60) return `resets in ${mins}m`
  const h = Math.floor(mins / 60)
  if (h < 24) return `resets in ${h}h ${mins % 60}m`
  return `resets in ${Math.floor(h / 24)}d ${h % 24}h`
}

function tokensTitle(t: UsageTokens): string {
  return `input ${fmtCount(t.input)} · output ${fmtCount(t.output)} · cache write ${fmtCount(
    t.cacheCreate
  )} · cache read ${fmtCount(t.cacheRead)}`
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
      {w.resetsAt && <time>{fmtResetIn(w.resetsAt)}</time>}
    </div>
  )
}

export function Settings({ onClose }: { onClose: () => void }): JSX.Element {
  const [stats, setStats] = useState<SourceStats[]>([])
  const [accounts, setAccounts] = useState<AccountsSnapshot | null>(null)
  const [usage, setUsage] = useState<UsageSnapshot | null>(null)
  const [path, setPath] = useState('')
  const [provider, setProvider] = useState<Provider>('claude')
  const [label, setLabel] = useState('')
  const [error, setError] = useState<string | null>(null)
  /** null until loaded — the Select only renders with a real value */
  const [historyDays, setHistoryDays] = useState<number | null>(null)
  /** Path of the source whose Remove is in its confirm step */
  const [confirming, setConfirming] = useState<string | null>(null)
  const [lastRemoved, setLastRemoved] = useState<SourceDir | null>(null)
  /** sr-only announcements (same pattern as ChatView's status region) */
  const [status, setStatus] = useState('')
  const headingRef = useRef<HTMLHeadingElement>(null)
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const refresh = (): void => {
    void api.getSourceStats().then(setStats)
    void api.getAccounts().then(setAccounts)
    api.getUsage().then(setUsage, () => {})
  }
  useEffect(() => {
    refresh()
    void api.getHistoryDays().then(setHistoryDays)
    headingRef.current?.focus()
    // counts stay live while the indexer works
    return api.onIndexUpdated(refresh)
  }, [])
  useEffect(() => () => {
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
  }, [])

  const identityOf = (p: string): string | null =>
    accounts?.accounts.find((a) => a.path === p)?.identity ?? null
  const isDefault = (p: string): boolean =>
    accounts?.accounts.find((a) => a.path === p)?.isDefault ?? false

  const add = async (): Promise<void> => {
    const p = path.trim()
    if (!p) return
    setError(null)
    try {
      await api.addSource(p, provider, label.trim() || `${provider}-extra`)
      setPath('')
      setLabel('')
      setStatus(`Added ${label.trim() || p} — indexing started`)
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const browse = async (): Promise<void> => {
    const p = await api.pickDirectory()
    if (p) {
      setPath(p)
      setError(null)
    }
  }

  const armRemove = (p: string): void => {
    setConfirming(p)
    if (confirmTimer.current) clearTimeout(confirmTimer.current)
    confirmTimer.current = setTimeout(() => setConfirming(null), 4000)
  }

  const remove = async (s: SourceStats): Promise<void> => {
    setConfirming(null)
    setLastRemoved({ path: s.path, provider: s.provider, label: s.label })
    await api.removeSource(s.path)
    setStatus(`Removed ${s.label}`)
    refresh()
  }

  const undoRemove = async (): Promise<void> => {
    if (!lastRemoved) return
    try {
      await api.addSource(lastRemoved.path, lastRemoved.provider, lastRemoved.label)
      setStatus(`Restored ${lastRemoved.label}`)
      setLastRemoved(null)
      refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  const changeHistory = async (days: number): Promise<void> => {
    setHistoryDays(days)
    await api.setHistoryDays(days)
    setStatus(days === 0 ? 'Showing all history' : `Showing the last ${days} days of history`)
  }

  // a hand-edited config value outside the presets still renders as itself
  const historyOptions =
    historyDays !== null && !HISTORY_OPTIONS.some((o) => o.value === String(historyDays))
      ? [...HISTORY_OPTIONS, { value: String(historyDays), label: `Last ${historyDays} days` }]
      : HISTORY_OPTIONS

  const totalSessions = stats.reduce((n, s) => n + s.count, 0)

  return (
    <main className="chat settings-view">
      <div className="ns-card">
        <div className="ns-head">
          <h2 ref={headingRef} tabIndex={-1}>Settings</h2>
          <button className="btn-ghost" onClick={onClose}>Close</button>
        </div>

        <h3 className="ns-label">Agent accounts &amp; sources</h3>
        <p className="ns-hint">
          Directories Cockpit indexes and watches
          {stats.length > 0 && (
            <> — currently {stats.length} config home{stats.length === 1 ? '' : 's'} · {totalSessions} sessions</>
          )}
          . Defaults are auto-detected on first run; add extra config homes here (e.g. a second
          account&apos;s <code>CLAUDE_CONFIG_DIR</code>).
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
                </div>
                <div className="source-path" title={s.path}>{s.path}</div>
              </div>
              <div className="source-health">
                {s.missing ? (
                  <span className="source-warn">path missing</span>
                ) : s.count === 0 ? (
                  <span className="source-warn">no sessions yet</span>
                ) : (
                  <>
                    <span className="repo-count">{s.count}</span>
                    {s.lastUpdatedAt && <time>active {fmtAgo(s.lastUpdatedAt)}</time>}
                  </>
                )}
              </div>
              {confirming === s.path ? (
                <button
                  className="btn-danger"
                  aria-label={`Confirm removing ${s.label} — it won't be re-detected automatically`}
                  title="Stops indexing this directory. Defaults are only auto-detected on first run — you'd re-add it by hand. Files on disk are untouched."
                  onBlur={() => setConfirming(null)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.stopPropagation()
                      setConfirming(null)
                    }
                  }}
                  onClick={() => void remove(s)}
                >
                  Remove?
                </button>
              ) : (
                <button
                  className="btn-ghost danger small"
                  aria-label={`Remove source ${s.label} — ${s.path}`}
                  onClick={() => armRemove(s.path)}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
          {stats.length === 0 && <li className="tree-empty">no sources configured</li>}
        </ul>
        {lastRemoved && (
          <p className="ns-hint">
            Removed <code>{lastRemoved.label}</code> ({lastRemoved.path}) —{' '}
            <button className="link-btn" onClick={() => void undoRemove()}>Undo</button>
          </p>
        )}

        <h3 className="ns-label">History</h3>
        <p className="ns-hint">
          How far back sessions appear in the sidebar, search, and counts. Older sessions are
          only hidden from view — nothing on disk is touched, and switching back to all history
          restores them.
        </p>
        <div className="ns-options">
          <div className="ns-opt">
            <label className="ns-label" htmlFor="history-days">Show sessions from</label>
            {historyDays === null ? (
              <span className="ns-hint">loading…</span>
            ) : (
              <Select
                id="history-days"
                ariaLabel="Show sessions from"
                value={String(historyDays)}
                options={historyOptions}
                onChange={(v) => void changeHistory(Number(v))}
              />
            )}
          </div>
        </div>

        <h3 className="ns-label">Subscription usage</h3>
        <p className="ns-hint">
          Current usage per subscription — Claude measured locally from session logs, Codex from
          its own rate-limit snapshots, Copilot premium requests from the GitHub billing API.
          Nothing here reads credentials.
        </p>
        <ul className="source-list">
          {usage === null && <li className="tree-empty">measuring…</li>}
          {usage?.providers.map((u) => (
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
                  {!u.unavailable &&
                    u.measuredAt !== undefined &&
                    Date.now() - u.measuredAt > 15 * 60_000 && (
                      <span className="source-origin">as of {fmtAgo(u.measuredAt)}</span>
                    )}
                </div>
                {u.unavailable ? (
                  <div className="source-note">{u.unavailable}</div>
                ) : (
                  <div className="usage-windows">
                    {u.windows.map((w) => (
                      <UsageWindowRow key={w.label} provider={u.provider} w={w} />
                    ))}
                  </div>
                )}
              </div>
            </li>
          ))}
          {usage !== null && usage.providers.length === 0 && (
            <li className="tree-empty">no provider accounts configured</li>
          )}
        </ul>

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

        <h3 className="ns-label">Add source</h3>
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
          {error && (
            <div id="source-add-error" role="alert" className="new-error">{error}</div>
          )}
          <div className="ns-actions">
            <button type="submit" className="btn-primary" disabled={!path.trim()}>
              Add source
            </button>
          </div>
        </form>
        <div className="sr-only" role="status" aria-live="polite">{status}</div>
      </div>
    </main>
  )
}
