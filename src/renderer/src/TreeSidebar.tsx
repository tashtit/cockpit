import { memo, useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type {
  AccountsSnapshot,
  PrStatus,
  RepoGroup,
  RoundtableMeta,
  SessionHolder,
  SessionMeta,
  SessionProvider
} from '../../shared/types'
import { cleanupCounts, cleanupHeadline } from '../../shared/cleanup'
import { isAlphabetical, moveRepo, orderRepos } from '../../shared/repo-order'
import { api } from './api'
import { useCleanupNotice } from './use-cleanup-notice'
import { setHolderFilter, useHolderFilter } from './hold'
import { showAllAgents, shownProviders, shownSessions, useHiddenAgents } from './agent-filter'
import { ProjectFilter } from './ProjectFilter'
import { RailResizer } from './RailResizer'
import { RoundtableNode } from './RoundtableNode'
import { noop, SessionList, SessionRow } from './SessionList'
import type { SettingsSection } from './Settings'
import { UpdateBar } from './UpdateBar'
import { UsageMeters } from './UsageMeters'
import { useLoaded } from './use-loaded'
import { useRoundtables } from './use-roundtables'
import {
  AgentIcon,
  ChatIcon,
  CockpitLogo,
  ComposeIcon,
  GearIcon,
  GraphIcon,
  HeldIcon,
  LinkExternalIcon,
  OrgIcon,
  ProcessIcon,
  ProviderMark,
  PROVIDER_LABEL,
  RepoIcon,
  SlidersIcon,
  TrashIcon
} from './logos'
import { RepoName } from './RepoName'
import { roveIndex, type RoveKeys } from './roving'

/** The tree's arrows: a row at a time, stopping at either end; Home and End jump */
const TREE_KEYS: RoveKeys = { next: 'ArrowDown', prev: 'ArrowUp', ends: true }

export function TreeSidebar({
  repos,
  indexVersion,
  accounts,
  zoom,
  onResetZoom,
  selectedId,
  onSelect,
  onNewSession,
  onRepoSetup,
  selectedRoundtableId,
  onOpenRoundtable,
  onNewTask,
  onGoHome,
  onNav,
  onOpenSettings,
  onOpenUrl,
  activeView
}: {
  repos: RepoGroup[]
  indexVersion: number
  accounts: AccountsSnapshot | null
  zoom: number
  onResetZoom: () => void
  selectedId: string | null
  onSelect: (s: SessionMeta) => void
  onNewSession: (repo: RepoGroup) => void
  onRepoSetup: (repoRoot: string) => void
  /** Roundtable currently open in the main pane, for the section's selection state */
  selectedRoundtableId: string | null
  onOpenRoundtable: (id: string) => void
  /** The always-visible entry point: home composer, focused (same as ⌘N) */
  onNewTask: () => void
  onGoHome: () => void
  /** Nav trio (toggles: re-clicking the active view backs out of it) */
  onNav: (view: 'settings' | 'extensions' | 'profile' | 'cleanup') => void
  /** Open-only Settings (empty-state button, footer) — never toggles closed;
   *  the footer's usage meters ask for the usage section */
  onOpenSettings: (section?: SettingsSection) => void
  onOpenUrl: (url: string) => void
  /** App's current view kind — lights the matching nav icon (aria-current) */
  activeView: string
}): JSX.Element {
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const autoExpanded = useRef(false)
  // the daily cleanup check's reminder, until Cleanup is opened — in words for the
  // name and the tooltip, since the dot alone would be colour carrying state
  const cleanup = useCleanupNotice()
  const cleanupNote =
    cleanup && activeView !== 'cleanup'
      ? `Cleanup ${cleanupHeadline(cleanup)} — ${cleanupCounts(cleanup)}`
      : null

  // projects arrive in main's order (A→Z or the user's drag order, never by activity);
  // a drop reorders here at once and main's answer replaces it on the next index push
  const [pendingOrder, setPendingOrder] = useState<readonly string[] | null>(null)
  useEffect(() => setPendingOrder(null), [repos])
  const orderedRepos = useMemo(
    () => (pendingOrder ? orderRepos(repos, pendingOrder) : repos),
    [repos, pendingOrder]
  )
  const visibleRepos = useMemo(() => orderedRepos.filter((r) => !r.hidden), [orderedRepos])
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ target: string; place: 'before' | 'after' } | null>(null)
  const [orderNote, setOrderNote] = useState('')

  /** Every project's key is saved — hidden ones too — so each stays where it was left. */
  const saveOrder = (keys: string[]): void => {
    setPendingOrder(keys)
    void api.setRepoOrder(keys)
  }
  const moveTo = (key: string, to: { target: string; place: 'before' | 'after' }): void => {
    const all = orderedRepos.filter((r) => r.key !== 'general').map((r) => r.key)
    const next = moveRepo(all, key, to)
    if (next.some((k, i) => k !== all[i])) saveOrder(next)
  }
  /** ⌥↑/⌥↓ — the keyboard's drag: one visible slot at a time */
  const nudge = (key: string, delta: -1 | 1): void => {
    const i = repoList.findIndex((r) => r.key === key)
    const target = repoList[i + delta]
    if (i < 0 || !target) return
    moveTo(key, { target: target.key, place: delta < 0 ? 'before' : 'after' })
    const r = repoList[i]
    setOrderNote(`${r.fullName ?? r.name} moved to position ${i + delta + 1} of ${repoList.length}`)
  }
  const resetOrder = (): void => {
    saveOrder([])
    setOrderNote('Projects sorted A to Z')
  }
  const projects = useMemo(() => orderedRepos.filter((r) => r.key !== 'general'), [orderedRepos])
  const customOrder = !isAlphabetical(projects)
  const [chatsOpen, setChatsOpen] = useState(true)

  // roundtables are tree items like sessions: grounded ones sit under their project,
  // repo-less ones under Chats — never a category of their own
  const tables = useRoundtables(indexVersion)
  // narrowed to who drives the sessions: a project with none of that kind leaves the
  // tree while the filter is on (its tables are Cockpit's, so they count as held)
  const holder = useHolderFilter()
  // and to the agents it shows: a project with no session of a shown agent leaves too
  const hidden = useHiddenAgents()
  const filtered = holder !== null || hidden.length > 0
  const repoList = useMemo(
    () =>
      visibleRepos.filter(
        (r) =>
          r.key !== 'general' &&
          (!filtered ||
            shownSessions(r, { holder, hidden }) > 0 ||
            (holder === 'cockpit' && r.root !== null && tables.some((t) => t.repoRoot === r.root)))
      ),
    [visibleRepos, holder, hidden, filtered, tables]
  )
  const chatTables = useMemo(() => tables.filter((t) => t.repoRoot === null), [tables])
  // each project's own tables, one array per project and the same one until the list
  // changes — a filter per row per render handed every memoized project a new prop
  const repoTables = useMemo(() => {
    const byRoot = new Map<string, RoundtableMeta[]>()
    for (const t of tables) if (t.repoRoot !== null) byRoot.set(t.repoRoot, [...(byRoot.get(t.repoRoot) ?? []), t])
    return byRoot
  }, [tables])

  // non-repo sessions get their own flat Chats section instead of a faux repo row;
  // a repo-less roundtable needs that section even when no plain chats exist yet
  const general = useMemo((): RepoGroup | null => {
    // a table is Cockpit's own work: out of the tree while it shows only the agents'
    const tablesShown = holder === 'agent' ? 0 : chatTables.length
    const real = visibleRepos.find((r) => r.key === 'general')
    if (real && (!filtered || shownSessions(real, { holder, hidden }) > 0 || tablesShown > 0)) return real
    if (tablesShown === 0) return null
    return {
      key: 'general',
      name: 'general',
      fullName: null,
      root: null,
      sessionCount: 0,
      archivedCount: 0,
      heldCount: 0,
      byProvider: {},
      lastActivity: 0,
      providers: [],
      hidden: false
    }
  }, [visibleRepos, chatTables, holder, hidden, filtered])

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

  const toggle = useCallback(
    (key: string): void =>
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(key)) next.delete(key)
        else next.add(key)
        return next
      }),
    []
  )

  // one set of drag handlers for every project row, named by the project's key and
  // reading the drag as it is now — a fresh object per row per render re-drew them all
  const dragRef = useRef({ dragKey, dropAt, moveTo, nudge })
  dragRef.current = { dragKey, dropAt, moveTo, nudge }
  const reorder = useMemo(
    (): RepoReorder => ({
      onDragStart: (key) => setDragKey(key),
      onDragOver: (key, place) =>
        setDropAt((prev) => (prev?.target === key && prev.place === place ? prev : { target: key, place })),
      onDrop: () => {
        const { dragKey: from, dropAt: to, moveTo: move } = dragRef.current
        if (from && to) move(from, to)
        setDragKey(null)
        setDropAt(null)
      },
      onDragEnd: () => {
        setDragKey(null)
        setDropAt(null)
      },
      onNudge: (key, delta) => dragRef.current.nudge(key, delta)
    }),
    []
  )

  return (
    <aside className="tree-sidebar">
      <div className="tree-top">
        <button className="app-title" onClick={onGoHome} title="Mission control">
          {/* the wordmark text sheds at narrow widths; the mark itself stays */}
          <CockpitLogo size={18} /> <span className="app-title-text">Cockpit</span>
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

        {/* the four nav keys travel as one group: where the rail is too narrow to
            hold them beside the wordmark they take their own line together, rather
            than one of them wrapping alone (or walking out over the deck) */}
        <div className="tree-nav">
          <button
            className={`icon-btn nav-btn ${activeView === 'extensions' ? 'active' : ''}`}
            title="Agents — shared instructions, MCP servers, skills, plugins"
            onClick={() => onNav('extensions')}
            aria-label="Agents"
            aria-current={activeView === 'extensions' ? 'page' : undefined}
          >
            <AgentIcon size={16} />
          </button>
          <button
            className={`icon-btn nav-btn ${activeView === 'profile' ? 'active' : ''}`}
            title="Profile — your work across every agent"
            onClick={() => onNav('profile')}
            aria-label="Profile"
            aria-current={activeView === 'profile' ? 'page' : undefined}
          >
            {/* GitHub's graph glyph: this is an activity view, not an account page */}
            <GraphIcon size={16} />
          </button>
          <button
            className={`icon-btn nav-btn ${activeView === 'cleanup' ? 'active' : ''}`}
            title={cleanupNote ?? 'Cleanup — stale sessions and abandoned worktrees'}
            onClick={() => onNav('cleanup')}
            aria-label={cleanupNote ?? 'Cleanup'}
            aria-current={activeView === 'cleanup' ? 'page' : undefined}
          >
            <TrashIcon size={16} />
            {cleanupNote && <i className="nav-dot" aria-hidden="true" />}
          </button>
          <button
            className={`icon-btn nav-btn ${activeView === 'settings' ? 'active' : ''}`}
            title="Settings"
            onClick={() => onNav('settings')}
            aria-label="Settings"
            aria-current={activeView === 'settings' ? 'page' : undefined}
          >
            <GearIcon size={16} />
          </button>
        </div>
      </div>
      <div className="search-row">
        {/* the eye scopes the tree, the field searches it, compose creates —
            all three tree controls on one line, in reading order */}
        <ProjectFilter
          repos={orderedRepos}
          onResetOrder={customOrder ? resetOrder : undefined}
        />
        <input
          className="search"
          aria-label="Search sessions"
          placeholder="Search sessions…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {/* the one always-visible way to start work — everything else is hover or ⌘N.
            Icon-only on purpose; the accent fill is what says "this one creates" */}
        <button
          className="btn-primary new-task-btn"
          title="New task (⌘N)"
          aria-label="New task"
          onClick={onNewTask}
        >
          <ComposeIcon size={14} />
        </button>
      </div>
      {/* the filter outlives a restart, so while it is on the tree says so in words —
          a tree quietly missing half its sessions reads as sessions gone */}
      {filtered && (
        <div className="tree-scope">
          {holder === 'cockpit' ? <HeldIcon size={10} /> : holder === 'agent' ? <ProcessIcon size={10} /> : <ChatIcon size={10} />}
          <span className="tree-scope-text">{scopeSentence(holder, hidden)}</span>
          <button
            className="link-btn"
            onClick={() => {
              setHolderFilter(null)
              showAllAgents()
            }}
          >
            Show all
          </button>
        </div>
      )}
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
          const rows = Array.from(
            e.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"], .archived-toggle, .tree-more')
          )
          if (rows.length === 0) return
          const at = rows.indexOf(document.activeElement as HTMLElement)
          const to = roveIndex(e.key, { at, count: rows.length }, TREE_KEYS)
          if (to === null) return
          e.preventDefault()
          rows[to]?.focus()
        }}
      >
        {debounced ? (
          <SearchResults
            query={debounced}
            holder={holder}
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
              tables={(r.root !== null && repoTables.get(r.root)) || NO_TABLES}
              selectedRoundtableId={selectedRoundtableId}
              onOpenRoundtable={onOpenRoundtable}
              onToggle={toggle}
              onSelect={onSelect}
              onNewSession={onNewSession}
              onRepoSetup={onRepoSetup}
              onOpenUrl={onOpenUrl}
              dragging={dragKey === r.key}
              drop={dragKey !== null && dropAt?.target === r.key ? dropAt.place : null}
              reorder={reorder}
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
            tables={chatTables}
            selectedRoundtableId={selectedRoundtableId}
            onOpenRoundtable={onOpenRoundtable}
            onToggle={() => setChatsOpen((v) => !v)}
            onSelect={onSelect}
          />
        )}
        {repos.length === 0 && (
          <div className="empty-item">
            <p>No sessions indexed yet — Cockpit reads Claude Code, Codex, and Copilot logs.</p>
            <button className="btn-ghost small" onClick={() => onOpenSettings()}>
              Add a config home
            </button>
          </div>
        )}
        {repos.length > 0 && visibleRepos.length === 0 && !debounced && (
          <div className="empty-item">
            <p>All projects are hidden — the eye button above brings them back.</p>
          </div>
        )}
        {filtered && visibleRepos.length > 0 && repoList.length === 0 && !general && !debounced && (
          <div className="empty-item">
            <p>
              {hidden.length > 0
                ? 'No sessions of the agents the tree shows.'
                : holder === 'cockpit'
                  ? 'Cockpit holds no sessions yet — start one, or take one over from its agent.'
                  : 'Every session is in Cockpit — none are with their agents.'}
            </p>
            <button
              className="btn-ghost small"
              onClick={() => {
                setHolderFilter(null)
                showAllAgents()
              }}
            >
              Show all sessions
            </button>
          </div>
        )}
      </div>
      {/* outside the tree on purpose: a role=tree may only own treeitems and groups,
          and a live region among them is content a screen reader cannot place */}
      <div className="sr-only" role="status" aria-live="polite">
        {orderNote}
      </div>
      <footer className="sidebar-footer">
        {/* a newer Cockpit rides on top while it needs you — fetch it, restart into it,
            or (when a step failed) open About for why */}
        <UpdateBar onOpenAbout={() => onOpenSettings('about')} />
        {/* subscription meters ride above the identity bar — one cell per provider
            that reports numbers; the row opens Settings at the usage section */}
        <UsageMeters onOpen={() => onOpenSettings('accounts')} />
        <IdentityBar accounts={accounts} onOpen={() => onOpenSettings()} />
      </footer>
      {/* the rail's width is the person's: the sash on its right edge, last so Tab
          reaches it after the footer and before the deck */}
      <RailResizer />
    </aside>
  )
}

