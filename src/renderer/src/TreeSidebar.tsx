import { useEffect, useMemo, useRef, useState } from 'react'
import type { AccountsSnapshot, PrStatus, RepoGroup, SessionMeta } from '../../shared/types'
import { api } from './api'
import {
  CockpitLogo,
  LinkExternalIcon,
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

function fmtTime(ms: number): string {
  const d = new Date(ms)
  const today = new Date().toDateString() === d.toDateString()
  return today
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

interface OrgGroup {
  /** GitHub owner login, or the pseudo-owners 'Local' / 'General' */
  owner: string
  kind: 'github' | 'local' | 'general'
  repos: RepoGroup[]
  lastActivity: number
}

function groupByOwner(repos: RepoGroup[]): OrgGroup[] {
  const m = new Map<string, OrgGroup>()
  for (const r of repos) {
    const kind = r.key === 'general' ? 'general' : r.fullName ? 'github' : 'local'
    const owner = kind === 'github' ? r.fullName!.split('/')[0] : kind === 'local' ? 'Local' : 'General'
    let g = m.get(`${kind}:${owner}`)
    if (!g) {
      g = { owner, kind, repos: [], lastActivity: 0 }
      m.set(`${kind}:${owner}`, g)
    }
    g.repos.push(r)
    if (r.lastActivity > g.lastActivity) g.lastActivity = r.lastActivity
  }
  const rank = { github: 0, local: 1, general: 2 } as const
  return [...m.values()].sort(
    (a, b) => rank[a.kind] - rank[b.kind] || b.lastActivity - a.lastActivity
  )
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
  onOpenUrl: (url: string) => void
}): JSX.Element {
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [collapsedOrgs, setCollapsedOrgs] = useState<Set<string>>(new Set())
  const autoExpanded = useRef(false)

  const visibleRepos = useMemo(() => repos.filter((r) => !r.hidden), [repos])
  const orgs = useMemo(() => groupByOwner(visibleRepos), [visibleRepos])

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250)
    return () => clearTimeout(t)
  }, [search])

  // first repo starts expanded — once, so a later index update can't undo a collapse-all
  useEffect(() => {
    if (visibleRepos.length > 0 && !autoExpanded.current) {
      autoExpanded.current = true
      setExpanded(new Set([visibleRepos[0].key]))
    }
  }, [visibleRepos])

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
          title="AI Setup — shared instructions, MCP servers, skills, plugins"
          onClick={onOpenExtensions}
          aria-label="AI Setup"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M6.5 1.75V4H4a2 2 0 0 0-2 2v2.5h2.25a1.75 1.75 0 1 1 0 3.5H2V14a2 2 0 0 0 2 2h2.5v-2.25a1.75 1.75 0 1 1 3.5 0V16H12a2 2 0 0 0 2-2v-2.5h1.25a1.75 1.75 0 1 0 0-3.5H14V6a2 2 0 0 0-2-2H9.5V1.75a1.75 1.75 0 1 0-3 0Z" opacity="0.9" />
          </svg>
        </button>
        <button className="icon-btn" title="Settings" onClick={onOpenSettings} aria-label="Settings">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0a8.2 8.2 0 0 1 .701.031C9.444.095 9.99.645 10.16 1.29l.288 1.107c.018.066.079.158.212.224.231.114.454.243.668.386.123.082.233.09.299.071l1.103-.303c.644-.176 1.392.021 1.82.63.27.385.506.792.704 1.218.315.675.111 1.422-.364 1.891l-.814.806c-.049.048-.098.147-.088.294a6.214 6.214 0 0 1 0 .772c-.01.147.038.246.088.294l.814.806c.475.469.679 1.216.364 1.891a7.977 7.977 0 0 1-.704 1.217c-.428.61-1.176.807-1.82.63l-1.102-.302c-.067-.019-.177-.011-.3.071a5.909 5.909 0 0 1-.668.386c-.133.066-.194.158-.211.224l-.29 1.106c-.168.646-.715 1.196-1.458 1.26a8.006 8.006 0 0 1-1.402 0c-.743-.064-1.289-.614-1.458-1.26l-.289-1.106c-.018-.066-.079-.158-.212-.224a5.738 5.738 0 0 1-.668-.386c-.123-.082-.233-.09-.299-.071l-1.103.303c-.644.176-1.392-.021-1.82-.63a8.12 8.12 0 0 1-.704-1.218c-.315-.675-.111-1.422.363-1.891l.815-.806c.05-.048.098-.147.088-.294a6.214 6.214 0 0 1 0-.772c.01-.147-.038-.246-.088-.294l-.815-.806C.635 6.045.431 5.298.746 4.623a7.92 7.92 0 0 1 .704-1.217c.428-.61 1.176-.807 1.82-.63l1.102.302c.067.019.177.011.3-.071.214-.143.437-.272.668-.386.133-.066.194-.158.211-.224l.29-1.106C6.009.645 6.556.095 7.299.03 7.53.01 7.764 0 8 0Zm-.571 1.525c-.036.003-.108.036-.137.146l-.289 1.105c-.147.561-.549.967-.998 1.189-.173.086-.34.183-.5.29-.417.278-.97.423-1.529.27l-1.103-.303c-.109-.03-.175.016-.195.045-.22.312-.412.644-.573.99-.014.031-.021.11.059.19l.815.806c.411.406.562.957.53 1.456a4.709 4.709 0 0 0 0 .582c.032.499-.119 1.05-.53 1.456l-.815.806c-.081.08-.073.159-.059.19.162.346.353.677.573.989.02.03.085.076.195.046l1.102-.303c.56-.153 1.113-.008 1.53.27.161.107.328.204.501.29.447.222.85.629.997 1.189l.289 1.105c.029.109.101.143.137.146a6.6 6.6 0 0 0 1.142 0c.036-.003.108-.036.137-.146l.289-1.105c.147-.561.549-.967.998-1.189.173-.086.34-.183.5-.29.417-.278.97-.423 1.529-.27l1.103.303c.109.029.175-.016.195-.045.22-.313.411-.644.573-.99.014-.031.021-.11-.059-.19l-.815-.806c-.411-.406-.562-.957-.53-1.456a4.709 4.709 0 0 0 0-.582c-.032-.499.119-1.05.53-1.456l.815-.806c.081-.08.073-.159.059-.19a6.464 6.464 0 0 0-.573-.989c-.02-.03-.085-.076-.195-.046l-1.102.303c-.56.153-1.113.008-1.53-.27a4.44 4.44 0 0 0-.501-.29c-.447-.222-.85-.629-.997-1.189l-.289-1.105c-.029-.11-.101-.143-.137-.146a6.6 6.6 0 0 0-1.142 0ZM11 8a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM9.5 8a1.5 1.5 0 1 0-3.001.001A1.5 1.5 0 0 0 9.5 8Z" />
          </svg>
        </button>
      </div>
      <input
        className="search"
        aria-label="Search sessions"
        placeholder="Search sessions…   ⌘K"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div
        className="tree"
        role="tree"
        aria-label="Repositories and sessions"
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
          orgs.map((org) => {
            const orgKey = `${org.kind}:${org.owner}`
            const open = !collapsedOrgs.has(orgKey)
            return (
              <div key={orgKey} className="org-node" role="presentation">
                <div
                  className="org-row"
                  role="treeitem"
                  aria-expanded={open}
                  tabIndex={0}
                  onClick={() =>
                    setCollapsedOrgs((prev) => {
                      const next = new Set(prev)
                      if (next.has(orgKey)) next.delete(orgKey)
                      else next.add(orgKey)
                      return next
                    })
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      ;(e.currentTarget as HTMLElement).click()
                    }
                  }}
                >
                  <span className={`chev ${open ? 'open' : ''}`}>▸</span>
                  <span className="org-icon">
                    <OrgIcon size={12} />
                  </span>
                  <span className="org-name">{org.owner}</span>
                  {org.kind === 'github' && (
                    <span className="row-actions">
                      <button
                        className="icon-btn small"
                        title={`Open ${org.owner} on GitHub`}
                        aria-label={`Open ${org.owner} on GitHub`}
                        onClick={(e) => {
                          e.stopPropagation()
                          onOpenUrl(`https://github.com/${org.owner}`)
                        }}
                      >
                        <LinkExternalIcon size={10} />
                      </button>
                    </span>
                  )}
                  <span className="repo-count">{org.repos.length}</span>
                </div>
                {open &&
                  org.repos.map((r) => (
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
                  ))}
              </div>
            )
          })
        )}
        {repos.length === 0 && (
          <div className="empty-item">
            <p>No sessions indexed yet.</p>
            <button className="btn-ghost small" onClick={onOpenSettings}>
              Configure sources
            </button>
          </div>
        )}
        {repos.length > 0 && visibleRepos.length === 0 && !debounced && (
          <div className="empty-item">
            <p>All projects are hidden.</p>
          </div>
        )}
      </div>
      <footer className="sidebar-footer">
        {accounts?.accounts.map((a) => (
          <div
            key={a.path}
            className="footer-acct"
            title={`${PROVIDER_LABEL[a.provider]} — ${a.identity ?? a.label}\n${a.path}`}
          >
            <span className={`plogo plogo-${a.provider}`}>
              <ProviderLogo p={a.provider} size={11} />
            </span>
            <span className="acct-id">{a.identity ?? a.label}</span>
            {!a.isDefault && <span className="acct-chip">{a.label}</span>}
          </div>
        ))}
        <div className="footer-acct" title="GitHub identity used for PRs (gh CLI)">
          <OrgIcon size={11} />
          {accounts?.githubUser ? (
            <span className="acct-id">@{accounts.githubUser}</span>
          ) : (
            <span className="acct-id gh-missing">gh: not signed in</span>
          )}
        </div>
      </footer>
    </aside>
  )
}

