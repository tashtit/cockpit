import { useEffect, useRef, useState } from 'react'
import type { AccountsSnapshot, Provider, SourceDir, SourceStats } from '../../shared/types'
import { api } from './api'
import { OrgIcon, ProviderLogo, PROVIDER_LABEL } from './logos'

const PROVIDERS: Provider[] = ['claude', 'codex', 'copilot']

function fmtAgo(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const h = Math.round(mins / 60)
  if (h < 24) return `${h}h ago`
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' })
}

export function Settings({ onClose }: { onClose: () => void }): JSX.Element {
  const [stats, setStats] = useState<SourceStats[]>([])
  const [accounts, setAccounts] = useState<AccountsSnapshot | null>(null)
  const [path, setPath] = useState('')
  const [provider, setProvider] = useState<Provider>('claude')
  const [label, setLabel] = useState('')
  const [error, setError] = useState<string | null>(null)
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
  }
  useEffect(() => {
    refresh()
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
            <li key={s.path} className={`source-row source-${s.provider}`}>
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
              <select
                id="src-provider"
                className="ns-select"
                value={provider}
                onChange={(e) => setProvider(e.target.value as Provider)}
              >
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>
                ))}
              </select>
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
