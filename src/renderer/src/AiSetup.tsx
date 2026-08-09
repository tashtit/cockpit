import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ExtensionsInventory,
  InstructionFile,
  InstructionsState,
  McpServerInfo,
  Provider,
  RepoGroup
} from '../../shared/types'
import { api } from './api'
import { ProviderLogo, PROVIDER_LABEL } from './logos'
import { Select } from './Select'

const PROVIDERS: Provider[] = ['claude', 'codex', 'copilot']
type Tab = 'instructions' | 'mcp' | 'skills' | 'plugins' | 'marketplace'

const TABS: Array<[Tab, string]> = [
  ['instructions', 'Instructions'],
  ['mcp', 'MCP Servers'],
  ['skills', 'Skills'],
  ['plugins', 'Plugins'],
  ['marketplace', 'Marketplace']
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
  onClose,
  onOpenUrl
}: {
  repos: RepoGroup[]
  onClose: () => void
  onOpenUrl: (url: string) => void
}): JSX.Element {
  const [inv, setInv] = useState<ExtensionsInventory | null>(null)
  const [tab, setTab] = useState<Tab>('instructions')
  const [notice, setNotice] = useState<Notice>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)

  const reload = useCallback(() => {
    void api.getExtensions().then(setInv)
  }, [])

  useEffect(() => {
    reload()
    headingRef.current?.focus()
  }, [reload])

  const share = async (server: McpServerInfo, to: Provider): Promise<void> => {
    setNotice(null)
    try {
      await api.shareMcp(server.name, to)
      setNotice({
        text: `Added "${server.name}" to ${PROVIDER_LABEL[to]} — restart that CLI to pick it up.`,
        kind: 'ok'
      })
      reload()
    } catch (err) {
      setNotice({ text: `Share failed: ${err instanceof Error ? err.message : err}`, kind: 'error' })
    }
  }

  const shareSkill = async (name: string, from: Provider, to: Provider): Promise<void> => {
    setNotice(null)
    try {
      await api.shareSkill(name, from, to)
      setNotice({ text: `Copied skill "${name}" to ${PROVIDER_LABEL[to]}.`, kind: 'ok' })
      reload()
    } catch (err) {
      setNotice({ text: `Copy failed: ${err instanceof Error ? err.message : err}`, kind: 'error' })
    }
  }

  return (
    <main className="chat settings-view">
      <div className="ns-card wide">
        <div className="ns-head">
          <h2 ref={headingRef} tabIndex={-1}>AI Setup</h2>
          <button className="btn-ghost" onClick={onClose}>Close</button>
        </div>

        <div
          className="ext-tabs"
          role="tablist"
          aria-label="AI Setup sections"
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
        {tab === 'instructions' && <InstructionsTab repos={repos} setNotice={setNotice} />}

        {tab !== 'instructions' && !inv && <div className="tree-empty">loading…</div>}

        {inv && tab === 'mcp' && (
          <>
            <p className="ns-hint">
              MCP servers configured across your agents — including Claude&apos;s per-project
              servers from <code>~/.claude.json</code>. Sharing writes the server into the target
              agent&apos;s own config format (<code>~/.claude.json</code>,{' '}
              <code>~/.codex/config.toml</code>, <code>~/.copilot/mcp-config.json</code>).
            </p>
            <ul className="ext-list">
              {inv.mcp.map((s) => {
                const projects = s.origins
                  .filter((o) => o.startsWith('project:'))
                  .map((o) => o.slice('project:'.length))
                return (
                  <li key={s.name} className="ext-row">
                    <div className="ext-body">
                      <div className="ext-name">
                        {s.name}
                        {projects.length > 0 && (
                          <span
                            className="ext-origin"
                            title={`Configured per-project in: ${projects.join(', ')}`}
                          >
                            project: {projects.join(', ')}
                          </span>
                        )}
                      </div>
                      <div className="ext-detail" title={s.config.url ?? `${s.config.command ?? ''} ${(s.config.args ?? []).join(' ')}`}>
                        {s.config.url ?? `${s.config.command ?? '?'} ${(s.config.args ?? []).join(' ')}`}
                      </div>
                    </div>
                    <div className="ext-agents" aria-label={`Configured in ${s.agents.map((a) => PROVIDER_LABEL[a]).join(', ')}`}>
                      {s.agents.map((a) => (
                        <span key={a} className={`plogo plogo-${a}`} title={PROVIDER_LABEL[a]}>
                          <ProviderLogo p={a} size={13} />
                        </span>
                      ))}
                    </div>
                    <div className="ext-actions">
                      {PROVIDERS.filter((p) => !s.agents.includes(p)).map((p) => (
                        <button key={p} className="btn-ghost small" onClick={() => void share(s, p)}>
                          + {PROVIDER_LABEL[p]}
                        </button>
                      ))}
                    </div>
                  </li>
                )
              })}
              {inv.mcp.length === 0 && <li className="tree-empty">no MCP servers configured in any agent</li>}
            </ul>
          </>
        )}

        {inv && tab === 'skills' && (
          <>
            <p className="ns-hint">
              Personal skills from <code>~/.claude/skills</code> and <code>~/.copilot/skills</code>.
              Copying duplicates the skill directory into the other agent (Codex has no skills).
              Plugin-provided skills live inside their plugin.
            </p>
            <ul className="ext-list">
              {inv.skills.map((s) => {
                const other: Provider = s.agent === 'claude' ? 'copilot' : 'claude'
                const otherHas = inv.skills.some((x) => x.agent === other && x.name === s.name)
                return (
                  <li key={`${s.agent}:${s.name}`} className="ext-row">
                    <span className={`plogo plogo-${s.agent}`} title={PROVIDER_LABEL[s.agent]}>
                      <ProviderLogo p={s.agent} size={13} />
                    </span>
                    <div className="ext-body">
                      <div className="ext-name">{s.name}</div>
                      <div className="ext-detail">{s.description || s.path}</div>
                    </div>
                    {!otherHas && (
                      <div className="ext-actions">
                        <button
                          className="btn-ghost small"
                          onClick={() => void shareSkill(s.name, s.agent, other)}
                        >
                          + {PROVIDER_LABEL[other]}
                        </button>
                      </div>
                    )}
                  </li>
                )
              })}
              {inv.skills.length === 0 && (
                <li className="tree-empty">no personal skills found — plugin skills are managed by their plugins</li>
              )}
            </ul>
          </>
        )}

        {inv && tab === 'plugins' && (
          <ul className="ext-list">
            {inv.plugins.map((p) => (
              <li key={`${p.agent}:${p.name}`} className="ext-row">
                <span className={`plogo plogo-${p.agent}`} title={PROVIDER_LABEL[p.agent]}>
                  <ProviderLogo p={p.agent} size={13} />
                </span>
                <div className="ext-body">
                  <div className="ext-name">{p.name}</div>
                  {p.detail && <div className="ext-detail">{p.detail}</div>}
                </div>
              </li>
            ))}
            {inv.plugins.length === 0 && <li className="tree-empty">no plugins installed</li>}
          </ul>
        )}

        {inv && tab === 'marketplace' && (
          <>
            <ul className="ext-list">
              {inv.marketplaces.map((m) => (
                <li key={m.name} className="ext-row">
                  <span className={`plogo plogo-${m.agent}`} title={PROVIDER_LABEL[m.agent]}>
                    <ProviderLogo p={m.agent} size={13} />
                  </span>
                  <div className="ext-body">
                    <div className="ext-name">{m.name}</div>
                    {m.source && <div className="ext-detail">{m.source}</div>}
                  </div>
                  {m.source && /^[\w.-]+\/[\w.-]+$/.test(m.source) && (
                    <button
                      className="btn-ghost small"
                      onClick={() => onOpenUrl(`https://github.com/${m.source}`)}
                    >
                      Open ↗
                    </button>
                  )}
                </li>
              ))}
              {inv.marketplaces.length === 0 && <li className="tree-empty">no marketplaces registered</li>}
            </ul>
            <p className="ns-hint">
              Browse more: install marketplaces with <code>claude plugin marketplace add &lt;repo&gt;</code>,
              or explore the{' '}
              <button className="link-btn" onClick={() => onOpenUrl('https://github.com/modelcontextprotocol/servers')}>
                MCP servers registry ↗
              </button>
            </p>
          </>
        )}
        </div>
      </div>
    </main>
  )
}

