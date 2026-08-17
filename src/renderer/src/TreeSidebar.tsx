import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type {
  AccountsSnapshot,
  PrStatus,
  Provider,
  RepoGroup,
  SessionMeta
} from '../../shared/types'
import { api } from './api'
import { useSessionBusy } from './busy'
import { fmtTime, useTimeFormat } from './time'
import {
  AgentIcon,
  ChatIcon,
  CockpitLogo,
  GearIcon,
  GraphIcon,
  LinkExternalIcon,
  LiveDot,
  OrgIcon,
  PrBadge,
  ProviderLogo,
  PROVIDER_LABEL,
  RepoIcon
} from './logos'

const PAGE = 20
/** Server-side page clamp — hide "more" past this. */
const MAX_LOADED = 1000

/** Live-index refetches must not churn row identity when nothing visible changed. */
function sameList(a: SessionMeta[], b: SessionMeta[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].id !== b[i].id ||
      a[i].updatedAt !== b[i].updatedAt ||
      a[i].title !== b[i].title ||
      a[i].archived !== b[i].archived
    )
      return false
  }
  return true
}

export function TreeSidebar({
  repos,
  indexVersion,
  accounts,
  zoom,
  onResetZoom,
  selectedId,
  onSelect,
  onNewSession,
  onGoHome,
  onOpenSettings,
  onOpenExtensions,
  onOpenProfile,
  onOpenUrl
}: {
  repos: RepoGroup[]
  indexVersion: number
  accounts: AccountsSnapshot | null
  zoom: number
  onResetZoom: () => void
  selectedId: string | null
  onSelect: (s: SessionMeta) => void
  onNewSession: (repo: RepoGroup) => void
  onGoHome: () => void
  onOpenSettings: () => void
  onOpenExtensions: () => void
  onOpenProfile: () => void
  onOpenUrl: (url: string) => void
}): JSX.Element {
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const autoExpanded = useRef(false)

  const visibleRepos = useMemo(() => repos.filter((r) => !r.hidden), [repos])
  // non-repo sessions get their own flat Chats section instead of a faux repo row
  const general = useMemo(
    () => visibleRepos.find((r) => r.key === 'general') ?? null,
    [visibleRepos]
  )
  const repoList = useMemo(() => visibleRepos.filter((r) => r.key !== 'general'), [visibleRepos])
  const [chatsOpen, setChatsOpen] = useState(true)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250)
    return () => clearTimeout(t)
  }, [search])

  // first repo starts expanded — once, so a later index update can't undo a collapse-all
  useEffect(() => {
    if (repoList.length > 0 && !autoExpanded.current) {
      autoExpanded.current = true
      setExpanded(new Set([repoList[0].key]))
    }
  }, [repoList])

  const toggle = (key: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  return (
    <aside className="tree-sidebar">
      <div className="tree-top">
        <button className="app-title" onClick={onGoHome} title="Mission control">
          <CockpitLogo size={18} /> Cockpit
        </button>
        {zoom !== 1 && (
          <button
            className="zoom-chip"
            title={`Zoomed to ${Math.round(zoom * 100)}% — click to reset to 100% (⌘0)`}
            onClick={onResetZoom}
          >
            {Math.round(zoom * 100)}%
          </button>
        )}

        <ProjectFilter repos={repos} />
        <button
          className="icon-btn"
          title="Agents — shared instructions, MCP servers, skills, plugins"
          onClick={onOpenExtensions}
          aria-label="Agents"
        >
          <AgentIcon size={16} />
        </button>
        <button
          className="icon-btn"
          title="Profile — your work across every agent"
          onClick={onOpenProfile}
          aria-label="Profile"
        >
          {/* GitHub's graph glyph: this is an activity view, not an account page */}
          <GraphIcon size={16} />
        </button>
        <button className="icon-btn" title="Settings" onClick={onOpenSettings} aria-label="Settings">
          <GearIcon size={16} />
        </button>
      </div>
      <input
        className="search"
        aria-label="Search sessions"
        placeholder="Search sessions…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div
        className="tree"
        role="tree"
        aria-label="Repositories and sessions"
        // roving focus: the tree is one Tab stop; rows are tabIndex -1 and arrows move
        // between them, so Tab never has to walk the whole session list
        tabIndex={0}
        onFocus={(e) => {
          if (e.target !== e.currentTarget) return
          const target =
            e.currentTarget.querySelector<HTMLElement>('[aria-selected="true"]') ??
            e.currentTarget.querySelector<HTMLElement>(
              '[role="treeitem"], .archived-toggle, .tree-more'
            )
          target?.focus()
        }}
        onKeyDown={(e) => {
          if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return
          const rows = Array.from(
            e.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"], .archived-toggle, .tree-more')
          )
          if (rows.length === 0) return
          const idx = rows.indexOf(document.activeElement as HTMLElement)
          e.preventDefault()
          if (e.key === 'ArrowDown') rows[Math.min(idx + 1, rows.length - 1)]?.focus()
          else if (e.key === 'ArrowUp') rows[Math.max(idx - 1, 0)]?.focus()
          else if (e.key === 'Home') rows[0]?.focus()
          else rows[rows.length - 1]?.focus()
        }}
      >
        {debounced ? (
          <SearchResults
            query={debounced}
            indexVersion={indexVersion}
            selectedId={selectedId}
            onSelect={onSelect}
          />
        ) : (
          repoList.map((r) => (
            <RepoNode
              key={r.key}
              repo={r}
              open={expanded.has(r.key)}
              indexVersion={indexVersion}
              accounts={accounts}
              selectedId={selectedId}
              onToggle={() => toggle(r.key)}
              onSelect={onSelect}
              onNewSession={onNewSession}
              onOpenUrl={onOpenUrl}
            />
          ))
        )}
        {!debounced && general && (
          <ChatsSection
            repo={general}
            open={chatsOpen}
            indexVersion={indexVersion}
            accounts={accounts}
            selectedId={selectedId}
            onToggle={() => setChatsOpen((v) => !v)}
            onSelect={onSelect}
          />
        )}
        {repos.length === 0 && (
          <div className="empty-item">
            <p>No sessions indexed yet — Cockpit reads Claude Code, Codex, and Copilot logs.</p>
            <button className="btn-ghost small" onClick={onOpenSettings}>
              Add source directories
            </button>
          </div>
        )}
        {repos.length > 0 && visibleRepos.length === 0 && !debounced && (
          <div className="empty-item">
            <p>All projects are hidden — the eye button above brings them back.</p>
          </div>
        )}
      </div>
      <footer className="sidebar-footer">
        {/* one compact identity bar: agent logos (accounts in the tooltip), GitHub
            login on the right; the whole row opens Settings for the full detail */}
        <button
          className="footer-ids"
          onClick={onOpenSettings}
          aria-label="Accounts — open settings"
          title={
            accounts === null
              ? 'loading accounts…'
              : [
                  ...accounts.accounts.map(
                    (a) =>
                      `${PROVIDER_LABEL[a.provider]} — ${a.identity ?? a.label}` +
                      (a.isDefault ? '' : ` (${a.label})`)
                  ),
                  accounts.githubUser
                    ? `GitHub (PRs) — @${accounts.githubUser}`
                    : 'GitHub: gh not signed in'
                ].join('\n')
          }
        >
          {accounts?.accounts.map((a) => (
            <span key={a.path} className={`plogo plogo-${a.provider}`}>
              <ProviderLogo p={a.provider} size={12} />
            </span>
          ))}
          {accounts?.githubUser ? (
            <span className="footer-gh">
              <OrgIcon size={11} /> @{accounts.githubUser}
            </span>
          ) : accounts !== null ? (
            <span className="footer-gh gh-missing">
              <OrgIcon size={11} /> gh: not signed in
            </span>
          ) : null}
        </button>
      </footer>
    </aside>
  )
}

