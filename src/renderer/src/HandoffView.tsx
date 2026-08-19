import { useEffect, useMemo, useState, type JSX } from 'react'
import type { AccountsSnapshot, AgentOptions, PermissionMode, Provider } from '../../shared/types'
import { api } from './api'
import {
  AccountField,
  AGENT_BLURB,
  AgentOptionsFields,
  AgentOptionsHints,
  accountOptions,
  MODES,
  savedAccount,
  useAgentOptions
} from './NewSession'
import type { AccountChoice } from './NewSession'
import { BranchChip, ProviderLogo, PROVIDER_LABEL } from './logos'
import { Select } from './Select'

const PROVIDERS: Provider[] = ['claude', 'codex', 'copilot']

/** The session being handed off, snapshotted from the open chat binding. */
export type HandoffSourceRef = {
  /** `${provider}:${nativeId}` */
  readonly id: string
  readonly provider: Provider
  readonly title: string
  readonly cwd: string
  readonly branch: string | null
  readonly repoRoot: string | null
}

/** Everything needed to continue the source session on another agent. */
export type StartHandoffRequest = {
  readonly source: HandoffSourceRef
  readonly provider: Provider
  /** The final first prompt: edited briefing (+ optional next-step section) */
  readonly briefing: string
  readonly mode: PermissionMode
  readonly options: AgentOptions
  readonly account: AccountChoice
}

/**
 * Handoff form: pick the target agent, review/edit the context briefing, start a
 * NEW session in the source's worktree. The deliberate difference from NewSession:
 * no repo/branch/task fields — the workspace already exists and the briefing is
 * the first prompt.
 */
