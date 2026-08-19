import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type {
  ExtensionsInventory,
  InstructionFile,
  InstructionsState,
  McpProbeResult,
  McpServerInfo,
  Provider,
  RepoGroup
} from '../../shared/types'
import { AgentPanel } from './AgentPanel'
import { api } from './api'
import { ProviderLogo, PROVIDER_LABEL } from './logos'
import { Markdown } from './Markdown'
import { Select } from './Select'

/**
 * Agents: what every agent on this machine shares, in one place.
 *
 * Two scopes, and the switch between them is the first thing on the card because
 * "which of these applies where?" was the question this view kept failing to
 * answer. Global is the agent home configs — every session, every repo. A project
 * scope is one repo, and it says plainly which kinds a repo can't carry at all.
 *
 * Inside a scope: the Panel is the whole setup with a switch per agent; the other
 * two tabs are the places that need more than a switch — writing the shared
 * baseline, and checking an MCP server actually answers.
 */

type Tab = 'panel' | 'instructions' | 'mcp'

const TABS: Array<[Tab, string]> = [
  ['panel', 'Panel'],
  ['instructions', 'Instructions'],
  ['mcp', 'MCP health']
]

const STATUS_LABEL: Record<InstructionFile['status'], string> = {
  synced: 'in sync',
  drifted: 'out of date',
  unmanaged: 'not applied',
  missing: 'no file yet'
}

const APPLY_LABEL: Record<Exclude<InstructionFile['status'], 'synced'>, string> = {
  missing: 'Create & apply',
  unmanaged: 'Apply',
  drifted: 'Re-apply'
}

type Notice = { text: string; kind: 'ok' | 'error' } | null

export function AiSetup({
  repos,
  repoRoot,
  onScope,
  onClose
}: {
  repos: RepoGroup[]
  /** null = global; otherwise the repo this view is scoped to */
  repoRoot: string | null
  onScope: (repoRoot: string | null) => void
  onClose: () => void
}): JSX.Element {
  const [inv, setInv] = useState<ExtensionsInventory | null>(null)
  const [tab, setTab] = useState<Tab>('panel')
  const [notice, setNotice] = useState<Notice>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)

  const reload = useCallback(() => {
    void api.getExtensions().then(setInv)
  }, [])

  useEffect(() => {
    reload()
    headingRef.current?.focus()
  }, [reload])

  const gitRepos = repos.filter((r) => r.root !== null)
  const scoped = gitRepos.find((r) => r.root === repoRoot)
  // a repo that vanished from the index leaves the view pointing at nothing —
  // fall back to global rather than showing an empty project scope
  const project = repoRoot !== null && scoped ? repoRoot : null

  useEffect(() => {
    if (repoRoot !== null && !scoped) onScope(null)
  }, [repoRoot, scoped, onScope])

  return (
    <main className="chat settings-view">
      <div className="ns-card">
        <div className="ns-head">
          <h2 ref={headingRef} tabIndex={-1}>Agents</h2>
          <button className="btn-ghost" onClick={onClose}>Close</button>
        </div>

        {/* the scope switch leads the card: everything below it means something
            different depending on which half is lit */}
        <div className="scope-switch" role="group" aria-label="Settings scope">
          <button
            className={`scope-half ${project === null ? 'active' : ''}`}
            aria-pressed={project === null}
            onClick={() => onScope(null)}
          >
            <span className="scope-name">Global</span>
            <span className="scope-sub">every session</span>
          </button>
          <div className={`scope-half scope-project ${project !== null ? 'active' : ''}`}>
            <span className="scope-name">Project</span>
            {gitRepos.length === 0 ? (
              <span className="scope-sub">no repos indexed yet</span>
            ) : (
              <Select
                ariaLabel="Project"
                className="scope-select"
                value={project ?? ''}
                options={[
                  { value: '', label: 'Pick a repo…' },
                  ...gitRepos.map((r) => ({ value: r.root as string, label: r.fullName ?? r.name }))
                ]}
                onChange={(v) => onScope(v === '' ? null : v)}
              />
            )}
          </div>
        </div>

        <p className="scope-blurb">
          {project === null ? (
            <>
              Applies to <strong>every session, in every repo</strong> — written into each
              agent’s own config in your home folder.
            </>
          ) : (
            <>
              Applies to sessions in <code>{project.replace(/^\/Users\/[^/]+/, '~')}</code> only.
              Global settings apply here too, on top of these.
            </>
          )}
        </p>

        <div
          className="ext-tabs"
          role="tablist"
          aria-label="Agents sections"
          // full tabs pattern: one tab stop (roving tabindex), arrows move + select
          onKeyDown={(e) => {
            const order = TABS.map(([t]) => t)
            const i = order.indexOf(tab)
            let next: Tab | undefined
            if (e.key === 'ArrowRight') next = order[(i + 1) % order.length]
            else if (e.key === 'ArrowLeft') next = order[(i - 1 + order.length) % order.length]
            else if (e.key === 'Home') next = order[0]
            else if (e.key === 'End') next = order[order.length - 1]
            if (!next) return
            e.preventDefault()
            setTab(next)
            document.getElementById(`tab-${next}`)?.focus()
          }}
        >
          {TABS.map(([t, label]) => (
            <button
              key={t}
              id={`tab-${t}`}
              role="tab"
              aria-selected={tab === t}
              aria-controls={`panel-${t}`}
              tabIndex={tab === t ? 0 : -1}
              className={`ext-tab ${tab === t ? 'active' : ''}`}
              onClick={() => setTab(t)}
            >
              {label}
            </button>
          ))}
        </div>

        {notice && (
          <div
            className={`ext-notice ${notice.kind}`}
            role={notice.kind === 'error' ? 'alert' : 'status'}
          >
            {notice.text}
          </div>
        )}

        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="tab-panel">
          {tab === 'panel' && (
            <AgentPanel
              key={project ?? 'global'}
              repoRoot={project}
              setNotice={setNotice}
              onOpenInstructions={() => setTab('instructions')}
            />
          )}

          {tab === 'instructions' && (
            <InstructionsTab key={project ?? 'global'} repoRoot={project} setNotice={setNotice} />
          )}

          {tab === 'mcp' && !inv && <div className="tree-empty">loading…</div>}
          {tab === 'mcp' && inv && <McpTab inv={inv} reload={reload} setNotice={setNotice} />}
        </div>
      </div>
    </main>
  )
}

