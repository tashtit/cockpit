import { useEffect, useState, type JSX } from 'react'
import type { AgentOptions, PermissionMode, SessionProvider } from '../../shared/types'
import { api } from './api'
import { ipcErrorText } from './ipc-error'
import { PROVIDERS, cwdLabel } from '../../shared/library'
import { isDrivable } from '../../shared/providers'
import { rememberChoice, useAgentChoice, type AccountChoice } from './agent-choice'
import {
  AccountField,
  AgentCards,
  AgentOptionsFields,
  AgentOptionsHints,
  ModeField,
  ModeHint,
  useAgentOptions
} from './agent-options'
import { BranchChip, ProviderLogo, PROVIDER_LABEL } from './logos'
import { ErrorAlert } from './ErrorAlert'

/** The session being handed off, snapshotted from the open chat binding. */
export type HandoffSourceRef = {
  /** `${provider}:${nativeId}` */
  readonly id: string
  /** Any agent the index reads — a session of one Cockpit only reads hands off too */
  readonly provider: SessionProvider
  readonly title: string
  readonly cwd: string
  readonly branch: string | null
  readonly repoRoot: string | null
}

/** Everything needed to continue the source session on another agent. */
export type StartHandoffRequest = {
  readonly source: HandoffSourceRef
  /** One of the three CLIs, or an agent Cockpit otherwise only reads that an ACP agent drives */
  readonly provider: SessionProvider
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
  const choice = useAgentChoice(() => PROVIDERS.find((p) => p !== source.provider) ?? 'claude')
  const { provider, mode } = choice
  const agent = useAgentOptions(provider, choice.account?.configDir)
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
        setBriefError(ipcErrorText(err))
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
        setError(`Improve failed: ${ipcErrorText(err)}`)
      })
      .finally(() => setImproving(false))
  }

  const start = async (): Promise<void> => {
    if (busy || improving || !cwdExists || !briefing.trim() || agent.modelMissing) return
    setError(null)
    rememberChoice(choice)
    const finalBriefing = next.trim()
      ? `${briefing.trimEnd()}\n\n## What to do next\n\n${next.trim()}`
      : briefing
    const err = await onStart({
      source,
      provider,
      briefing: finalBriefing,
      mode,
      options: agent.options,
      account: choice.runAs
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
        <div className="handoff-source" role="group" aria-labelledby="handoff-source-label">
          <span className={`acct-chip acct-${source.provider}`}>
            <ProviderLogo p={source.provider} size={10} /> {PROVIDER_LABEL[source.provider]}
          </span>
          <span className="handoff-source-title" title={source.title}>{source.title}</span>
          {source.branch && <BranchChip branch={source.branch} />}
        </div>
        <div className="ns-hint">
          Same worktree, same branch — the new session starts in{' '}
          <span className="handoff-cwd" title={source.cwd}>{cwdLabel(source.cwd, source.repoRoot, source.branch)}</span>. No new workspace is created.
        </div>

        <label className="ns-label">Continue with</label>
        <AgentCards choice={choice} label="Continue with" />

        <div className="ns-options ns-agent-options">
          {isDrivable(provider) && (
            <AccountField
              opts={choice.opts}
              account={choice.account}
              loading={choice.accounts === null}
              onChange={choice.setAccount}
            />
          )}
          <AgentOptionsFields provider={provider} o={agent} />
          <ModeField mode={mode} onChange={choice.setMode} />
        </div>
        <ModeHint mode={mode} />
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
          {/* improving resumes the source session in its own CLI — one Cockpit runs */}
          {isDrivable(source.provider) && (
            <button
              className="btn-ghost small"
              disabled={improving || briefLoading}
              onClick={improve}
              title={`Ask the ${PROVIDER_LABEL[source.provider]} session to write its own handoff briefing`}
            >
              {improving ? `Asking ${PROVIDER_LABEL[source.provider]}…` : 'Improve with AI'}
            </button>
          )}
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
          <ErrorAlert>
            Briefing failed: {briefError}{' '}
            <button className="link-btn" onClick={loadBriefing}>Retry</button>
          </ErrorAlert>
        )}
        {warnings.map((w) => (
          <div key={w} className="ns-hint">{w}</div>
        ))}
        {!cwdExists && (
          <ErrorAlert>
            This session’s working directory no longer exists — a handoff needs the
            original directory.
          </ErrorAlert>
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

        {error && <ErrorAlert>{error}</ErrorAlert>}

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
