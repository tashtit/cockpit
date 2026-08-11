import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AccountsSnapshot,
  AgentOptions,
  PermissionMode,
  Provider,
  RepoGroup,
  SessionMeta
} from '../../shared/types'
import { api } from './api'
import { accountOptions, MODES, savedAccount, type AccountChoice } from './NewSession'
import { BranchIcon, CockpitLogo, ProviderLogo, PROVIDER_LABEL, RepoIcon } from './logos'
import { Select } from './Select'
import { fmtTime, useTimeFormat } from './time'

const PROVIDERS: Provider[] = ['claude', 'codex', 'copilot']

/**
 * Mission-control home, patterned after GitHub's Agent HQ: a task composer front
 * and center (repo + agent + permissions inline), recent agent work below it.
 */
export function HomeView({
  repos,
  indexVersion,
  busy,
  onStart,
  onOpenSession
}: {
  repos: RepoGroup[]
  indexVersion: number
  busy: boolean
  onStart: (
    repo: RepoGroup,
    provider: Provider,
    name: string,
    prompt: string,
    mode: PermissionMode,
    options: AgentOptions,
    account: AccountChoice
  ) => Promise<string | null>
  onOpenSession: (s: SessionMeta) => void
}): JSX.Element {
  const selectable = useMemo(() => repos.filter((r) => r.root), [repos])
  const [repoKey, setRepoKey] = useState<string | null>(null)
  const [provider, setProvider] = useState<Provider>(
    () => (window.localStorage.getItem('cockpit:provider') as Provider) ?? 'claude'
  )
  const [mode, setMode] = useState<PermissionMode>(
    () => (window.localStorage.getItem('cockpit:mode') as PermissionMode) ?? 'auto-edit'
  )
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [recent, setRecent] = useState<SessionMeta[]>([])
  const [accounts, setAccounts] = useState<AccountsSnapshot | null>(null)
  const [accountKey, setAccountKey] = useState<string | null>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const timeFormat = useTimeFormat()

  const opts = useMemo(() => accountOptions(accounts, provider), [accounts, provider])
  const account = opts.find((o) => o.key === accountKey) ?? savedAccount(accounts, provider) ?? null

  useEffect(() => {
    setAccountKey(null)
  }, [provider])

  const selected =
    selectable.find((r) => r.key === repoKey) ?? (selectable.length > 0 ? selectable[0] : null)

  useEffect(() => {
    promptRef.current?.focus()
    void api.getAccounts().then(setAccounts)
  }, [])

  useEffect(() => {
    let dead = false
    void api.pageSessions({ limit: 10 }).then((p) => !dead && setRecent(p.items))
    return () => {
      dead = true
    }
  }, [indexVersion])

  const start = async (): Promise<void> => {
    if (busy || !prompt.trim() || !selected) return
    setError(null)
    window.localStorage.setItem('cockpit:provider', provider)
    window.localStorage.setItem('cockpit:mode', mode)
    if (account) window.localStorage.setItem(`cockpit:account:${provider}`, account.key)
    const err = await onStart(selected, provider, '', prompt.trim(), mode, {}, {
      configDir: account?.configDir,
      copilotUser: account?.copilotUser,
      display: account?.display
    })
    if (err) setError(err)
  }

  return (
    <main className="chat home-view">
      <div className="home-inner">
        <div className="home-hero">
          <CockpitLogo size={48} />
          <h2>What should we ship?</h2>
          <p className="home-sub">
            Assign a task to an agent — it runs in an isolated worktree and lands as a PR.
            <span className="home-kbd">⌘N new task · ⌘K search</span>
          </p>
        </div>

        <div className="composer-card">
          <textarea
            ref={promptRef}
            aria-label="Task description"
            placeholder="Describe a task…  (⌘Enter to start)"
            rows={3}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void start()
            }}
          />
          <div className="composer-bar">
            <span className="composer-repo-icon"><RepoIcon size={13} /></span>
            <Select
              className="composer-repo"
              ariaLabel="Repository"
              value={selected?.key ?? ''}
              options={
                selectable.length > 0
                  ? selectable.map((r) => ({ value: r.key, label: r.fullName ?? r.name }))
                  : [{ value: '', label: 'no repositories indexed yet' }]
              }
              onChange={setRepoKey}
            />
            <div className="composer-identity">
              <div className="composer-agents" role="group" aria-label="Agent">
                {PROVIDERS.map((p) => {
                  const pAcct = savedAccount(accounts, p)
                  return (
                    <button
                      key={p}
                      aria-pressed={provider === p}
                      aria-label={PROVIDER_LABEL[p]}
                      title={`${PROVIDER_LABEL[p]} — ${pAcct?.display ?? 'not signed in'}`}
                      className={`composer-agent plogo-${p} ${provider === p ? 'active' : ''} ${
                        accounts !== null && !pAcct ? 'no-acct' : ''
                      }`}
                      onClick={() => setProvider(p)}
                    >
                      <ProviderLogo p={p} size={15} />
                    </button>
                  )
                })}
              </div>
              {opts.length > 0 ? (
                <Select
                  className="composer-acct-wrap"
                  mono
                  quiet
                  ariaLabel={`${PROVIDER_LABEL[provider]} account`}
                  title={`${PROVIDER_LABEL[provider]} account in use`}
                  value={account?.key ?? ''}
                  options={opts.map((o) => ({ value: o.key, label: o.display }))}
                  onChange={(v) => {
                    window.localStorage.setItem(`cockpit:account:${provider}`, v)
                    setAccountKey(v)
                  }}
                />
              ) : (
                <span className="acct-chip missing">not signed in</span>
              )}
            </div>
            <Select
              ariaLabel="Permission mode"
              value={mode}
              options={MODES.map((m) => ({ value: m.v, label: m.label, title: m.hint }))}
              onChange={(v) => setMode(v as PermissionMode)}
            />
            <button
              className="btn-primary"
              title={account ? `runs as ${account.display}` : undefined}
              disabled={busy || !prompt.trim() || !selected || (accounts !== null && !account)}
              onClick={() => void start()}
            >
              {busy ? 'Starting…' : `Start with ${PROVIDER_LABEL[provider]}`}
            </button>
          </div>
        </div>
        {mode === 'yolo' && (
          <div className="ns-hint yolo">{MODES.find((m) => m.v === 'yolo')?.hint}</div>
        )}
        {error && <div className="new-error" role="alert">{error}</div>}

        {recent.length > 0 && (
          <section className="home-recent">
            <h3 className="ns-label">Recent activity</h3>
            <ul className="recent-list">
              {recent.map((s) => (
                <li key={s.id}>
                  <button className="recent-row" onClick={() => onOpenSession(s)}>
                    <span className={`plogo plogo-${s.provider}`} title={PROVIDER_LABEL[s.provider]}>
                      <ProviderLogo p={s.provider} size={14} />
                    </span>
                    <span className="recent-title">{s.title}</span>
                    <span className="recent-meta">
                      {s.repo && <span className="recent-repo">{s.repo.name}</span>}
                      {s.gitBranch && (
                        <span className="branch-chip">
                          <BranchIcon size={10} />
                          <span className="chip-text">{s.gitBranch}</span>
                        </span>
                      )}
                      <time dateTime={new Date(s.updatedAt).toISOString()}>
                        {fmtTime(s.updatedAt, timeFormat)}
                      </time>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </main>
  )
}
