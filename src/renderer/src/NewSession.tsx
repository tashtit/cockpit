import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type {
  AccountsSnapshot,
  AgentOptions,
  CodexSandbox,
  PermissionMode,
  Provider,
  RepoGroup
} from '../../shared/types'
import { api } from './api'
import { ProviderLogo, PROVIDER_LABEL } from './logos'
import { Select } from './Select'

export interface AccountChoice {
  configDir?: string
  copilotUser?: string
  /** Human-readable identity, carried onto the session binding for display */
  display?: string
}

export interface AccountOption extends AccountChoice {
  key: string
  display: string
  /** Short unique part (email / @login) that must never truncate away */
  identity: string
}

/** Flatten the accounts snapshot into selectable options per provider. */
export function accountOptions(snap: AccountsSnapshot | null, provider: Provider): AccountOption[] {
  if (!snap) return []
  const out: AccountOption[] = []
  for (const a of snap.accounts.filter((x) => x.provider === provider)) {
    if (provider === 'copilot' && a.users && a.users.length > 0) {
      for (const login of a.users) {
        out.push({
          key: `${a.path}|${login}`,
          identity: `@${login}`,
          display: `@${login}${a.isDefault ? '' : ` · ${a.label}`}`,
          configDir: a.isDefault ? undefined : a.path,
          copilotUser: login
        })
      }
    } else {
      const identity = a.identity ?? a.label
      out.push({
        key: a.path,
        identity,
        // the label is only appended when it adds information — when the identity is
        // unknown it already falls back to the label, and "label · label" is noise
        display: a.isDefault || identity === a.label ? identity : `${identity} · ${a.label}`,
        configDir: a.isDefault ? undefined : a.path
      })
    }
  }
  return out
}

/** The single account-resolution rule: the user's saved choice, else the first configured. */
export function savedAccount(snap: AccountsSnapshot | null, p: Provider): AccountOption | undefined {
  const opts = accountOptions(snap, p)
  return opts.find((o) => o.key === window.localStorage.getItem(`cockpit:account:${p}`)) ?? opts[0]
}

const PROVIDERS: Provider[] = ['claude', 'codex', 'copilot']

/** The one permission-mode table — HomeView and ChatView import it so wording never drifts. */
export const MODES: Array<{ v: PermissionMode; label: string; hint: string }> = [
  { v: 'safe', label: 'Safe', hint: 'provider defaults; tools may be blocked headless' },
  { v: 'auto-edit', label: 'Auto-edit', hint: 'auto-approve file edits (Copilot: allows all tools)' },
  { v: 'yolo', label: 'YOLO', hint: 'bypass all approvals — trusted repos only' }
]

/** Suggestions only — the field accepts any model the CLI accepts. */
const MODEL_SUGGESTIONS: Record<Provider, string[]> = {
  claude: ['sonnet', 'opus', 'haiku'],
  codex: ['gpt-5-codex', 'o4-mini'],
  copilot: ['claude-sonnet-4.5', 'gpt-5']
}

const AGENT_BLURB: Record<Provider, string> = {
  claude: 'Deep multi-step coding, hooks & skills',
  codex: 'Fast sandboxed execution',
  copilot: 'GitHub-native, PR-focused'
}