/** Eye popover: every indexed project with a visibility checkbox (all on by default). */
function ProjectFilter({ repos }: { repos: RepoGroup[] }): JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const hiddenCount = repos.filter((r) => r.hidden).length

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
        className={`icon-btn ${hiddenCount > 0 ? 'filter-active' : ''}`}
        title={
          hiddenCount > 0
            ? `Choose projects to display — ${hiddenCount} hidden`
            : 'Choose projects to display'
        }
        aria-label="Choose projects to display"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
          <path d="M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.83.88 9.576.43 8.898a1.62 1.62 0 0 1 0-1.798c.45-.677 1.367-1.931 2.637-3.022C4.33 2.992 6.019 2 8 2ZM1.679 7.932a.12.12 0 0 0 0 .136c.411.622 1.241 1.75 2.366 2.717C5.176 11.758 6.527 12.5 8 12.5c1.473 0 2.825-.742 3.955-1.715 1.124-.967 1.954-2.096 2.366-2.717a.12.12 0 0 0 0-.136c-.412-.621-1.242-1.75-2.366-2.717C10.824 4.242 9.473 3.5 8 3.5c-1.473 0-2.825.742-3.955 1.715-1.124.967-1.954 2.096-2.366 2.717ZM8 10a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 10Z" />
        </svg>
        {hiddenCount > 0 && <span className="filter-dot" aria-hidden />}
      </button>
      {open && (
        <div className="repo-filter-pop" role="dialog" aria-label="Projects to display" ref={popRef}>
          <div className="repo-filter-head">Projects</div>
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
              <span className="repo-icon">
                <RepoIcon size={12} />
              </span>
              <span className="repo-filter-name">{r.fullName ?? r.name}</span>
              <span className="repo-count">{r.sessionCount + r.archivedCount}</span>
            </label>
          ))}
          {repos.length === 0 && <div className="tree-empty">no projects indexed</div>}
        </div>
      )}
    </div>
  )
}

