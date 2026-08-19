import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type {
  AccountsSnapshot,
  AgentOptions,
  CodexSandbox,
  ModelEndpoint,
  PermissionMode,
  Provider,
  RepoGroup
} from '../../shared/types'
import { endpointSupports } from '../../shared/endpoints'
import { api } from './api'
import { AttachRow, useImageAttachments, type ImageAttachment } from './attachments'
import { ProviderLogo, PROVIDER_LABEL } from './logos'
import { Select } from './Select'

export type AccountChoice = {
  readonly configDir?: string
  readonly copilotUser?: string
  /** Human-readable identity, carried onto the session binding for display */
  readonly display?: string
}

export type AccountOption = AccountChoice & {
  readonly key: string
  readonly display: string
  /** Short unique part (email / @login) that must never truncate away */
  readonly identity: string
}

/** Everything needed to start a fresh session (worktree + first prompt). */
export type StartSessionRequest = {
  readonly repo: RepoGroup
  readonly provider: Provider
  /** Optional branch/worktree name; '' lets the workspace pick one */
  readonly name: string
  readonly prompt: string
  readonly mode: PermissionMode
  readonly options: AgentOptions
  readonly account: AccountChoice
  /** Pasted-image paths (saveChatImage) sent with the first prompt */
  readonly images?: readonly string[]
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
export const MODEL_SUGGESTIONS: Record<Provider, string[]> = {
  claude: ['sonnet', 'opus', 'haiku'],
  codex: ['gpt-5-codex', 'o4-mini'],
  copilot: ['claude-sonnet-4.5', 'gpt-5']
}

export const AGENT_BLURB: Record<Provider, string> = {
  claude: 'Deep multi-step coding, hooks & skills',
  codex: 'Fast sandboxed execution',
  copilot: 'GitHub-native, PR-focused'
}

/** Per-agent option state (model / BYOK endpoint / codex sandbox) shared by the
 *  New-session and Handoff forms, so the option plumbing can never drift apart. */
export type AgentOptionsState = {
  readonly model: string
  readonly setModel: (m: string) => void
  readonly codexSandbox: CodexSandbox | ''
  readonly setCodexSandbox: (s: CodexSandbox | '') => void
  readonly endpointId: string
  readonly setEndpointId: (id: string) => void
  readonly endpoints: ModelEndpoint[]
  readonly usableEndpoints: ModelEndpoint[]
  readonly endpoint: ModelEndpoint | undefined
  /** Models to pick from: live listing when it arrived, else the cached list. */
  readonly modelChoices: string[]
  /** Copilot never learns a custom provider's catalog on its own — it needs an explicit model. */
  readonly modelMissing: boolean
  /** The composed per-agent options for ChatRequest */
  readonly options: AgentOptions
}

export function useAgentOptions(provider: Provider): AgentOptionsState {
  const [model, setModel] = useState('')
  const [codexSandbox, setCodexSandbox] = useState<CodexSandbox | ''>('')
  const [endpoints, setEndpoints] = useState<ModelEndpoint[]>([])
  const [endpointId, setEndpointId] = useState('')
  /** Live model listings per provider id — cached `endpoint.models` until the fetch lands */
  const [endpointModels, setEndpointModels] = useState<Record<string, string[]>>({})

  useEffect(() => {
    // optional call: a preload from before this method must not crash the form (dev HMR)
    void api.getModelEndpoints?.().then(setEndpoints)
  }, [])

  // model suggestions and endpoints differ per agent — reset stale choices on switch
  useEffect(() => {
    setModel('')
    setEndpointId('')
  }, [provider])

  const usableEndpoints = endpoints.filter((e) => endpointSupports(provider, e))
  const endpoint = usableEndpoints.find((e) => e.id === endpointId)
  const modelMissing = provider === 'copilot' && !!endpoint && !model.trim()
  const modelChoices = endpoint ? (endpointModels[endpoint.id] ?? endpoint.models ?? []) : []

  // ask the provider itself which models it serves; the cached list covers the meantime
  useEffect(() => {
    if (!endpoint || endpointModels[endpoint.id]) return
    const id = endpoint.id
    void api
      .listEndpointModels?.(id)
      .then((m) => m.length > 0 && setEndpointModels((prev) => ({ ...prev, [id]: m })))
      .catch(() => {}) // unreachable provider → free-text model entry still works
  }, [endpoint?.id])

  // a model typed as free text must not silently survive once a catalog arrives
  // that doesn't serve it — the picker would show "choose…" while the stale value runs.
  // Keyed on the catalog's contents: a live listing with the same count but different
  // names must also clear the choice.
  const modelChoicesKey = modelChoices.join('\n')
  useEffect(() => {
    if (endpoint && modelChoices.length > 0 && model && !modelChoices.includes(model)) {
      setModel('')
    }
  }, [endpoint?.id, modelChoicesKey])

  return {
    model,
    setModel,
    codexSandbox,
    setCodexSandbox,
    endpointId,
    setEndpointId,
    endpoints,
    usableEndpoints,
    endpoint,
    modelChoices,
    modelMissing,
    options: {
      model: model.trim() || undefined,
      codexSandbox: provider === 'codex' && codexSandbox ? codexSandbox : undefined,
      modelEndpoint: endpoint?.id
    }
  }
}

/** The account `.ns-opt` cell: a mono Select when several accounts exist, static text otherwise. */
export function AccountField({
  opts,
  account,
  loading,
  onChange
}: {
  opts: AccountOption[]
  account: AccountOption | undefined
  /** while accounts are still loading, absence is unknown — not "signed out" */
  loading: boolean
  onChange: (key: string) => void
}): JSX.Element {
  return (
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
            onChange={onChange}
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
            {account?.display ?? (loading ? '…' : 'not signed in')}
          </div>
        </>
      )}
    </div>
  )
}