/* ---------- Instructions tab ---------- */

function InstructionsTab({
  repos,
  setNotice
}: {
  repos: RepoGroup[]
  setNotice: (n: Notice) => void
}): JSX.Element {
  const [inst, setInst] = useState<InstructionsState | null>(null)
  const [scope, setScope] = useState<string>('global')
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const repoRoot = scope === 'global' ? null : scope
  const gitRepos = repos.filter((r) => r.root !== null)

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
    try {
      const s = await op()
      setInst(s)
      setDraft(s.baseline)
      setNotice({ text: okText, kind: 'ok' })
    } catch (err) {
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

      <div className="inst-scope">
        <label htmlFor="inst-scope-sel">Scope</label>
        <Select
          id="inst-scope-sel"
          ariaLabel="Scope"
          className="inst-scope-select"
          value={scope}
          options={[
            { value: 'global', label: 'Global — every session, all repos' },
            ...gitRepos.map((r) => ({ value: r.root as string, label: r.fullName ?? r.name }))
          ]}
          onChange={(v) => {
            // switching scope reloads the baseline — never silently drop unsaved edits
            if (dirty && !window.confirm('Discard unsaved shared-instructions changes?')) return
            setScope(v)
          }}
        />
      </div>

      {!inst && <div className="tree-empty">loading…</div>}

      {inst && (
        <>
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