function RepoNode({
  repo,
  open,
  indexVersion,
  accounts,
  selectedId,
  onToggle,
  onSelect,
  onNewSession,
  onOpenUrl
}: {
  repo: RepoGroup
  open: boolean
  indexVersion: number
  accounts: AccountsSnapshot | null
  selectedId: string | null
  onToggle: () => void
  onSelect: (s: SessionMeta) => void
  onNewSession: (repo: RepoGroup) => void
  onOpenUrl: (url: string) => void
}): JSX.Element {
  const [prs, setPrs] = useState<PrStatus[]>([])
  const [showArchived, setShowArchived] = useState(false)

  useEffect(() => {
    if (!open || !repo.root) return
    let dead = false
    void api.getPrs(repo.root).then((p) => !dead && setPrs(p))
    return () => {
      dead = true
    }
  }, [open, repo.root, indexVersion])

  return (
    <div className="repo-node" role="presentation">
      <div
        className="repo-row"
        role="treeitem"
        aria-expanded={open}
        aria-level={1}
        tabIndex={-1}
        title={repo.root ?? repo.fullName ?? repo.name}
        onClick={onToggle}
        onKeyDown={expandKeys(open, onToggle)}
      >
        <span className={`chev ${open ? 'open' : ''}`} aria-hidden="true">▸</span>
        <span className="repo-icon">
          <RepoIcon size={13} />
        </span>
        <span className="repo-name">
          {repo.fullName ? (
            <>
              <span className="repo-owner">{repo.fullName.split('/')[0]}/</span>
              {repo.fullName.split('/')[1]}
            </>
          ) : (
            repo.name
          )}
        </span>
        <ProviderStrip providers={repo.providers} />
        <span className="row-actions">
          {repo.fullName && (
            <button
              className="icon-btn small"
              title={`Open ${repo.fullName} on GitHub`}
              aria-label={`Open ${repo.fullName} on GitHub`}
              onClick={(e) => {
                e.stopPropagation()
                onOpenUrl(`https://github.com/${repo.fullName}`)
              }}
            >
              <LinkExternalIcon size={10} />
            </button>
          )}
          {repo.root && (
            <button
              className="icon-btn small"
              title={`New session in ${repo.name}`}
              aria-label={`New session in ${repo.name}`}
              onClick={(e) => {
                e.stopPropagation()
                onNewSession(repo)
              }}
            >
              +
            </button>
          )}
        </span>
        <span className="repo-count">{repo.sessionCount}</span>
      </div>
      {open && (
        <GroupChildren
          repo={repo}
          prs={prs}
          indexVersion={indexVersion}
          accounts={accounts}
          selectedId={selectedId}
          showArchived={showArchived}
          onToggleArchived={() => setShowArchived((v) => !v)}
          onSelect={onSelect}
          onOpenUrl={onOpenUrl}
        />
      )}
    </div>
  )
}