/** The agent-option `.ns-opt` cells (model provider / model / codex sandbox). */
export function AgentOptionsFields({
  provider,
  o
}: {
  provider: Provider
  o: AgentOptionsState
}): JSX.Element {
  return (
    <>
      {o.usableEndpoints.length > 0 && (
        <div className="ns-opt">
          <label className="ns-label" htmlFor="ns-endpoint">Model provider</label>
          <Select
            id="ns-endpoint"
            ariaLabel="Model provider"
            value={o.endpointId}
            options={[
              { value: '', label: 'default' },
              ...o.usableEndpoints.map((e) => ({ value: e.id, label: e.label, title: e.baseUrl }))
            ]}
            onChange={o.setEndpointId}
          />
        </div>
      )}
      <div className="ns-opt">
        <label className="ns-label" htmlFor="ns-model">Model</label>
        {o.endpoint && o.modelChoices.length > 0 ? (
          // the provider told us what it serves — pick from its own catalog
          <Select
            id="ns-model"
            ariaLabel="Model"
            mono
            value={o.modelChoices.includes(o.model) ? o.model : ''}
            options={[
              {
                value: '',
                label: provider === 'copilot' ? 'choose a model…' : 'default'
              },
              ...o.modelChoices.map((m) => ({ value: m, label: m }))
            ]}
            onChange={o.setModel}
          />
        ) : (
          <>
            <input
              id="ns-model"
              list="ns-models"
              placeholder={o.modelMissing ? 'required' : 'default'}
              value={o.model}
              onChange={(e) => o.setModel(e.target.value)}
            />
            <datalist id="ns-models">
              {MODEL_SUGGESTIONS[provider].map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </>
        )}
      </div>
      {provider === 'codex' && (
        <div className="ns-opt">
          <label className="ns-label" htmlFor="ns-sandbox">Sandbox</label>
          <Select
            id="ns-sandbox"
            ariaLabel="Sandbox"
            mono
            value={o.codexSandbox}
            options={[
              { value: '', label: 'default' },
              { value: 'read-only', label: 'read-only' },
              { value: 'workspace-write', label: 'workspace-write' },
              { value: 'danger-full-access', label: 'danger-full-access' }
            ]}
            onChange={(v) => o.setCodexSandbox(v as CodexSandbox | '')}
          />
        </div>
      )}
    </>
  )
}

/** Endpoint hints shown under the option grid — why a provider is (un)available. */
export function AgentOptionsHints({
  provider,
  o
}: {
  provider: Provider
  o: AgentOptionsState
}): JSX.Element | null {
  return (
    <>
      {o.endpoint && (
        <div className="ns-hint">
          Runs on {o.endpoint.baseUrl}
          {o.modelChoices.length === 0 &&
            (provider === 'copilot'
              ? ' — a model this provider serves is required.'
              : ' — set a model this provider serves.')}
        </div>
      )}
      {o.endpoints.length > 0 && o.usableEndpoints.length === 0 && (
        <div className="ns-hint">
          {provider === 'codex'
            ? 'Custom model providers can’t run Codex — it has no launch-time provider override.'
            : 'Claude can only use anthropic-type custom providers — none is configured.'}
        </div>
      )}
    </>
  )
}

export function NewSession({
  repo,
  repos,
  busy,
  initialPrompt,
  initialImages,
  onStart,
  onCancel
}: {
  repo: RepoGroup
  repos: RepoGroup[]
  busy: boolean
  /** Draft carried over from Home's quick composer — typing is never lost on "Options…" */
  initialPrompt?: string
  /** Images pasted into Home's quick composer, carried over the same way */
  initialImages?: readonly ImageAttachment[]
  onStart: (req: StartSessionRequest) => Promise<string | null>
  onCancel: () => void
}): JSX.Element {
  const [repoKey, setRepoKey] = useState(repo.key)
  const [provider, setProvider] = useState<Provider>(
    () => (window.localStorage.getItem('cockpit:provider') as Provider) ?? 'claude'
  )
  const [name, setName] = useState('')
  const [prompt, setPrompt] = useState(initialPrompt ?? '')
  const atts = useImageAttachments(initialImages)
  const agent = useAgentOptions(provider)
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

  // accounts differ per agent — reset a stale choice on switch (model/endpoint reset in the hook)
  useEffect(() => {
    setAccountKey(null)
  }, [provider])

  const start = async (): Promise<void> => {
    if (busy || (!prompt.trim() && atts.attachments.length === 0)) return
    setError(null)
    window.localStorage.setItem('cockpit:provider', provider)
    window.localStorage.setItem('cockpit:mode', mode)
    if (account) window.localStorage.setItem(`cockpit:account:${provider}`, account.key)
    const err = await onStart({
      repo: selected,
      provider,
      name: name.trim(),
      prompt: prompt.trim(),
      mode,
      options: agent.options,
      account: {
        configDir: account?.configDir,
        copilotUser: account?.copilotUser,
        display: account?.display
      },
      images: atts.paths()
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
          <AccountField
            opts={opts}
            account={account}
            loading={accounts === null}
            onChange={setAccountKey}
          />
          <AgentOptionsFields provider={provider} o={agent} />
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
        <AgentOptionsHints provider={provider} o={agent} />

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
        <AttachRow atts={atts} />
        <textarea
          id="ns-prompt"
          ref={promptRef}
          rows={5}
          placeholder="What should the agent do?"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onPaste={atts.onPaste}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void start()
          }}
        />

        {error && <div className="new-error" role="alert">{error}</div>}

        <div className="ns-actions">
          <button className="btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            className="btn-primary"
            onClick={() => void start()}
            disabled={busy || (!prompt.trim() && atts.attachments.length === 0) || agent.modelMissing}
          >
            {busy ? 'Creating worktree…' : 'Start session'}
          </button>
        </div>
      </div>
    </main>
  )
}