/* ---------- MCP health ---------- */

const MCP_STATUS_LABEL: Record<McpProbeResult['status'], string> = {
  ok: 'connected',
  'needs-auth': 'needs login',
  error: 'unreachable'
}

/** Agents whose CLI has an `mcp login` command */
const LOGIN_AGENTS: Provider[] = ['claude', 'codex']

/**
 * Whether a server *answers*, which no switch can tell you. Turning servers on and
 * off lives in the Panel — this tab is only the things that need to talk to the
 * server itself: a probe, and the CLI's own OAuth flow.
 */
function McpTab({
  inv,
  reload,
  setNotice
}: {
  inv: ExtensionsInventory
  reload: () => void
  setNotice: (n: Notice) => void
}): JSX.Element {
  const [status, setStatus] = useState<Record<string, McpProbeResult | 'checking'>>({})
  const [loginBusy, setLoginBusy] = useState<string | null>(null)

  const check = async (s: McpServerInfo): Promise<void> => {
    setStatus((m) => ({ ...m, [s.name]: 'checking' }))
    try {
      const r = await api.checkMcp(s.name)
      setStatus((m) => ({ ...m, [s.name]: r }))
    } catch (err) {
      setStatus((m) => ({
        ...m,
        [s.name]: { status: 'error', detail: err instanceof Error ? err.message : String(err) }
      }))
    }
  }

  const login = async (s: McpServerInfo, agent: Provider): Promise<void> => {
    // claude project-only servers must log in from the project directory
    const claudeUser = s.presences.some((p) => p.agent === 'claude' && p.scope === 'user')
    const projectPath =
      agent === 'claude' && !claudeUser
        ? s.presences.find((p) => p.agent === 'claude')?.projectPath
        : undefined
    setNotice({
      text: `Logging in to "${s.name}" with ${PROVIDER_LABEL[agent]} — finish the flow in your browser.`,
      kind: 'ok'
    })
    setLoginBusy(`${s.name}|${agent}`)
    try {
      const msg = await api.loginMcp(s.name, agent, projectPath)
      setNotice({ text: msg, kind: 'ok' })
      void check(s)
    } catch (err) {
      setNotice({ text: `Login failed: ${err instanceof Error ? err.message : err}`, kind: 'error' })
    } finally {
      setLoginBusy(null)
    }
  }

  return (
    <>
      <p className="ns-hint">
        Whether each server actually answers. <strong>Check</strong> runs the configured command
        or hits the URL; when a server reports <em>needs login</em>, run the agent’s own OAuth
        flow here. Turning servers on and off is in the Panel.
      </p>
      <div className="mcp-tools">
        <button className="btn-ghost small" title="Re-read every agent’s config" onClick={reload}>
          Refresh list
        </button>
      </div>
      <ul className="ext-list">
        {inv.mcp.map((s) => {
          const st = status[s.name]
          const probing = st === 'checking'
          const result = probing || !st ? null : st
          return (
            <li key={s.name} className="ext-row mcp-row">
              <div className="ext-body">
                <div className="ext-name">
                  {s.name}
                  {(probing || result) && (
                    <span
                      className={`mcp-status ${probing ? 'checking' : result!.status}`}
                      title={result?.detail}
                    >
                      {probing ? 'checking…' : MCP_STATUS_LABEL[result!.status]}
                    </span>
                  )}
                </div>
                <div className="ext-detail" title={s.config.url ?? s.config.command}>
                  {s.config.url ?? `${s.config.command ?? '?'} ${(s.config.args ?? []).join(' ')}`}
                </div>
                <div className="mcp-presences">
                  {s.presences.map((p) => (
                    <span
                      key={`${p.agent}|${p.projectPath ?? 'user'}`}
                      className={`mcp-scope ${p.agent}`}
                      title={p.projectPath ?? `${PROVIDER_LABEL[p.agent]} global config`}
                    >
                      <span className={`plogo plogo-${p.agent}`}>
                        <ProviderLogo p={p.agent} size={10} />
                      </span>
                      <span className="mcp-scope-label">
                        {p.scope === 'project' ? (p.projectPath?.split('/').pop() ?? 'project') : 'global'}
                      </span>
                    </span>
                  ))}
                </div>
              </div>
              <div className="ext-actions">
                {result?.status === 'needs-auth' &&
                  s.config.url &&
                  s.agents
                    .filter((a) => LOGIN_AGENTS.includes(a))
                    .map((a) => (
                      <button
                        key={a}
                        className="btn-ghost small"
                        disabled={loginBusy !== null}
                        title={`Run \u201c${a} mcp login ${s.name}\u201d — opens your browser`}
                        onClick={() => void login(s, a)}
                      >
                        {loginBusy === `${s.name}|${a}` ? 'waiting…' : `Log in · ${PROVIDER_LABEL[a]}`}
                      </button>
                    ))}
                <button
                  className="btn-ghost small"
                  disabled={probing}
                  title="Probe the server with your configured command or URL"
                  onClick={() => void check(s)}
                >
                  Check
                </button>
              </div>
            </li>
          )
        })}
        {inv.mcp.length === 0 && (
          <li className="tree-empty">no MCP servers configured in any agent yet</li>
        )}
      </ul>
    </>
  )
}