/** Stable identities: new [] / () => {} each render would re-trigger memoized children. */
const NO_PRS: PrStatus[] = []
const noop = (): void => {}

/** Enter/Space toggles; ArrowRight/ArrowLeft expand and collapse (WAI-ARIA tree pattern). */
function expandKeys(open: boolean, onToggle: () => void) {
  return (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onToggle()
    } else if (e.key === 'ArrowRight' && !open) onToggle()
    else if (e.key === 'ArrowLeft' && open) onToggle()
  }
}

function ProviderStrip({ providers }: { providers: readonly Provider[] }): JSX.Element {
  return (
    <span className="repo-providers">
      {providers.map((p) => (
        <span key={p} className={`plogo plogo-${p}`} title={PROVIDER_LABEL[p]}>
          <ProviderLogo p={p} size={10} />
        </span>
      ))}
    </span>
  )
}

type GroupChildrenProps = {
  readonly repo: RepoGroup
  readonly prs: PrStatus[]
  readonly indexVersion: number
  readonly accounts: AccountsSnapshot | null
  readonly selectedId: string | null
  readonly showArchived: boolean
  readonly onToggleArchived: () => void
  readonly onSelect: (s: SessionMeta) => void
  readonly onOpenUrl: (url: string) => void
}

/**
 * The expanded body of a tree group: its sessions, plus an archived sub-list behind
 * a toggle. Shared by both group kinds on purpose — when this was written twice, an
 * a11y or paging fix could land in one copy and silently skip the other.
 */
function GroupChildren({
  repo,
  prs,
  indexVersion,
  accounts,
  selectedId,
  showArchived,
  onToggleArchived,
  onSelect,
  onOpenUrl
}: GroupChildrenProps): JSX.Element {
  const list = (archived: boolean): JSX.Element => (
    <SessionList
      repoKey={repo.key}
      archived={archived}
      prs={prs}
      indexVersion={indexVersion}
      accounts={accounts}
      selectedId={selectedId}
      onSelect={onSelect}
      onOpenUrl={onOpenUrl}
    />
  )
  return (
    <div className="repo-children" role="group">
      {list(false)}
      {repo.archivedCount > 0 && (
        <>
          <button
            className="archived-toggle"
            aria-expanded={showArchived}
            tabIndex={-1}
            onClick={onToggleArchived}
          >
            <span className={`chev ${showArchived ? 'open' : ''}`} aria-hidden="true">▸</span>
            Archived ({repo.archivedCount})
          </button>
          {showArchived && list(true)}
        </>
      )}
    </div>
  )
}