/**
 * One compact identity bar: agent logos (accounts in the tooltip), GitHub login on the
 * right; the whole row opens Settings for the full detail.
 */
function IdentityBar({
  accounts,
  onOpen
}: {
  accounts: AccountsSnapshot | null
  onOpen: () => void
}): JSX.Element {
  return (
    <button
      className="footer-ids"
      onClick={onOpen}
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
        <ProviderMark key={a.path} p={a.provider} size={12} />
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
  )
}

/** Memoized, with every prop stable across a render that did not touch this project. */
const RepoNode = memo(function RepoNode({
  repo,
  open,
  indexVersion,
  accounts,
  selectedId,
  tables,
  selectedRoundtableId,
  onOpenRoundtable,
  onToggle,
  onSelect,
  onNewSession,
  onRepoSetup,
  onOpenUrl,
  dragging,
  drop,
  reorder
}: {
  repo: RepoGroup
  open: boolean
  indexVersion: number
  accounts: AccountsSnapshot | null
  selectedId: string | null
  tables: RoundtableMeta[]
  selectedRoundtableId: string | null
  onOpenRoundtable: (id: string) => void
  /** Called with this project's key */
  onToggle: (key: string) => void
  onSelect: (s: SessionMeta) => void
  onNewSession: (repo: RepoGroup) => void
  onRepoSetup: (repoRoot: string) => void
  onOpenUrl: (url: string) => void
  /** This project is the one being dragged */
  dragging: boolean
  /** Where a drop on this project would land, while something is dragged over it */
  drop: 'before' | 'after' | null
  reorder: RepoReorder
}): JSX.Element {
  const root = repo.root
  const { value: prs } = useLoaded(open && root ? () => api.getPrs(root) : null, [open, repo.root, indexVersion], {
    initial: NO_PRS,
    keepSame: true
  })
  const [showArchived, setShowArchived] = useState(false)
  const toggleThis = (): void => onToggle(repo.key)
  const holder = useHolderFilter()
  const hidden = useHiddenAgents()

  return (
    <div
      className={`repo-node${dragging ? ' dragging' : ''}${drop ? ` drop-${drop}` : ''}`}
      role="presentation"
      // the whole node is the drop target, so an expanded project's sessions count as
      // its lower half — dropping there lands after the project, not inside it
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(REPO_DRAG_TYPE)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const box = e.currentTarget.getBoundingClientRect()
        reorder.onDragOver(repo.key, e.clientY < box.top + Math.min(box.height / 2, 15) ? 'before' : 'after')
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes(REPO_DRAG_TYPE)) return
        e.preventDefault()
        reorder.onDrop()
      }}
    >
      <div
        className="repo-row"
        role="treeitem"
        aria-expanded={open}
        aria-level={1}
        aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
        tabIndex={-1}
        title={`${repo.root ?? repo.fullName ?? repo.name}\nDrag (or ⌥↑/⌥↓) to reorder`}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData(REPO_DRAG_TYPE, repo.key)
          e.dataTransfer.effectAllowed = 'move'
          reorder.onDragStart(repo.key)
        }}
        onDragEnd={reorder.onDragEnd}
        onClick={toggleThis}
        onKeyDown={(e) => {
          if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            // the tree's own arrow handling would move focus instead — this moves the row
            e.preventDefault()
            e.stopPropagation()
            reorder.onNudge(repo.key, e.key === 'ArrowUp' ? -1 : 1)
            return
          }
          expandKeys(open, toggleThis)(e)
        }}
      >
        <span className={`chev ${open ? 'open' : ''}`} aria-hidden="true">▸</span>
        <span className="repo-icon">
          <RepoIcon size={13} />
        </span>
        <span className="repo-name">
          <RepoName repo={repo} />
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
              title={`Agent setup for ${repo.name}`}
              aria-label={`Agent setup for ${repo.name}`}
              onClick={(e) => {
                e.stopPropagation()
                onRepoSetup(repo.root as string)
              }}
            >
              <SlidersIcon size={11} />
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
        <span className="repo-count">{shownSessions(repo, { holder, hidden })}</span>
      </div>
      {open && (
        <GroupChildren
          repo={repo}
          prs={prs}
          indexVersion={indexVersion}
          accounts={accounts}
          selectedId={selectedId}
          tables={tables}
          selectedRoundtableId={selectedRoundtableId}
          onOpenRoundtable={onOpenRoundtable}
          showArchived={showArchived}
          onToggleArchived={() => setShowArchived((v) => !v)}
          onSelect={onSelect}
          onOpenUrl={onOpenUrl}
        />
      )}
    </div>
  )
})

