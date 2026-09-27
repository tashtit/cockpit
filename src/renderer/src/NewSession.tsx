import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { RepoGroup } from '../../shared/types'
import { rememberChoice, useAgentChoice, type StartSessionRequest } from './agent-choice'
import {
  AccountField,
  AgentCards,
  AgentOptionsFields,
  AgentOptionsHints,
  ModeField,
  ModeHint,
  useAgentOptions
} from './agent-options'
import { AttachRow, useImageAttachments, type ImageAttachment } from './attachments'
import { Select } from './Select'
import { branchHint } from './task-names'
import { useBranchPrefix } from './branch-prefix'
import { ErrorAlert } from './ErrorAlert'

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
  const [name, setName] = useState('')
  const branchPrefix = useBranchPrefix()
  const [prompt, setPrompt] = useState(initialPrompt ?? '')
  const atts = useImageAttachments(initialImages)
  const [error, setError] = useState<string | null>(null)
  const promptRef = useRef<HTMLTextAreaElement>(null)

  const selectable = useMemo(() => repos.filter((r) => r.root), [repos])
  const selected = selectable.find((r) => r.key === repoKey) ?? repo

  const choice = useAgentChoice()
  const { provider, mode } = choice
  const agent = useAgentOptions(provider, choice.account?.configDir)

  // keyboard users land in the task field instead of tabbing through the sidebar
  useEffect(() => {
    promptRef.current?.focus()
  }, [])

  const start = async (): Promise<void> => {
    // the button is held for a missing model; ⌘Enter in the task field must be too
    if (busy || agent.modelMissing || (!prompt.trim() && atts.attachments.length === 0)) return
    setError(null)
    rememberChoice(choice)
    const err = await onStart({
      repo: selected,
      provider,
      name: name.trim(),
      prompt: prompt.trim(),
      mode,
      options: agent.options,
      account: choice.runAs,
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
        <AgentCards choice={choice} label="Agent" />

        <div className="ns-options ns-agent-options">
          <AccountField
            opts={choice.opts}
            account={choice.account}
            loading={choice.accounts === null}
            onChange={choice.setAccount}
          />
          <AgentOptionsFields provider={provider} o={agent} />
          <ModeField mode={mode} onChange={choice.setMode} />
        </div>
        <ModeHint mode={mode} />
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

        {error && <ErrorAlert>{error}</ErrorAlert>}

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