export function HandoffView({
  source,
  busy,
  onStart,
  onCancel
}: {
  source: HandoffSourceRef
  busy: boolean
  onStart: (req: StartHandoffRequest) => Promise<string | null>
  onCancel: () => void
}): JSX.Element {
  // default to a different agent — continuing on the same one is allowed, but the
  // point of a handoff is usually the switch
  const [provider, setProvider] = useState<Provider>(
    () => PROVIDERS.find((p) => p !== source.provider) ?? 'claude'
  )
  const agent = useAgentOptions(provider)
  const [mode, setMode] = useState<PermissionMode>(
    () => (window.localStorage.getItem('cockpit:mode') as PermissionMode) ?? 'auto-edit'
  )
  const [accounts, setAccounts] = useState<AccountsSnapshot | null>(null)
  const [accountKey, setAccountKey] = useState<string | null>(null)
  const [briefing, setBriefing] = useState('')
  const [cwdExists, setCwdExists] = useState(true)
  const [warnings, setWarnings] = useState<string[]>([])
  const [briefLoading, setBriefLoading] = useState(true)
  const [briefError, setBriefError] = useState<string | null>(null)
  const [next, setNext] = useState('')
  const [improving, setImproving] = useState(false)
  /** The pre-AI text, so an unwanted rewrite is one click away from undone */
  const [preAi, setPreAi] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const opts = useMemo(() => accountOptions(accounts, provider), [accounts, provider])
  const account = opts.find((o) => o.key === accountKey) ?? savedAccount(accounts, provider)

  useEffect(() => {
    void api.getAccounts().then(setAccounts)
  }, [])

  useEffect(() => {
    setAccountKey(null)
  }, [provider])

  const loadBriefing = (): void => {
    setBriefLoading(true)
    setBriefError(null)
    api
      .getHandoffBriefing(source.id)
      .then((b) => {
        setBriefing(b.briefing)
        setCwdExists(b.cwdExists)
        setWarnings(b.warnings ?? [])
      })
      .catch((err) => {
        // the form stays usable: the user can retry, or write a briefing by hand
        setBriefError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => setBriefLoading(false))
  }
  useEffect(loadBriefing, [source.id])

  const improve = (): void => {
    if (improving || briefLoading) return
    setImproving(true)
    setError(null)
    api
      .improveHandoffBriefing(source.id)
      .then((text) => {
        setPreAi(briefing)
        setBriefing(text)
      })
      .catch((err) => {
        setError(
          `Improve failed: ${err instanceof Error ? err.message : String(err)}`
        )
      })
      .finally(() => setImproving(false))
  }

  const start = async (): Promise<void> => {
    if (busy || improving || !cwdExists || !briefing.trim() || agent.modelMissing) return
    setError(null)
    window.localStorage.setItem('cockpit:provider', provider)
    window.localStorage.setItem('cockpit:mode', mode)
    if (account) window.localStorage.setItem(`cockpit:account:${provider}`, account.key)
    const finalBriefing = next.trim()
      ? `${briefing.trimEnd()}\n\n## What to do next\n\n${next.trim()}`
      : briefing
    const err = await onStart({
      source,
      provider,
      briefing: finalBriefing,
      mode,
      options: agent.options,
      account: {
        configDir: account?.configDir,
        copilotUser: account?.copilotUser,
        display: account?.display
      }
    })
    if (err) setError(err)
  }

  return (
    <main className="chat new-session-view">
      <div className="ns-card">
        <div className="ns-head">
          <h2>Continue in another agent</h2>
        </div>

        <span className="ns-label" id="handoff-source-label">From</span>
        <div className="handoff-source" aria-labelledby="handoff-source-label">
          <span className={`acct-chip acct-${source.provider}`}>
            <ProviderLogo p={source.provider} size={10} /> {PROVIDER_LABEL[source.provider]}
          </span>
          <span className="handoff-source-title" title={source.title}>{source.title}</span>
          {source.branch && <BranchChip branch={source.branch} />}
        </div>
        <div className="ns-hint">
          Same worktree, same branch — the new session starts in{' '}
          <span className="handoff-cwd">{source.cwd}</span>. No new workspace is created.
        </div>

        <label className="ns-label">Continue with</label>
        <div className="ns-providers" role="group" aria-label="Continue with">
          {PROVIDERS.map((p) => {
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

        <div className="handoff-brief-head">
          <label className="ns-label" htmlFor="handoff-brief">Briefing</label>
          {preAi !== null && (
            <button
              className="link-btn"
              onClick={() => {
                setBriefing(preAi)
                setPreAi(null)
              }}
            >
              Revert to extracted
            </button>
          )}
          <button
            className="btn-ghost small"
            disabled={improving || briefLoading}
            onClick={improve}
            title={`Ask the ${PROVIDER_LABEL[source.provider]} session to write its own handoff briefing`}
          >
            {improving ? `Asking ${PROVIDER_LABEL[source.provider]}…` : 'Improve with AI'}
          </button>
        </div>
        <textarea
          id="handoff-brief"
          className="handoff-brief"
          rows={12}
          disabled={briefLoading || improving}
          placeholder={briefLoading ? 'Building briefing…' : 'Context for the next agent'}
          value={briefing}
          onChange={(e) => setBriefing(e.target.value)}
        />
        {briefError && (
          <div className="new-error" role="alert">
            Briefing failed: {briefError}{' '}
            <button className="link-btn" onClick={loadBriefing}>Retry</button>
          </div>
        )}
        {warnings.map((w) => (
          <div key={w} className="ns-hint">{w}</div>
        ))}
        {!cwdExists && (
          <div className="new-error" role="alert">
            This session’s working directory no longer exists — a handoff needs the
            original directory.
          </div>
        )}

        <label className="ns-label" htmlFor="handoff-next">What should the agent do next</label>
        <textarea
          id="handoff-next"
          rows={3}
          placeholder="Optional — appended to the briefing"
          value={next}
          onChange={(e) => setNext(e.target.value)}
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
            disabled={
              busy || improving || briefLoading || !cwdExists || !briefing.trim() || agent.modelMissing
            }
          >
            {busy ? 'Starting…' : `Continue in ${PROVIDER_LABEL[provider]}`}
          </button>
        </div>
      </div>
    </main>
  )
}