/** Private drag payload — a session row or a file dropped on the tree is not a reorder. */
const REPO_DRAG_TYPE = 'application/x-cockpit-repo'

/** The drag handlers every project row shares — each names the project it is about. */
type RepoReorder = {
  readonly onDragStart: (key: string) => void
  readonly onDragOver: (key: string, place: 'before' | 'after') => void
  readonly onDrop: () => void
  readonly onDragEnd: () => void
  readonly onNudge: (key: string, delta: -1 | 1) => void
}

/** Stable identities: a new [] each render would re-trigger memoized children. */
const NO_PRS: PrStatus[] = []
const NO_TABLES: RoundtableMeta[] = []

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

/** The tree's filters in words — while one is on, the tree says so above its rows. */
function scopeSentence(holder: SessionHolder | null, hidden: readonly SessionProvider[]): string {
  const who = holder === 'cockpit' ? 'in Cockpit' : holder === 'agent' ? 'outside Cockpit' : null
  const agents = hidden.length === 0 ? null : `not ${hidden.map((a) => PROVIDER_LABEL[a]).join(' or ')}`
  return `Only sessions ${[who, agents].filter(Boolean).join(', ')}`
}

function ProviderStrip({ providers }: { providers: readonly SessionProvider[] }): JSX.Element {
  return (
    <span className="repo-providers">
      {providers.map((p) => (
        <ProviderMark key={p} p={p} size={10} titled />
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
  /** Roundtables that belong to this group — rendered as items above the sessions */
  readonly tables: RoundtableMeta[]
  readonly selectedRoundtableId: string | null
  readonly onOpenRoundtable: (id: string) => void
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
  tables,
  selectedRoundtableId,
  onOpenRoundtable,
  showArchived,
  onToggleArchived,
  onSelect,
  onOpenUrl
}: GroupChildrenProps): JSX.Element {
  // a table is Cockpit's own work — out of sight while the tree shows only the agents'
  const holder = useHolderFilter()
  const hidden = useHiddenAgents()
  const own = holder === 'agent' ? NO_TABLES : tables
  // an archived table hides with the archived sessions, and is brought back the same way
  const active = own.filter((t) => !t.archived)
  const archivedTables = own.filter((t) => t.archived)
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
      {active.map((t) => (
        <RoundtableNode
          key={t.id}
          t={t}
          selected={selectedRoundtableId === t.id}
          selectedId={selectedId}
          indexVersion={indexVersion}
          onOpen={onOpenRoundtable}
          onSelect={onSelect}
        />
      ))}
      {(shownSessions(repo, { holder, hidden }) > 0 || active.length === 0) && list(false)}
      {repo.archivedCount + archivedTables.length > 0 && (
        <>
          <button
            className="archived-toggle"
            // a row in the tree, and the arrows already treat it as one: a role=tree
            // may own nothing but treeitems and groups
            role="treeitem"
            aria-level={2}
            aria-expanded={showArchived}
            tabIndex={-1}
            onClick={onToggleArchived}
          >
            <span className={`chev ${showArchived ? 'open' : ''}`} aria-hidden="true">▸</span>
            {/* the count is every archived session's: under a holder filter or with an
                agent hidden the list is narrower than it, so no number rather than a wrong one */}
            {holder || hidden.length > 0 ? 'Archived' : `Archived (${repo.archivedCount + archivedTables.length})`}
          </button>
          {showArchived &&
            archivedTables.map((t) => (
              <RoundtableNode
                key={t.id}
                t={t}
                selected={selectedRoundtableId === t.id}
                selectedId={selectedId}
                indexVersion={indexVersion}
                onOpen={onOpenRoundtable}
                onSelect={onSelect}
              />
            ))}
          {showArchived && repo.archivedCount > 0 && list(true)}
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
  tables,
  selectedRoundtableId,
  onOpenRoundtable,
  onToggle,
  onSelect
}: {
  repo: RepoGroup
  open: boolean
  indexVersion: number
  accounts: AccountsSnapshot | null
  selectedId: string | null
  tables: RoundtableMeta[]
  selectedRoundtableId: string | null
  onOpenRoundtable: (id: string) => void
  onToggle: () => void
  onSelect: (s: SessionMeta) => void
}): JSX.Element {
  const [showArchived, setShowArchived] = useState(false)
  const holder = useHolderFilter()
  const hidden = useHiddenAgents()

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
        <span className="repo-count">{shownSessions(repo, { holder, hidden })}</span>
      </div>
      {open && (
        // no repo means no PRs and nothing to open on GitHub
        <GroupChildren
          repo={repo}
          prs={NO_PRS}
          indexVersion={indexVersion}
          accounts={accounts}
          selectedId={selectedId}
          tables={tables}
          selectedRoundtableId={selectedRoundtableId}
          onOpenRoundtable={onOpenRoundtable}
          showArchived={showArchived}
          onToggleArchived={() => setShowArchived((v) => !v)}
          onSelect={onSelect}
          onOpenUrl={noop}
        />
      )}
    </div>
  )
}

function SearchResults({
  query,
  holder,
  indexVersion,
  selectedId,
  onSelect
}: {
  query: string
  /** The tree's holder filter — a search inside it stays inside it */
  holder: SessionHolder | null
  indexVersion: number
  selectedId: string | null
  onSelect: (s: SessionMeta) => void
}): JSX.Element {
  const hidden = useHiddenAgents()
  const { value: page } = useLoaded(
    () =>
      api.pageSessions({
        search: query,
        limit: 100,
        ...(holder ? { holder } : {}),
        ...(shownProviders(hidden) ? { providers: shownProviders(hidden) } : {})
      }),
    [query, holder, hidden, indexVersion]
  )
  // null = search in flight — don't flash "no matches" while waiting
  const items = page?.items ?? null
  const total = page?.total ?? 0

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
              onOpenUrl={noop}
            />
          ))}
        </div>
      ))}
      {items.length === 0 && <div className="tree-empty">no sessions match “{query}”</div>}
      {total > items.length && <div className="tree-empty">{total - items.length} more — refine your search</div>}
    </>
  )
}