/* ---------- Instructions tab ---------- */

function InstructionsTab({
  repoRoot,
  setNotice
}: {
  repoRoot: string | null
  setNotice: (n: Notice) => void
}): JSX.Element {
  const [inst, setInst] = useState<InstructionsState | null>(null)
  const [draft, setDraft] = useState('')
  const [mdView, setMdView] = useState<'write' | 'preview'>('write')
  const [busy, setBusy] = useState(false)
  /** Read inside async callbacks — the closure's `repoRoot` is the value at call time. */
  const repoRootRef = useRef(repoRoot)
  repoRootRef.current = repoRoot

  useEffect(() => {
    let dead = false
    setInst(null)
    void api.getInstructions(repoRoot).then((s) => {
      if (dead) return
      setInst(s)
      setDraft(s.baseline)
    })
    return () => {
      dead = true
    }
  }, [repoRoot])

  const dirty = inst !== null && draft !== inst.baseline

  const run = async (op: () => Promise<InstructionsState>, okText: string): Promise<void> => {
    setNotice(null)
    setBusy(true)
    const startedOn = repoRoot
    try {
      const s = await op()
      // a slow apply resolving after the user switched scope must not write the
      // old scope's baseline into the newly loaded one
      if (startedOn !== repoRootRef.current) return
      setInst(s)
      setDraft(s.baseline)
      setNotice({ text: okText, kind: 'ok' })
    } catch (err) {
      if (startedOn !== repoRootRef.current) return
      setNotice({ text: err instanceof Error ? err.message : String(err), kind: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const saveBaseline = (): Promise<void> =>
    run(() => api.saveInstructionsBaseline(repoRoot, draft), 'Shared instructions saved.')

  const saveAndApply = (): Promise<void> =>
    run(
      async () => {
        await api.saveInstructionsBaseline(repoRoot, draft)
        return api.applyInstructions(repoRoot)
      },
      'Applied to every agent file — running sessions pick it up on their next start.'
    )

  const applyOne = (path: string): Promise<void> =>
    run(() => api.applyInstructions(repoRoot, path), 'Applied — restart that agent to pick it up.')

  return (
    <>
      <p className="ns-hint">
        One shared baseline, written into each agent&apos;s own instructions file inside{' '}
        <code>&lt;!-- cockpit:shared --&gt;</code> markers. Anything outside the markers belongs to
        that agent alone and is never touched.
      </p>

      {!inst && <div className="tree-empty">loading…</div>}

      {inst && (
        <>
          {/* GitHub-comment grammar: the baseline is markdown, so edit it like markdown */}
          <div className="md-tabs" role="group" aria-label="Editor mode">
            <button
              className={`md-tab ${mdView === 'write' ? 'active' : ''}`}
              aria-pressed={mdView === 'write'}
              onClick={() => setMdView('write')}
            >
              Write
            </button>
            <button
              className={`md-tab ${mdView === 'preview' ? 'active' : ''}`}
              aria-pressed={mdView === 'preview'}
              onClick={() => setMdView('preview')}
            >
              Preview
            </button>
          </div>
          {mdView === 'write' ? (
            <textarea
              className="inst-baseline"
              aria-label="Shared instructions"
              rows={8}
              placeholder={
                repoRoot
                  ? '# Conventions for this repo that every agent should follow…'
                  : '# General instructions every agent should follow, everywhere…\n\nE.g. commit style, language, review rules, what never to touch.'
              }
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          ) : (
            <div className="inst-preview markdown" aria-label="Shared instructions preview">
              {draft.trim() ? (
                <Markdown text={draft} />
              ) : (
                <p className="inst-preview-empty">nothing to preview yet — write some markdown first</p>
              )}
            </div>
          )}
          <div className="inst-actions">
            {dirty && <span className="inst-dirty">unsaved changes</span>}
            <button className="btn-ghost" disabled={busy || !dirty} onClick={() => void saveBaseline()}>
              Save
            </button>
            <button
              className="btn-primary"
              disabled={busy || draft.trim() === ''}
              onClick={() => void saveAndApply()}
            >
              Save &amp; apply to all
            </button>
          </div>

          <ul className="ext-list" aria-label="Agent instruction files">
            {inst.files.map((f) => (
              <InstructionFileRow
                key={f.path}
                file={f}
                busy={busy}
                baselineEmpty={inst.baseline.trim() === ''}
                onApply={() => void applyOne(f.path)}
                onSaveFile={(content) =>
                  void run(
                    () => api.saveInstructionFile(repoRoot, f.path, content),
                    'File saved.'
                  )
                }
              />
            ))}
          </ul>
        </>
      )}
    </>
  )
}

function InstructionFileRow({
  file,
  busy,
  baselineEmpty,
  onApply,
  onSaveFile
}: {
  file: InstructionFile
  busy: boolean
  baselineEmpty: boolean
  onApply: () => void
  onSaveFile: (content: string) => void
}): JSX.Element {
  const [text, setText] = useState(file.content)
  // a reload (e.g. applying another file) must not clobber an in-progress edit here:
  // only follow file.content when the textarea still matched the previous content
  const lastContent = useRef(file.content)
  useEffect(() => {
    if (file.content === lastContent.current) return
    setText((t) => (t === lastContent.current ? file.content : t))
    lastContent.current = file.content
  }, [file.content])

  return (
    <li className={`ext-row inst-file ${file.agents.length === 1 ? `tint-${file.agents[0]}` : ''}`}>
      <div className="ext-agents" aria-label={`Read by ${file.agents.map((a) => PROVIDER_LABEL[a]).join(' and ')}`}>
        {file.agents.map((a) => (
          <span key={a} className={`plogo plogo-${a}`} title={PROVIDER_LABEL[a]}>
            <ProviderLogo p={a} size={13} />
          </span>
        ))}
      </div>
      <div className="ext-body">
        <div className="ext-name">
          <span className="inst-path">{file.path.replace(/^\/Users\/[^/]+/, '~')}</span>
          <span className={`inst-status ${file.status}`}>{STATUS_LABEL[file.status]}</span>
        </div>
        {file.exists && (
          <details className="inst-edit">
            <summary>view / edit file</summary>
            <textarea
              aria-label={`Contents of ${file.path}`}
              rows={10}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="inst-actions">
              <button
                className="btn-ghost small"
                disabled={busy || text === file.content}
                onClick={() => onSaveFile(text)}
              >
                Save file
              </button>
            </div>
          </details>
        )}
      </div>
      {file.status !== 'synced' && (
        <div className="ext-actions">
          <button
            className="btn-ghost small"
            disabled={busy || baselineEmpty}
            title={baselineEmpty ? 'Write and save shared instructions first' : undefined}
            onClick={onApply}
          >
            {APPLY_LABEL[file.status]}
          </button>
        </div>
      )}
    </li>
  )
}