export function NewSession({
  repo,
  repos,
  busy,
  onStart,
  onCancel
}: {
  repo: RepoGroup
  repos: RepoGroup[]
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
  onCancel: () => void
}): JSX.Element {
  const [repoKey, setRepoKey] = useState(repo.key)
  const [provider, setProvider] = useState<Provider>(
    () => (window.localStorage.getItem('cockpit:provider') as Provider) ?? 'claude'
  )
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState('')
  const [model, setModel] = useState('')
  const [codexSandbox, setCodexSandbox] = useState<CodexSandbox | ''>('')
  const [mode, setMode] = useState<PermissionMode>(
    () => (window.localStorage.getItem('cockpit:mode') as PermissionMode) ?? 'auto-edit'
  )
  const [error, setError] = useState<string | null>(null)
  const [accounts, setAccounts] = useState<AccountsSnapshot | null>(null)
  const [accountKey, setAccountKey] = useState<string | null>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)

  const selectable = useMemo(() => repos.filter((r) => r.root), [repos])
  const selected = selectable.find((r) => r.key === repoKey) ?? repo

  const opts = useMemo(() => accountOptions(accounts, provider), [accounts, provider])
  const account = opts.find((o) => o.key === accountKey) ?? savedAccount(accounts, provider)

  // keyboard users land in the task field instead of tabbing through the sidebar
  useEffect(() => {
    promptRef.current?.focus()
    void api.getAccounts().then(setAccounts)
  }, [])

  // model suggestions and accounts differ per agent — reset stale choices on switch
  useEffect(() => {
    setModel('')
    setAccountKey(null)
  }, [provider])

  const start = async (): Promise<void> => {
    if (busy || !prompt.trim()) return
    setError(null)
    window.localStorage.setItem('cockpit:provider', provider)
    window.localStorage.setItem('cockpit:mode', mode)
    const options: AgentOptions = {}
    if (model.trim()) options.model = model.trim()
    if (provider === 'codex' && codexSandbox) options.codexSandbox = codexSandbox
    if (account) window.localStorage.setItem(`cockpit:account:${provider}`, account.key)
    const err = await onStart(selected, provider, name.trim(), prompt.trim(), mode, options, {
      configDir: account?.configDir,
      copilotUser: account?.copilotUser,
      display: account?.display
    })
    if (err) setError(err)
  }

  return (
    <main className="chat new-session-view">
      <div className="ns-card">
        <div className="ns-head">
          <h2>New session</h2>
        </div>

        <label className="ns-label" htmlFor="ns-repo">Project</label>
        <Select
          id="ns-repo"
          ariaLabel="Project"
          value={selected.key}
          options={selectable.map((r) => ({ value: r.key, label: r.fullName ?? r.name }))}
          onChange={setRepoKey}
        />

        <label className="ns-label">Agent</label>
        <div className="ns-providers" role="group" aria-label="Agent">
          {PROVIDERS.map((p) => {
            // same resolution rule as start() — the card must never show a different
            // account than the one that would actually run
            const acct = p === provider ? account : savedAccount(accounts, p)
            return (
              <button
                key={p}
                aria-pressed={provider === p}
                className={`ns-provider ns-${p} ${provider === p ? 'active' : ''}`}
                onClick={() => setProvider(p)}
              >
                <ProviderLogo p={p} size={20} />
                <span className="ns-provider-name">{PROVIDER_LABEL[p]}</span>
                <span className="ns-provider-blurb">{AGENT_BLURB[p]}</span>
                {/* while accounts are still loading, absence is unknown — not "signed out" */}
                <span
                  className={`acct-chip${acct || accounts === null ? '' : ' missing'}`}
                  title={acct?.display}
                >
                  {acct?.identity ?? (accounts === null ? '…' : 'not signed in')}
                </span>
              </button>
            )
          })}
        </div>

        <div className="ns-options">
          <div className="ns-opt">
            {opts.length > 1 ? (
              <>
                {/* the Select trigger is a button — labelable, so label-for works */}
                <label className="ns-label" htmlFor="ns-account">Account</label>
                <Select
                  id="ns-account"
                  ariaLabel="Account"
                  mono
                  value={account?.key ?? ''}
                  options={opts.map((o) => ({ value: o.key, label: o.display }))}
                  onChange={setAccountKey}
                />
              </>
            ) : (
              // static text, not a form control — label-for can't associate with a div
              <>
                <span className="ns-label" id="ns-account-label">Account</span>
                <div
                  className="ns-account-single"
                  aria-labelledby="ns-account-label"
                  title={account?.display}
                >
                  {account?.display ?? (accounts === null ? '…' : 'not signed in')}
                </div>
              </>
            )}
          </div>
          <div className="ns-opt">
            <label className="ns-label" htmlFor="ns-model">Model</label>
            <input
              id="ns-model"
              list="ns-models"
              placeholder="default"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            />
            <datalist id="ns-models">
              {MODEL_SUGGESTIONS[provider].map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </div>
          {provider === 'codex' && (
            <div className="ns-opt">
              <label className="ns-label" htmlFor="ns-sandbox">Sandbox</label>
              <Select
                id="ns-sandbox"
                ariaLabel="Sandbox"
                mono
                value={codexSandbox}
                options={[
                  { value: '', label: 'default' },
                  { value: 'read-only', label: 'read-only' },
                  { value: 'workspace-write', label: 'workspace-write' },
                  { value: 'danger-full-access', label: 'danger-full-access' }
                ]}
                onChange={(v) => setCodexSandbox(v as CodexSandbox | '')}
              />
            </div>
          )}
          <div className="ns-opt">
            <label className="ns-label" htmlFor="ns-mode">Permissions</label>
            <Select
              id="ns-mode"
              ariaLabel="Permissions"
              value={mode}
              options={MODES.map((m) => ({ value: m.v, label: m.label, title: m.hint }))}
              onChange={(v) => setMode(v as PermissionMode)}
            />
          </div>
        </div>
        <div className={mode === 'yolo' ? 'ns-hint yolo' : 'ns-hint'}>
          {MODES.find((m) => m.v === mode)?.hint}
        </div>

        <label className="ns-label" htmlFor="ns-branch">Branch</label>
        <div className="ns-branch-row">
          <span className="ns-branch-prefix">cockpit/</span>
          <input
            id="ns-branch"
            placeholder="auto-generated"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="ns-hint">
          Runs in an isolated git worktree on its own branch — ship it as a PR when done.
        </div>

        <label className="ns-label" htmlFor="ns-prompt">Task</label>
        <textarea
          id="ns-prompt"
          ref={promptRef}
          rows={5}
          placeholder="What should the agent do?"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void start()
          }}
        />

        {error && <div className="new-error" role="alert">{error}</div>}

        <div className="ns-actions">
          <button className="btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="btn-primary" onClick={() => void start()} disabled={busy || !prompt.trim()}>
            {busy ? 'Creating worktree…' : 'Start session'}
          </button>
        </div>
      </div>
    </main>
  )
}
