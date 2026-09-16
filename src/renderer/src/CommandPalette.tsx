import { useEffect, useId, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import type {
  RepoGroup,
  SessionMeta,
  TimeFormat,
  TranscriptHit,
  TranscriptSearchResult
} from '../../shared/types'
import { api } from './api'
import { useBusyMap } from './busy'
import { useLandedMap } from './landed'
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
  SearchIcon,
  SlidersIcon,
  TrashIcon
} from './logos'
import { fmtTime, useTimeFormat } from './time'

/** Views the palette can navigate to — App's View kinds, minus chat/new (those need a target). */
export type PaletteViewKey = 'welcome' | 'extensions' | 'profile' | 'cleanup' | 'settings'

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
    key: 'cleanup',
    label: 'Cleanup',
    keywords: ['cleanup', 'clean', 'stale', 'worktrees', 'prune', 'disk', 'delete', 'archive'],
    icon: <TrashIcon size={13} />
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
    keywords: ['settings', 'config homes', 'sources', 'usage', 'accounts', 'model providers', 'preferences'],
    icon: <GearIcon size={13} />
  }
]

type Item =
  | { readonly kind: 'session'; readonly s: SessionMeta }
  | { readonly kind: 'repo'; readonly r: RepoGroup }
  | { readonly kind: 'repo-setup'; readonly r: RepoGroup }
  | { readonly kind: 'view'; readonly v: ViewTarget }
  /** The door into transcripts mode: "search transcripts for …" under the session hits */
  | { readonly kind: 'transcripts'; readonly query: string }
  /** One matching message; `i` keeps two identical snippets in one session apart */
  | { readonly kind: 'hit'; readonly h: TranscriptHit; readonly s: SessionMeta; readonly i: number }
  /** Widen a repo-scoped transcript search to every repo, or narrow it back */
  | { readonly kind: 'scope'; readonly all: boolean }

type Group = { readonly label: string; readonly items: readonly Item[] }

/** Jump is the palette as it opens; transcripts searches inside the conversations. */
type Mode = 'jump' | 'transcripts'

const itemKey = (it: Item): string => {
  switch (it.kind) {
    case 'session':
      return it.s.id
    case 'repo':
      return `repo:${it.r.key}`
    case 'repo-setup':
      return `setup:${it.r.key}`
    case 'view':
      return `view:${it.v.key}`
    case 'transcripts':
      return `transcripts:${it.query}`
    case 'hit':
      return `hit:${it.i}:${it.h.sessionId}`
    case 'scope':
      return `scope:${it.all}`
  }
}

/** Result caps — the palette is a jump surface, the sidebar stays the exhaustive list. */
const SESSION_LIMIT_QUERY = 6
const SESSION_LIMIT_RECENT = 8
const REPO_LIMIT = 4
/** Transcript hits shown; main also caps per session so one chat can't fill the list. */
const TRANSCRIPT_LIMIT = 30
/** Shortest query a transcript search runs for (main refuses shorter ones anyway). */
const TRANSCRIPT_MIN_QUERY = 2

const repoName = (r: RepoGroup): string => r.fullName ?? r.name

const ROLE_LABEL: Record<TranscriptHit['role'], string> = {
  user: 'you',
  assistant: 'agent',
  tool: 'tool'
}

/**
 * ⌘K palette: one input that reaches any session, starts a session in any repo,
 * or opens any view. With an empty query it opens as a miniature of the board —
 * flying sessions first, livery dots and all — so the keyboard door shows the
 * same fleet the home view does. Deliberately not an action executor.
 *
 * Its second mode searches *inside* the transcripts, across all three agents at
 * once: a query offers "search transcripts for …" under the session hits, picking
 * it flips the palette into transcripts mode (a chip on the input row says so),
 * hits come back as marked snippets that open their session, and Backspace on an
 * empty query returns to jump. Scoped to the repo the window is on when there is
 * one; a scope row widens to every repo.
 */