/** Sessions with no repo: one flat section — a Chats header with the sessions right under it. */
function ChatsSection({
  repo,
  open,
  indexVersion,
  accounts,
  selectedId,
  onToggle,
  onSelect
}: {
  repo: RepoGroup
  open: boolean
  indexVersion: number
  accounts: AccountsSnapshot | null
  selectedId: string | null
  onToggle: () => void
  onSelect: (s: SessionMeta) => void
}): JSX.Element {
  const [showArchived, setShowArchived] = useState(false)

  return (
    <div className="chats-section" role="presentation">
      <div
        className="section-row"
        role="treeitem"
        aria-expanded={open}
        aria-level={1}
        tabIndex={-1}
        title="Chats without a repository"
        onClick={onToggle}
        onKeyDown={expandKeys(open, onToggle)}
      >
        <span className={`chev ${open ? 'open' : ''}`} aria-hidden="true">▸</span>
        <span className="section-icon">
          <ChatIcon size={12} />
        </span>
        <span className="section-name">Chats</span>
        <ProviderStrip providers={repo.providers} />
        <span className="repo-count">{repo.sessionCount}</span>
      </div>
      {open && (
        // no repo means no PRs and nothing to open on GitHub
        <GroupChildren
          repo={repo}
          prs={NO_PRS}
          indexVersion={indexVersion}
          accounts={accounts}
          selectedId={selectedId}
          showArchived={showArchived}
          onToggleArchived={() => setShowArchived((v) => !v)}
          onSelect={onSelect}
          onOpenUrl={noop}
        />
      )}
    </div>
  )
}

function SessionList({
  repoKey,
  archived,
  prs,
  indexVersion,
  accounts,
  selectedId,
  onSelect,
  onOpenUrl
}: {
  repoKey: string
  archived: boolean
  prs: PrStatus[]
  indexVersion: number
  accounts: AccountsSnapshot | null
  selectedId: string | null
  onSelect: (s: SessionMeta) => void
  onOpenUrl: (url: string) => void
}): JSX.Element {
  const [pages, setPages] = useState(1)
  // null = first page still loading — "no sessions" must never flash during the fetch
  const [items, setItems] = useState<SessionMeta[] | null>(null)
  const [total, setTotal] = useState(0)

  useEffect(() => {
    let dead = false
    void api
      .pageSessions({ repoKey, archived, offset: 0, limit: Math.min(PAGE * pages, MAX_LOADED) })
      .then((p) => {
        if (dead) return
        setTotal(p.total)
        // keep row identity stable across live-index refetches when nothing changed
        setItems((prev) => (prev && sameList(prev, p.items) ? prev : p.items))
      })
    return () => {
      dead = true
    }
  }, [repoKey, archived, pages, indexVersion])

  if (items === null) return <div className="tree-empty">loading…</div>

  return (
    <>
      {items.map((s) => (
        <SessionRow
          key={s.id}
          s={s}
          pr={s.gitBranch ? prs.find((p) => p.headRefName === s.gitBranch) : undefined}
          accounts={accounts}
          selected={selectedId === s.id}
          onSelect={onSelect}
          onOpenUrl={onOpenUrl}
        />
      ))}
      {/* an active list only comes up empty when every session is archived —
          the Archived toggle right below is the way back in */}
      {items.length === 0 && <div className="tree-empty">no active sessions</div>}
      {items.length < total && items.length < MAX_LOADED && (
        <button className="tree-more" tabIndex={-1} onClick={() => setPages((p) => p + 1)}>
          more… ({items.length}/{total})
        </button>
      )}
    </>
  )
}

