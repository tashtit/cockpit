import { useEffect, useRef, useState } from 'react'
import type { AccountsSnapshot, Provider, SourceDir } from '../../shared/types'
import { api } from './api'
import { ProviderLogo, PROVIDER_LABEL } from './logos'

const PROVIDERS: Provider[] = ['claude', 'codex', 'copilot']

export function Settings({ onClose }: { onClose: () => void }): JSX.Element {
  const [sources, setSources] = useState<SourceDir[]>([])
  const [accounts, setAccounts] = useState<AccountsSnapshot | null>(null)
  const [path, setPath] = useState('')
  const [provider, setProvider] = useState<Provider>('claude')
  const [label, setLabel] = useState('')
  const [error, setError] = useState<string | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    void api.getSources().then(setSources)
    void api.getAccounts().then(setAccounts)
    headingRef.current?.focus()
  }, [])

  const identityOf = (path: string): string | null =>
    accounts?.accounts.find((a) => a.path === path)?.identity ?? null

  const add = async (): Promise<void> => {
    const p = path.trim()
    if (!p) return
    setError(null)
    try {
      setSources(await api.addSource(p, provider, label.trim() || `${provider}-extra`))
      setPath('')
      setLabel('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <main className="chat settings-view">
      <div className="ns-card">
        <div className="ns-head">
          <h2 ref={headingRef} tabIndex={-1}>Settings</h2>
          <button className="btn-ghost" onClick={onClose}>Close</button>
        </div>

        <label className="ns-label">Agent accounts &amp; sources</label>
        <p className="ns-hint">
          Directories Cockpit indexes and watches. Defaults are auto-detected; add extra config
          homes here (e.g. a second account&apos;s <code>CLAUDE_CONFIG_DIR</code>).
        </p>
        <ul className="source-list">
          {sources.map((s) => (
            <li key={s.path} className="source-row">
              <span className={`plogo plogo-${s.provider}`}>
                <ProviderLogo p={s.provider} size={13} />
              </span>
              <div className="source-body">
                <div className="source-label">{s.label}</div>
                {identityOf(s.path) && <div className="source-identity">{identityOf(s.path)}</div>}
                <div className="source-path" title={s.path}>{s.path}</div>
              </div>
              <button
                className="btn-ghost danger"
                onClick={() => void api.removeSource(s.path).then(setSources)}
              >
                Remove
              </button>
            </li>
          ))}
          {sources.length === 0 && <li className="tree-empty">no sources configured</li>}
        </ul>

        <label className="ns-label">Add source</label>
        <div className="source-add">
          <select
            className="mode-select"
            value={provider}
            aria-label="Provider"
            onChange={(e) => setProvider(e.target.value as Provider)}
          >
            {PROVIDERS.map((p) => (
              <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>
            ))}
          </select>
          <input
            aria-label="Source directory path"
            placeholder="/path/to/config-home"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
          <input
            className="source-add-label"
            aria-label="Source label"
            placeholder="label (optional)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <button className="btn-primary" disabled={!path.trim()} onClick={() => void add()}>
            Add
          </button>
        </div>
        {error && <div className="new-error">{error}</div>}
      </div>
    </main>
  )
}