export function CommandPalette({
  repos,
  scopeRepo,
  onOpenSession,
  onNewSession,
  onRepoSetup,
  onGoto,
  onClose
}: {
  repos: RepoGroup[]
  /** The repo the window is looking at — transcript search starts scoped to it */
  scopeRepo: RepoGroup | null
  onOpenSession: (s: SessionMeta) => void
  onNewSession: (repo: RepoGroup) => void
  onRepoSetup: (repoRoot: string) => void
  onGoto: (view: PaletteViewKey) => void
  onClose: () => void
}): JSX.Element {
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [mode, setMode] = useState<Mode>('jump')
  const [allRepos, setAllRepos] = useState(false)
  // null = first fetch in flight — never flash an empty state before results land
  const [sessions, setSessions] = useState<SessionMeta[] | null>(null)
  const [total, setTotal] = useState(0)
  // the last settled transcript search; kept on screen while the next one runs
  const [transcripts, setTranscripts] = useState<TranscriptSearchResult | null>(null)
  const [scanning, setScanning] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const busy = useBusyMap()
  const landed = useLandedMap()
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

  // 120ms, half the sidebar's 250: each keystroke fetches a page of 6, not a tree swap.
  // Transcripts wait 300: each keystroke there streams through every candidate file.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), mode === 'transcripts' ? 300 : 120)
    return () => clearTimeout(t)
  }, [query, mode])

  useEffect(() => {
    if (mode !== 'jump') return
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
  }, [debounced, mode])

  const scopeKey = !allRepos && scopeRepo ? scopeRepo.key : undefined
  const scopeLabel = scopeKey && scopeRepo ? repoName(scopeRepo) : 'all repos'

  useEffect(() => {
    if (mode !== 'transcripts') return
    if (debounced.length < TRANSCRIPT_MIN_QUERY) {
      setTranscripts(null)
      setScanning(false)
      return
    }
    let dead = false
    setScanning(true)
    void api
      .searchTranscripts({ text: debounced, repoKey: scopeKey, limit: TRANSCRIPT_LIMIT })
      .then((r) => {
        if (dead) return
        setTranscripts(r)
        setScanning(false)
      })
    // a newer query, a scope flip or closing the palette: stop the scan, don't let
    // it grind through the remaining files for nobody
    return () => {
      dead = true
      void api.cancelTranscriptSearch()
    }
  }, [mode, debounced, scopeKey])

  const groups = useMemo((): readonly Group[] => {
    const out: Group[] = []
    if (mode === 'transcripts') {
      const items: Item[] = []
      if (transcripts) {
        const bySession = new Map(transcripts.sessions.map((s) => [s.id, s]))
        transcripts.hits.forEach((h, i) => {
          const s = bySession.get(h.sessionId)
          if (s) items.push({ kind: 'hit', h, s, i })
        })
      }
      if (scopeRepo) items.push({ kind: 'scope', all: !allRepos })
      if (items.length > 0) out.push({ label: `transcripts in ${scopeLabel}`, items })
      return out
    }
    const got = sessions ?? []
    const q = debounced.toLowerCase()
    if (q) {
      if (got.length > 0)
        out.push({ label: 'sessions', items: got.map((s) => ({ kind: 'session', s })) })
      // one row down from the name matches: what the sessions said, not what they're called
      out.push({ label: 'in transcripts', items: [{ kind: 'transcripts', query: debounced }] })
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
      // the board's ordering, in miniature: flying, then what landed unseen, then recent
      const flying = got
        .filter((s) => busy.has(s.id))
        .sort((a, b) => (busy.get(a.id) ?? 0) - (busy.get(b.id) ?? 0))
      const arrived = got
        .filter((s) => !busy.has(s.id) && landed.has(s.id))
        .sort((a, b) => (landed.get(b.id) ?? 0) - (landed.get(a.id) ?? 0))
      const ground = got.filter((s) => !busy.has(s.id) && !landed.has(s.id))
      if (flying.length > 0)
        out.push({ label: 'flying now', items: flying.map((s) => ({ kind: 'session', s })) })
      if (arrived.length > 0)
        out.push({ label: 'landed', items: arrived.map((s) => ({ kind: 'session', s })) })
      if (ground.length > 0)
        out.push({ label: 'recent', items: ground.map((s) => ({ kind: 'session', s })) })
      out.push({ label: 'go to', items: VIEWS.map((v) => ({ kind: 'view', v })) })
    }
    return out
  }, [mode, transcripts, scopeRepo, allRepos, scopeLabel, sessions, debounced, repos, busy, landed])

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups])

  // new results reset the cursor — the top hit is the palette's promise
  const flatIds = flat.map(itemKey).join('\n')
  useEffect(() => setActive(0), [flatIds])

  useEffect(() => {
    document.getElementById(`${baseId}-opt-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [active, baseId])

  const leaveTranscripts = (): void => {
    setMode('jump')
    setTranscripts(null)
    setScanning(false)
    inputRef.current?.focus()
  }

  const pick = (it: Item): void => {
    // the two mode rows re-shape the palette instead of leaving it
    if (it.kind === 'transcripts') {
      setMode('transcripts')
      return
    }
    if (it.kind === 'scope') {
      setAllRepos(it.all)
      return
    }
    onClose()
    if (it.kind === 'session') onOpenSession(it.s)
    else if (it.kind === 'hit') onOpenSession(it.s)
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
    } else if (e.key === 'Backspace' && mode === 'transcripts' && query === '') {
      // the chip is the only thing left to delete — the token-field convention
      e.preventDefault()
      leaveTranscripts()
    } else if (e.key === 'Tab') {
      // single-field dialog: Tab has nowhere to go — close and restore focus
      e.preventDefault()
      onClose()
    }
  }

  const hiddenMatches = mode === 'jump' && debounced && sessions !== null ? total - sessions.length : 0
  const hitCount = transcripts?.hits.length ?? 0
  // the door into transcripts stands under every query — "nothing matches" is about
  // the rest of the list
  const jumpHits = flat.filter((it) => it.kind !== 'transcripts').length

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
        <div className="palette-head">
          {mode === 'transcripts' && (
            <button
              type="button"
              className="palette-mode"
              // reached by Backspace on an empty query, never by Tab (which closes)
              tabIndex={-1}
              title="Back to jump — or Backspace on an empty query"
              aria-label="Searching transcripts — back to jump"
              onClick={leaveTranscripts}
            >
              <SearchIcon size={11} />
              transcripts
            </button>
          )}
          <input
            ref={inputRef}
            className="palette-input"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={flat.length > 0 ? optId(active) : undefined}
            aria-label={
              mode === 'transcripts'
                ? `Search transcripts in ${scopeLabel}`
                : 'Jump to a session, repository, or view'
            }
            placeholder={
              mode === 'transcripts'
                ? `Search transcripts in ${scopeLabel}…`
                : 'Jump to a session, repository, or view…'
            }
            spellCheck={false}
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
          />
        </div>
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
                      landed={it.kind === 'session' && !busy.has(it.s.id) && landed.has(it.s.id)}
                      showRepo={mode === 'transcripts' ? scopeKey === undefined : debounced !== ''}
                      scopeLabel={scopeLabel}
                      scopeRepo={scopeRepo}
                      timeFormat={timeFormat}
                      onHover={() => setActive(i)}
                      onPick={() => pick(it)}
                    />
                  )
                })}
              </div>
            )
          })}
          {mode === 'jump' && sessions === null && jumpHits === 0 && (
            <div className="tree-empty">searching…</div>
          )}
          {mode === 'jump' && sessions !== null && jumpHits === 0 && (
            <div className="tree-empty">
              nothing matches “{debounced}” — try a session, repository, or view name, or search
              the transcripts
            </div>
          )}
          {hiddenMatches > 0 && (
            <div className="tree-empty">
              {hiddenMatches} more — keep typing to narrow, or search the sidebar
            </div>
          )}
          {mode === 'transcripts' && <TranscriptStatus result={transcripts} query={debounced} scanning={scanning} scopeLabel={scopeLabel} scoped={scopeKey !== undefined} />}
        </div>
        <div className="sr-only" role="status" aria-live="polite">
          {mode === 'transcripts'
            ? scanning
              ? 'searching transcripts'
              : transcripts
                ? `${hitCount} transcript hits`
                : ''
            : sessions === null
              ? ''
              : `${flat.length} results`}
        </div>
      </div>
    </div>
  )
}

/**
 * What a transcript search did, in one quiet line: the hint before a query, the
 * scan while it runs (previous hits stay up), and afterwards how much it read and
 * why it stopped early — a capped or timed-out search must never pass for a
 * complete one.
 */
function TranscriptStatus({
  result,
  query,
  scanning,
  scopeLabel,
  scoped
}: {
  result: TranscriptSearchResult | null
  query: string
  scanning: boolean
  scopeLabel: string
  scoped: boolean
}): JSX.Element {
  if (query.length < TRANSCRIPT_MIN_QUERY) {
    return (
      <div className="tree-empty">
        type to search what you and the agents said in {scopeLabel} — tool output stays out
      </div>
    )
  }
  if (scanning && !result) return <div className="tree-empty">searching transcripts…</div>
  if (!result) return <div className="tree-empty" />
  const sessions = new Set(result.hits.map((h) => h.sessionId)).size
  const notes: string[] = []
  if (result.hits.length === 0) {
    notes.push(`nothing in ${scopeLabel} transcripts mentions “${result.query}”`)
    if (scoped) notes.push('try all repos')
  } else {
    notes.push(
      `${result.hits.length} ${result.hits.length === 1 ? 'hit' : 'hits'} in ${sessions} ${sessions === 1 ? 'session' : 'sessions'}`
    )
  }
  notes.push(`searched ${result.scanned} of ${result.candidates} transcripts`)
  if (result.stoppedBy === 'hit-cap') notes.push('stopped at the hit cap — narrow the query')
  if (result.stoppedBy === 'time') notes.push('ran out of time — narrow the query or the scope')
  if (result.truncated > 0)
    notes.push(`${result.truncated} large ${result.truncated === 1 ? 'transcript' : 'transcripts'} read only in part`)
  return (
    <div className="tree-empty">
      {notes.join(' · ')}
      {scanning && ' · searching…'}
    </div>
  )
}

/** The snippet with its match marked, when main could place it. */
function Snippet({ h }: { h: TranscriptHit }): JSX.Element {
  if (h.matchStart < 0 || h.matchEnd <= h.matchStart) return <>{h.snippet}</>
  return (
    <>
      {h.snippet.slice(0, h.matchStart)}
      <mark>{h.snippet.slice(h.matchStart, h.matchEnd)}</mark>
      {h.snippet.slice(h.matchEnd)}
    </>
  )
}

function PaletteOption({
  id,
  it,
  active,
  flying,
  landed,
  showRepo,
  scopeLabel,
  scopeRepo,
  timeFormat,
  onHover,
  onPick
}: {
  id: string
  it: Item
  active: boolean
  flying: boolean
  /** Its last turn ended and it hasn't been opened since (landed.ts) */
  landed: boolean
  /** Query mode shows which repo a session belongs to; recent mode stays clean */
  showRepo: boolean
  /** Where a transcript search looks — named on the door row and the scope row */
  scopeLabel: string
  scopeRepo: RepoGroup | null
  timeFormat: TimeFormat
  onHover: () => void
  onPick: () => void
}): JSX.Element {
  const label =
    it.kind === 'session'
      ? `${PROVIDER_LABEL[it.s.provider]} session: ${it.s.title}`
      : it.kind === 'hit'
        ? `${PROVIDER_LABEL[it.s.provider]} session: ${it.s.title} — ${ROLE_LABEL[it.h.role]}: ${it.h.snippet}`
        : it.kind === 'repo'
          ? `New session in ${it.r.fullName ?? it.r.name}`
          : it.kind === 'repo-setup'
            ? `Agent setup for ${it.r.fullName ?? it.r.name}`
            : it.kind === 'transcripts'
              ? `Search transcripts for “${it.query}” in ${scopeLabel}`
              : it.kind === 'scope'
                ? it.all
                  ? 'Search all repos'
                  : `Search only ${scopeRepo ? repoName(scopeRepo) : 'this repo'}`
                : it.v.label
  return (
    <div
      id={id}
      role="option"
      aria-selected={active}
      aria-label={label}
      className={`palette-opt ${it.kind === 'hit' ? 'palette-hit' : ''} ${active ? 'active' : ''}`}
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
          ) : landed ? (
            <span
              className={`landed-dot plogo-${it.s.provider}`}
              role="img"
              aria-label="finished — not opened yet"
            />
          ) : (
            <time className="palette-meta" dateTime={new Date(it.s.updatedAt).toISOString()}>
              {fmtTime(it.s.updatedAt, timeFormat)}
            </time>
          )}
        </>
      )}
      {it.kind === 'hit' && (
        <>
          <div className="palette-hit-head">
            <span className={`plogo plogo-${it.s.provider}`}>
              <ProviderLogo p={it.s.provider} size={13} />
            </span>
            <span className="palette-title">{it.s.title}</span>
            {showRepo && it.s.repo && <span className="palette-hint">{it.s.repo.name}</span>}
            <time
              className="palette-meta"
              dateTime={new Date(it.h.timestamp ?? it.s.updatedAt).toISOString()}
            >
              {fmtTime(it.h.timestamp ?? it.s.updatedAt, timeFormat)}
            </time>
          </div>
          <div className="palette-snippet">
            <span className="palette-role">{ROLE_LABEL[it.h.role]}</span>
            <Snippet h={it.h} />
          </div>
        </>
      )}
      {it.kind === 'transcripts' && (
        <>
          <span className="palette-view-icon">
            <SearchIcon size={13} />
          </span>
          <span className="palette-title">search transcripts for “{it.query}”</span>
          <span className="palette-hint">{scopeLabel}</span>
        </>
      )}
      {it.kind === 'scope' && (
        <>
          <span className="palette-view-icon">
            <RepoIcon size={13} />
          </span>
          <span className="palette-title">
            {it.all ? 'all repos' : `only ${scopeRepo ? repoName(scopeRepo) : 'this repo'}`}
          </span>
          <span className="palette-hint">search scope</span>
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