function SessionRow({
  s,
  pr,
  accounts,
  selected,
  level = 2,
  onSelect,
  onOpenUrl
}: {
  s: SessionMeta
  pr?: PrStatus
  accounts?: AccountsSnapshot | null
  selected: boolean
  /** 2 under a repo/section row, 1 in flat search results */
  level?: number
  onSelect: (s: SessionMeta) => void
  onOpenUrl: (url: string) => void
}): JSX.Element {
  const timeFormat = useTimeFormat()
  // the live dot takes the row's exclusive meta slot: running beats PR beats time
  const working = useSessionBusy(s.id)
  const acct = accounts?.accounts.find((a) => a.provider === s.provider && a.label === s.source)
  const multiAccount =
    (accounts?.accounts.filter((a) => a.provider === s.provider).length ?? 0) > 1
  return (
    <div
      className={`session-row ${selected ? 'selected' : ''} ${s.archived ? 'archived' : ''}`}
      role="treeitem"
      aria-selected={selected}
      aria-level={level}
      tabIndex={-1}
      title={`${PROVIDER_LABEL[s.provider]}${acct ? ` — ${acct.identity ?? acct.label}` : ''}\n${s.title}${s.gitBranch ? `\n⎇ ${s.gitBranch}` : ''}\n~${s.messageCount} messages`}
      onClick={() => onSelect(s)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(s)
        }
      }}
    >
      <span className={`plogo plogo-${s.provider}`} title={PROVIDER_LABEL[s.provider]}>
        <ProviderLogo p={s.provider} size={13} />
      </span>
      <span className="session-title">{s.title}</span>
      {/* archived reads as strikethrough + dim visually — say it out loud too.
          sr-only is position:absolute, so it costs no row width or gap */}
      {s.archived && <span className="sr-only">(archived)</span>}
      {multiAccount && acct && <span className="acct-chip">{acct.label}</span>}
      <span className="row-actions">
        <button
          className="icon-btn small"
          title={s.archived ? 'Unarchive' : 'Archive'}
          aria-label={s.archived ? 'Unarchive session' : 'Archive session'}
          onClick={(e) => {
            e.stopPropagation()
            void api.setArchived(s.id, !s.archived)
          }}
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v1.5A1.75 1.75 0 0 1 14.25 6H1.75A1.75 1.75 0 0 1 0 4.25ZM1.75 7a.25.25 0 0 0-.25.25v5.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25Zm4.5 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.75.75 0 0 1 0-1.5Z" />
          </svg>
        </button>
      </span>
      {working ? (
        <LiveDot p={s.provider} />
      ) : pr ? (
        <PrBadge pr={pr} onOpen={onOpenUrl} compact />
      ) : (
        <time dateTime={new Date(s.updatedAt).toISOString()}>{fmtTime(s.updatedAt, timeFormat)}</time>
      )}
    </div>
  )
}

function SearchResults({
  query,
  indexVersion,
  selectedId,
  onSelect
}: {
  query: string
  indexVersion: number
  selectedId: string | null
  onSelect: (s: SessionMeta) => void
}): JSX.Element {
  // null = search in flight — don't flash "no matches" while waiting
  const [items, setItems] = useState<SessionMeta[] | null>(null)
  const [total, setTotal] = useState(0)

  useEffect(() => {
    let dead = false
    void api.pageSessions({ search: query, limit: 100 }).then((p) => {
      if (dead) return
      setItems(p.items)
      setTotal(p.total)
    })
    return () => {
      dead = true
    }
  }, [query, indexVersion])

  if (items === null) return <div className="tree-empty">searching…</div>

  const groups = new Map<string, SessionMeta[]>()
  for (const s of items) {
    const k = s.repo?.name ?? 'Chats'
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(s)
  }

  return (
    <>
      {[...groups.entries()].map(([name, list]) => (
        <div key={name} className="repo-node" role="group" aria-label={name}>
          <div className="search-group" aria-hidden="true">{name}</div>
          {list.map((s) => (
            <SessionRow
              key={s.id}
              s={s}
              selected={selectedId === s.id}
              level={1}
              onSelect={onSelect}
              onOpenUrl={() => {}}
            />
          ))}
        </div>
      ))}
      {items.length === 0 && <div className="tree-empty">no sessions match “{query}”</div>}
      {total > items.length && <div className="tree-empty">{total - items.length} more — refine your search</div>}
    </>
  )
}