/** Eye popover: every indexed project with a visibility checkbox (all on by default). */
function ProjectFilter({ repos }: { repos: RepoGroup[] }): JSX.Element {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const hiddenCount = repos.filter((r) => r.hidden).length

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
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
        className={`icon-btn ${hiddenCount > 0 ? 'filter-active' : ''}`}
        title={
          hiddenCount > 0
            ? `Choose projects to display — ${hiddenCount} hidden`
            : 'Choose projects to display'
        }
        aria-label="Choose projects to display"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
          <path d="M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.83.88 9.576.43 8.898a1.62 1.62 0 0 1 0-1.798c.45-.677 1.367-1.931 2.637-3.022C4.33 2.992 6.019 2 8 2ZM1.679 7.932a.12.12 0 0 0 0 .136c.411.622 1.241 1.75 2.366 2.717C5.176 11.758 6.527 12.5 8 12.5c1.473 0 2.825-.742 3.955-1.715 1.124-.967 1.954-2.096 2.366-2.717a.12.12 0 0 0 0-.136c-.412-.621-1.242-1.75-2.366-2.717C10.824 4.242 9.473 3.5 8 3.5c-1.473 0-2.825.742-3.955 1.715-1.124.967-1.954 2.096-2.366 2.717ZM8 10a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 10Z" />
        </svg>
        {hiddenCount > 0 && <span className="filter-dot" aria-hidden />}
      </button>
      {open && (
        <div className="repo-filter-pop" role="dialog" aria-label="Projects to display">
          <div className="repo-filter-head">Projects</div>
          {repos.map((r) => (
            <label key={r.key} className="repo-filter-row" title={r.fullName ?? r.root ?? r.name}>
              <input
                type="checkbox"
                checked={!r.hidden}
                onChange={() => void api.setRepoHidden(r.key, !r.hidden)}
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
        tabIndex={0}
        title={repo.fullName ?? repo.root ?? repo.name}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          } else if (e.key === 'ArrowRight' && !open) onToggle()
          else if (e.key === 'ArrowLeft' && open) onToggle()
        }}
      >
        <span className={`chev ${open ? 'open' : ''}`}>▸</span>
        <span className="repo-icon">
          <RepoIcon size={13} />
        </span>
        <span className="repo-name">{repo.name}</span>
        <span className="repo-providers">
          {repo.providers.map((p) => (
            <span key={p} className={`plogo plogo-${p}`} title={PROVIDER_LABEL[p]}>
              <ProviderLogo p={p} size={9} />
            </span>
          ))}
        </span>
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
        <div className="repo-children" role="group">
          <SessionList
            repoKey={repo.key}
            archived={false}
            prs={prs}
            indexVersion={indexVersion}
            accounts={accounts}
            selectedId={selectedId}
            onSelect={onSelect}
            onOpenUrl={onOpenUrl}
          />
          {repo.archivedCount > 0 && (
            <>
              <button className="archived-toggle" onClick={() => setShowArchived((v) => !v)}>
                <span className={`chev ${showArchived ? 'open' : ''}`}>▸</span>
                Archived ({repo.archivedCount})
              </button>
              {showArchived && (
                <SessionList
                  repoKey={repo.key}
                  archived
                  prs={prs}
                  indexVersion={indexVersion}
                  accounts={accounts}
                  selectedId={selectedId}
                  onSelect={onSelect}
                  onOpenUrl={onOpenUrl}
                />
              )}
            </>
          )}
        </div>
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
  const [items, setItems] = useState<SessionMeta[]>([])
  const [total, setTotal] = useState(0)

  useEffect(() => {
    let dead = false
    void api
      .pageSessions({ repoKey, archived, offset: 0, limit: Math.min(PAGE * pages, MAX_LOADED) })
      .then((p) => {
        if (dead) return
        setTotal(p.total)
        // keep row identity stable across live-index refetches when nothing changed
        setItems((prev) => (sameList(prev, p.items) ? prev : p.items))
      })
    return () => {
      dead = true
    }
  }, [repoKey, archived, pages, indexVersion])

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
      {items.length === 0 && <div className="tree-empty">no sessions</div>}
      {items.length < total && items.length < MAX_LOADED && (
        <button className="tree-more" onClick={() => setPages((p) => p + 1)}>
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
  onSelect,
  onOpenUrl
}: {
  s: SessionMeta
  pr?: PrStatus
  accounts?: AccountsSnapshot | null
  selected: boolean
  onSelect: (s: SessionMeta) => void
  onOpenUrl: (url: string) => void
}): JSX.Element {
  const acct = accounts?.accounts.find((a) => a.provider === s.provider && a.label === s.source)
  const multiAccount =
    (accounts?.accounts.filter((a) => a.provider === s.provider).length ?? 0) > 1
  return (
    <div
      className={`session-row ${selected ? 'selected' : ''} ${s.archived ? 'archived' : ''}`}
      role="treeitem"
      aria-selected={selected}
      tabIndex={0}
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
        <ProviderLogo p={s.provider} size={11} />
      </span>
      <span className="session-title">{s.title}</span>
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
          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor">
            <path d="M0 2.75C0 1.784.784 1 1.75 1h12.5c.966 0 1.75.784 1.75 1.75v1.5A1.75 1.75 0 0 1 14.25 6H1.75A1.75 1.75 0 0 1 0 4.25ZM1.75 7a.25.25 0 0 0-.25.25v5.5c0 .138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25Zm4.5 2h3.5a.75.75 0 0 1 0 1.5h-3.5a.75.75 0 0 1 0-1.5Z" />
          </svg>
        </button>
      </span>
      {pr ? (
        <PrBadge pr={pr} onOpen={onOpenUrl} compact />
      ) : (
        <time>{fmtTime(s.updatedAt)}</time>
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
  const [items, setItems] = useState<SessionMeta[]>([])
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

  const groups = new Map<string, SessionMeta[]>()
  for (const s of items) {
    const k = s.repo?.name ?? 'General'
    if (!groups.has(k)) groups.set(k, [])
    groups.get(k)!.push(s)
  }

  return (
    <>
      {[...groups.entries()].map(([name, list]) => (
        <div key={name} className="repo-node" role="presentation">
          <div className="search-group">{name}</div>
          {list.map((s) => (
            <SessionRow key={s.id} s={s} selected={selectedId === s.id} onSelect={onSelect} onOpenUrl={() => {}} />
          ))}
        </div>
      ))}
      {items.length === 0 && <div className="tree-empty">no matches</div>}
      {total > items.length && <div className="tree-empty">{total - items.length} more — refine your search</div>}
    </>
  )
}
