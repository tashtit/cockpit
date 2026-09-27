import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { AccountsSnapshot, PermissionMode, Provider, RepoGroup } from '../../shared/types'
import {
  accountOptions,
  AGENT_BLURB,
  MODES,
  savedAccount,
  savedMode,
  type StartSessionRequest
} from './agent-choice'
import { AccountField, AgentOptionsFields, AgentOptionsHints, useAgentOptions } from './agent-options'
import { api } from './api'
import { AttachRow, useImageAttachments, type ImageAttachment } from './attachments'
import { ProviderLogo, PROVIDER_LABEL } from './logos'
import { Select } from './Select'
import { branchHint } from './task-names'
import { useBranchPrefix } from './branch-prefix'

const PROVIDERS: Provider[] = ['claude', 'codex', 'copilot']

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
  const branchPrefix = useBranchPrefix()
  const [prompt, setPrompt] = useState(initialPrompt ?? '')
  const atts = useImageAttachments(initialImages)
  const [mode, setMode] = useState<PermissionMode>(savedMode)
  const [error, setError] = useState<string | null>(null)
  const [accounts, setAccounts] = useState<AccountsSnapshot | null>(null)
  const [accountKey, setAccountKey] = useState<string | null>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)

  const selectable = useMemo(() => repos.filter((r) => r.root), [repos])
  const selected = selectable.find((r) => r.key === repoKey) ?? repo

  const opts = useMemo(() => accountOptions(accounts, provider), [accounts, provider])
  const account = opts.find((o) => o.key === accountKey) ?? savedAccount(accounts, provider)
  const agent = useAgentOptions(provider, account?.configDir)

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
    // the button is held for a missing model; ⌘Enter in the task field must be too
    if (busy || agent.modelMissing || (!prompt.trim() && atts.attachments.length === 0)) return
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

        {/* the task first, like Home's composer: what you want done is the reason the
            form is open — where it runs and who runs it are its settings */}
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

        <div className="ns-options ns-agent-options">
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
          <span className="ns-branch-prefix" title="Set in Settings › Accounts">{branchPrefix}</span>
          <input
            id="ns-branch"
            // the name the task will actually produce, not a promise that one exists
            placeholder={branchHint(prompt) ?? 'auto-generated'}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="ns-hint">
          Runs in an isolated git worktree on its own branch — ship it as a PR when done.
        </div>

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
