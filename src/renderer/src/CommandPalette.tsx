import { useEffect, useId, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import type { RepoGroup, SessionMeta, TimeFormat } from '../../shared/types'
import { api } from './api'
import { useBusyMap } from './busy'
import {
  AgentIcon,
  BranchChip,
  CockpitLogo,
  GearIcon,
  GraphIcon,
  LiveDot,
  ProviderLogo,
  PROVIDER_LABEL,
  RepoIcon,
  SlidersIcon
} from './logos'
import { fmtTime, useTimeFormat } from './time'

/** Views the palette can navigate to — App's View kinds, minus chat/new (those need a target). */
export type PaletteViewKey = 'welcome' | 'extensions' | 'profile' | 'settings'

type ViewTarget = {
  readonly key: PaletteViewKey
  readonly label: string
  /** Real binding shown in the hint slot — must match App's shortcuts */
  readonly hint?: string
  /** What people search for when they mean this view */
  readonly keywords: readonly string[]
  readonly icon: ReactNode
}

const VIEWS: readonly ViewTarget[] = [
  {
    key: 'welcome',
    label: 'Home',
    hint: '⌘N',
    keywords: ['home', 'board', 'new task', 'mission control'],
    icon: <CockpitLogo size={13} />
  },
  {
    key: 'extensions',
    label: 'Agents',
    keywords: ['agents', 'instructions', 'mcp', 'skills', 'plugins', 'marketplace', 'extensions'],
    icon: <AgentIcon size={13} />
  },
  {
    key: 'profile',
    label: 'Profile',
    keywords: ['profile', 'activity', 'stats', 'heatmap', 'streak'],
    icon: <GraphIcon size={13} />
  },
  {
    key: 'settings',
    label: 'Settings',
    hint: '⌘,',
    keywords: ['settings', 'sources', 'usage', 'accounts', 'model providers', 'preferences'],
    icon: <GearIcon size={13} />
  }
]

type Item =
  | { readonly kind: 'session'; readonly s: SessionMeta }
  | { readonly kind: 'repo'; readonly r: RepoGroup }
  | { readonly kind: 'repo-setup'; readonly r: RepoGroup }
  | { readonly kind: 'view'; readonly v: ViewTarget }

type Group = { readonly label: string; readonly items: readonly Item[] }

const itemKey = (it: Item): string =>
  it.kind === 'session'
    ? it.s.id
    : it.kind === 'repo'
      ? `repo:${it.r.key}`
      : it.kind === 'repo-setup'
        ? `setup:${it.r.key}`
        : `view:${it.v.key}`

/** Result caps — the palette is a jump surface, the sidebar stays the exhaustive list. */
const SESSION_LIMIT_QUERY = 6
const SESSION_LIMIT_RECENT = 8
const REPO_LIMIT = 4

/**
 * ⌘K palette: one input that reaches any session, starts a session in any repo,
 * or opens any view. With an empty query it opens as a miniature of the board —
 * flying sessions first, livery dots and all — so the keyboard door shows the
 * same fleet the home view does. Deliberately not an action executor.
 */
export function CommandPalette({
  repos,
  onOpenSession,
  onNewSession,
  onRepoSetup,
  onGoto,
  onClose
}: {
  repos: RepoGroup[]
  onOpenSession: (s: SessionMeta) => void
  onNewSession: (repo: RepoGroup) => void
  onRepoSetup: (repoRoot: string) => void
  onGoto: (view: PaletteViewKey) => void
  onClose: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  // null = first fetch in flight — never flash an empty state before results land
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null)
  const [total, setTotal] = useState(0)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const busy = useBusyMap()
  const timeFormat = useTimeFormat()
  const baseId = useId()
  const listId = `${baseId}-list`
  const optId = (i: number): string => `${baseId}-opt-${i}`

  // focus lands in the input on open; whatever had focus gets it back on close
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null
    inputRef.current?.focus()
    return () => prev?.focus?.()
  }, [])

  // Escape closes from anywhere in the dialog. A document-level listener (the
  // ProjectFilter pattern) so App's window-level Escape handler never also fires;
  // App additionally ignores its shortcuts while the palette is open.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onCloseRef.current()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // 120ms, half the sidebar's 250: each keystroke fetches a page of 6, not a tree swap
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 120)
    return () => clearTimeout(t)
  }, [query])

  useEffect(() => {
    let dead = false
    void api
      .pageSessions(
        debounced
          ? { search: debounced, limit: SESSION_LIMIT_QUERY }
          : { limit: SESSION_LIMIT_RECENT }
      )
      .then((p) => {
        if (dead) return
        setSessions(p.items)
        setTotal(p.total)
      })
    return () => {
      dead = true
    }
  }, [debounced])

  const groups = useMemo((): readonly Group[] => {
    const got = sessions ?? []
    const q = debounced.toLowerCase()
    const out: Group[] = []
    if (q) {
      if (got.length > 0)
        out.push({ label: 'sessions', items: got.map((s) => ({ kind: 'session', s })) })
      const repoHits = repos
        .filter((r) => r.root && (r.fullName ?? r.name).toLowerCase().includes(q))
        .slice(0, REPO_LIMIT)
      if (repoHits.length > 0) {
        out.push({ label: 'start a session in', items: repoHits.map((r) => ({ kind: 'repo', r })) })
        // a repo's own agent setup is otherwise only reachable from its sidebar row
        out.push({
          label: 'agent setup for',
          items: repoHits.map((r) => ({ kind: 'repo-setup', r }))
        })
      }
      const viewHits = VIEWS.filter((v) =>
        [v.label, ...v.keywords].some((k) => k.toLowerCase().includes(q))
      )
      if (viewHits.length > 0)
        out.push({ label: 'go to', items: viewHits.map((v) => ({ kind: 'view', v })) })
    } else {
      // the board's ordering, in miniature: flying first, longest airborne on top
      const flying = got
        .filter((s) => busy.has(s.id))
        .sort((a, b) => (busy.get(a.id) ?? 0) - (busy.get(b.id) ?? 0))
      const ground = got.filter((s) => !busy.has(s.id))
      if (flying.length > 0)
        out.push({ label: 'flying now', items: flying.map((s) => ({ kind: 'session', s })) })
      if (ground.length > 0)
        out.push({ label: 'recent', items: ground.map((s) => ({ kind: 'session', s })) })
      out.push({ label: 'go to', items: VIEWS.map((v) => ({ kind: 'view', v })) })
    }
    return out
  }, [sessions, debounced, repos, busy])

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups])

  // new results reset the cursor — the top hit is the palette's promise
  const flatIds = flat.map(itemKey).join('\n')
  useEffect(() => setActive(0), [flatIds])

  useEffect(() => {
    document.getElementById(`${baseId}-opt-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [active, baseId])

  const pick = (it: Item): void => {
    onClose()
    if (it.kind === 'session') onOpenSession(it.s)
    else if (it.kind === 'repo') onNewSession(it.r)
    else if (it.kind === 'repo-setup') onRepoSetup(it.r.root as string)
    else onGoto(it.v.key)
  }

  const onInputKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, flat.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const it = flat[active]
      if (it) pick(it)
    } else if (e.key === 'Tab') {
      // single-field dialog: Tab has nowhere to go — close and restore focus
      e.preventDefault()
      onClose()
    }
  }

  const hiddenMatches = debounced && sessions !== null ? total - sessions.length : 0

  let idx = -1
  return (
    // the scrim is the click-away target; mousedown (not click) matches Select's
    // outside-dismiss, and the no-drag opt-out beats the 22px window drag strip
    <div
      className="palette-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label="Jump to">
        <input
          ref={inputRef}
          className="palette-input"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={flat.length > 0 ? optId(active) : undefined}
          aria-label="Jump to a session, repository, or view"
          placeholder="Jump to a session, repository, or view…"
          spellCheck={false}
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onInputKey}
        />
        <div className="palette-list" id={listId} role="listbox" aria-label="Results">
          {groups.map((g) => {
            const headId = `${baseId}-${g.label.replace(/\W+/g, '-')}`
            return (
              <div key={g.label} role="group" aria-labelledby={headId}>
                <div className="search-group" id={headId} role="presentation">
                  {g.label}
                </div>
                {g.items.map((it) => {
                  idx += 1
                  const i = idx
                  return (
                    <PaletteOption
                      key={itemKey(it)}
                      id={optId(i)}
                      it={it}
                      active={i === active}
                      flying={it.kind === 'session' && busy.has(it.s.id)}
                      showRepo={debounced !== ''}
                      timeFormat={timeFormat}
                      onHover={() => setActive(i)}
                      onPick={() => pick(it)}
                    />
                  )
                })}
              </div>
            )
          })}
          {sessions === null && flat.length === 0 && <div className="tree-empty">searching…</div>}
          {sessions !== null && flat.length === 0 && (
            <div className="tree-empty">
              nothing matches “{debounced}” — try a session, repository, or view name
            </div>
          )}
          {hiddenMatches > 0 && (
            <div className="tree-empty">
              {hiddenMatches} more — keep typing to narrow, or search the sidebar
            </div>
          )}
        </div>
        <div className="sr-only" role="status" aria-live="polite">
          {sessions === null ? '' : `${flat.length} results`}
        </div>
      </div>
    </div>
  )
}

function PaletteOption({
  id,
  it,
  active,
  flying,
  showRepo,
  timeFormat,
  onHover,
  onPick
}: {
  id: string
  it: Item
  active: boolean
  flying: boolean
  /** Query mode shows which repo a session belongs to; recent mode stays clean */
  showRepo: boolean
  timeFormat: TimeFormat
  onHover: () => void
  onPick: () => void
}): JSX.Element {
  const label =
    it.kind === 'session'
      ? `${PROVIDER_LABEL[it.s.provider]} session: ${it.s.title}`
      : it.kind === 'repo'
        ? `New session in ${it.r.fullName ?? it.r.name}`
        : it.kind === 'repo-setup'
          ? `Agent setup for ${it.r.fullName ?? it.r.name}`
          : it.v.label
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      aria-label={label}
      className={`palette-opt ${active ? 'active' : ''}`}
      onMouseEnter={onHover}
      onMouseDown={(e) => {
        // keep focus in the input until the palette closes itself
        e.preventDefault()
        onPick()
      }}
    >
      {it.kind === 'session' && (
        <>
          <span className={`plogo plogo-${it.s.provider}`}>
            <ProviderLogo p={it.s.provider} size={13} />
          </span>
          <span className="palette-title">{it.s.title}</span>
          {it.s.gitBranch && <BranchChip branch={it.s.gitBranch} />}
          {showRepo && it.s.repo && <span className="palette-hint">{it.s.repo.name}</span>}
          {flying ? (
            <LiveDot p={it.s.provider} />
          ) : (
            <time className="palette-meta" dateTime={new Date(it.s.updatedAt).toISOString()}>
              {fmtTime(it.s.updatedAt, timeFormat)}
            </time>
          )}
        </>
      )}
      {it.kind === 'repo' && (
        <>
          <span className="repo-icon">
            <RepoIcon size={13} />
          </span>
          <span className="palette-title">
            {it.r.fullName ? (
              <>
                <span className="repo-owner">{it.r.fullName.split('/')[0]}/</span>
                {it.r.fullName.split('/')[1]}
              </>
            ) : (
              it.r.name
            )}
          </span>
          <span className="palette-hint">new session</span>
        </>
      )}
      {it.kind === 'repo-setup' && (
        <>
          <span className="palette-view-icon">
            <SlidersIcon size={13} />
          </span>
          <span className="palette-title">
            {it.r.fullName ? (
              <>
                <span className="repo-owner">{it.r.fullName.split('/')[0]}/</span>
                {it.r.fullName.split('/')[1]}
              </>
            ) : (
              it.r.name
            )}
          </span>
          <span className="palette-hint">agent setup</span>
        </>
      )}
      {it.kind === 'view' && (
        <>
          <span className="palette-view-icon">{it.v.icon}</span>
          <span className="palette-title">{it.v.label}</span>
          {it.v.hint && <span className="palette-meta">{it.v.hint}</span>}
        </>
      )}
    </div>
  )
}
