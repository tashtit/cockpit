import { useEffect, useRef, useState, type JSX } from 'react'
import type { RepoGroup, SessionHolder } from '../../shared/types'
import { api } from './api'
import { HOLDER_FILTER_LABEL, setHolderFilter, useHolderFilter } from './hold'
import { agentCounts, setAgentShown, useHiddenAgents } from './agent-filter'
import { ChatIcon, EyeIcon, HeldIcon, ProcessIcon, ProviderLogo, PROVIDER_LABEL, RepoIcon } from './logos'
import { plural } from './format'

/**
 * Eye popover: what the tree shows — sessions by who drives them (every one, only
 * Cockpit's, or only those with their agent), then by agent (`agent-filter.ts`), then
 * every indexed project with a visibility checkbox (all on by default).
 */
export function ProjectFilter({
  repos,
  onResetOrder
}: {
  repos: RepoGroup[]
  /** Present only while the projects are in a dragged order — puts them back A→Z */
  onResetOrder?: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const hiddenCount = repos.filter((r) => r.hidden).length
  const holder = useHolderFilter()
  const hiddenAgents = useHiddenAgents()
  const shown = repos.filter((r) => !r.hidden)
  const counts: Record<'all' | SessionHolder, number> = {
    all: shown.reduce((n, r) => n + r.sessionCount, 0),
    cockpit: shown.reduce((n, r) => n + r.heldCount, 0),
    agent: shown.reduce((n, r) => n + r.sessionCount - r.heldCount, 0)
  }
  // every agent with a session here, and any hidden one that has none right now — so an
  // agent can always be switched back on
  const agents = [
    ...agentCounts(shown, holder),
    ...hiddenAgents.filter((a) => !shown.some((r) => r.byProvider[a])).map((agent) => ({ agent, count: 0 }))
  ]
  const scoped = [
    holder ? HOLDER_FILTER_LABEL[holder].toLowerCase() : null,
    hiddenAgents.length > 0 ? `${plural(hiddenAgents.length, 'agent')} hidden` : null,
    hiddenCount > 0 ? `${plural(hiddenCount, 'project')} hidden` : null
  ].filter((x): x is string => x !== null)

  useEffect(() => {
    if (!open) return
    // keyboard users land inside the popover; Esc closes it and returns focus
    popRef.current?.querySelector<HTMLInputElement>('input')?.focus()
    const onDown = (e: MouseEvent): void => {
      if (wrapRef.current?.contains(e.target as Node)) return
      // the popover is about to unmount — hand focus back to its trigger rather than
      // letting it fall to <body> and restart Tab order at the top of the window
      if (popRef.current?.contains(document.activeElement)) btnRef.current?.focus()
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        // the popover owns this Esc — App's view-level handler must not also fire
        e.stopPropagation()
        setOpen(false)
        btnRef.current?.focus()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="repo-filter-wrap" ref={wrapRef}>
      <button
        ref={btnRef}
        className={`icon-btn ${scoped.length > 0 ? 'filter-active' : ''}`}
        title={
          scoped.length > 0
            ? `Choose what the tree shows — ${scoped.join(', ')}`
            : 'Choose what the tree shows'
        }
        aria-label="Choose what the tree shows"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <EyeIcon size={16} />
        {scoped.length > 0 && <span className="filter-dot" aria-hidden />}
      </button>
      {open && (
        <div className="repo-filter-pop" role="dialog" aria-label="What the tree shows" ref={popRef}>
          <div className="repo-filter-head" id="holder-filter-head">
            <span>Sessions</span>
          </div>
          <div role="radiogroup" aria-labelledby="holder-filter-head">
            {([null, 'cockpit', 'agent'] as const).map((h) => (
              <label
                key={h ?? 'all'}
                className="repo-filter-row"
                title={
                  h === null
                    ? 'Every session, whoever drives it'
                    : h === 'cockpit'
                      ? 'Sessions Cockpit started or took over — it sends their turns'
                      : 'Sessions from a terminal or an agent’s own app, or released back there — Cockpit only follows their logs'
                }
              >
                <input
                  type="radio"
                  name="holder-filter"
                  checked={holder === h}
                  onChange={() => setHolderFilter(h)}
                />
                <span className="repo-icon">
                  {h === 'cockpit' ? <HeldIcon size={12} /> : h === 'agent' ? <ProcessIcon size={12} /> : <ChatIcon size={12} />}
                </span>
                <span className="repo-filter-name">{h === null ? 'All sessions' : HOLDER_FILTER_LABEL[h]}</span>
                <span className="repo-count">{counts[h ?? 'all']}</span>
              </label>
            ))}
          </div>
          {agents.length > 1 || hiddenAgents.length > 0 ? (
            <>
              <div className="repo-filter-head repo-filter-divided" id="agent-filter-head">
                <span>Agents</span>
              </div>
              <div role="group" aria-labelledby="agent-filter-head">
                {agents.map(({ agent, count }) => (
                  <label key={agent} className="repo-filter-row" title={`Sessions of ${PROVIDER_LABEL[agent]}`}>
                    <input
                      type="checkbox"
                      checked={!hiddenAgents.includes(agent)}
                      onChange={(e) => setAgentShown(agent, e.currentTarget.checked)}
                    />
                    <span className={`repo-icon plogo plogo-${agent}`} aria-hidden="true">
                      <ProviderLogo p={agent} size={12} />
                    </span>
                    <span className="repo-filter-name">{PROVIDER_LABEL[agent]}</span>
                    <span className="repo-count">{count}</span>
                  </label>
                ))}
              </div>
            </>
          ) : null}
          <div className="repo-filter-head repo-filter-divided">
            <span>Projects</span>
            {onResetOrder && (
              <button
                className="btn-ghost small repo-filter-reset"
                title="Forget the dragged order and list projects A→Z"
                onClick={onResetOrder}
              >
                sort A→Z
              </button>
            )}
          </div>
          {repos.map((r) => (
            <label key={r.key} className="repo-filter-row" title={r.fullName ?? r.root ?? r.name}>
              <input
                type="checkbox"
                checked={!r.hidden}
                // drive from the checkbox's own post-click state, not from the
                // prop: the prop only catches up after the IPC round-trip, so a
                // quick second click would otherwise re-send the first value
                onChange={(e) => void api.setRepoHidden(r.key, !e.currentTarget.checked)}
              />
              {/* repo-less sessions are "Chats" everywhere the rail names them */}
              <span className="repo-icon">
                {r.key === 'general' ? <ChatIcon size={12} /> : <RepoIcon size={12} />}
              </span>
              <span className="repo-filter-name">
                {r.key === 'general' ? 'Chats' : (r.fullName ?? r.name)}
              </span>
              <span className="repo-count">{r.sessionCount + r.archivedCount}</span>
            </label>
          ))}
          {repos.length === 0 && <div className="tree-empty">no projects indexed</div>}
        </div>
      )}
    </div>
  )
}
