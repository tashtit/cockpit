import { memo, useMemo, useState, type CSSProperties, type JSX } from 'react'
import type { AccountsSnapshot, Landing, PrStatus, SessionMeta, TimeFormat } from '../../shared/types'
import { api } from './api'
import { useBusyMap, useSessionBusy } from './busy'
import { toggleFamily, useFoldedFamilies } from './families'
import { HeldMark } from './HeldMark'
import { holdSentence, useHolderFilter } from './hold'
import { useLandedMap, useSessionLanded } from './landed'
import { ArchiveIcon, ElbowIcon, landingLabel, LandingMark, PrBadge, ProviderMark, PROVIDER_LABEL, Spinner } from './logos'
import { fmtTime, useTimeFormat } from './time'
import { useLoaded } from './use-loaded'

/** Rows a tree list asks for at a time — "more…" adds another page. */
export const PAGE = 20
/** Server-side page clamp — hide "more" past this. */
const MAX_LOADED = 1000

/** Stable identity for a row with no PR to open: a new () => {} each render would
 *  re-trigger the memoized rows. */
export const noop = (): void => {}

type Nest = {
  readonly s: SessionMeta
  /** How many sessions up the family this row hangs from — 0 for a top-level row */
  readonly depth: number
  /** The session that started this one, when that is the family the row sits in */
  readonly parent?: SessionMeta
  /** Every row under this one in its family — mutable: nesting() fills it in */
  descendants: SessionMeta[]
  /** This row's family is folded, so its descendants are not rendered — mutable:
   *  nesting() decides it on a second pass, once every family is known */
  folded: boolean
  /** A folded ancestor hides this row — mutable for the same second pass */
  hidden: boolean
}

/**
 * How each row sits in a family of sessions one session started (`parentId`): how
 * deep, under whom, what hangs below it, and whether a fold hides it. A row nests
 * only under the family the rows above it are still in — the indexer emits a family
 * contiguously (`groupFamilies`), so a parent anywhere else in the list is not what
 * the row hangs from. A fold never hides the open session: while one of its
 * descendants is selected, a folded family renders open (the fold itself is kept).
 */
function nesting(
  items: readonly SessionMeta[],
  folds: ReadonlySet<string>,
  selectedId: string | null
): readonly Nest[] {
  const out: Nest[] = []
  const path: Nest[] = []
  for (const s of items) {
    while (path.length > 0 && path[path.length - 1].s.id !== s.parentId) path.pop()
    const row: Nest = { s, depth: path.length, parent: path[path.length - 1]?.s, descendants: [], folded: false, hidden: false }
    for (const up of path) up.descendants.push(s)
    out.push(row)
    path.push(row)
  }
  let foldedAt = Infinity
  for (const row of out) {
    row.hidden = row.depth > foldedAt
    if (row.hidden) continue
    foldedAt = Infinity
    row.folded =
      row.descendants.length > 0 &&
      folds.has(row.s.id) &&
      !row.descendants.some((d) => d.id === selectedId)
    if (row.folded) foldedAt = row.depth
  }
  return out
}

/** A tree group's sessions, paged, each nested in its family and handoff chain. */
export function SessionList({
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
  const holder = useHolderFilter()
  // a live-index refetch keeps the page it replaces when nothing in it changed, so the
  // rows keep their identity (`keepSame`: by every field, not a chosen few — a row draws
  // its branch, re-derived on every scan, and the PR found by it, its place in a family
  // and a handoff chain, its account, and hands the whole session to `onSelect`)
  const { value: page } = useLoaded(
    () =>
      api.pageSessions({
        repoKey,
        archived,
        offset: 0,
        limit: Math.min(PAGE * pages, MAX_LOADED),
        ...(holder ? { holder } : {})
      }),
    [repoKey, archived, pages, indexVersion, holder],
    { keepSame: true }
  )
  // null = first page still loading — "no sessions" must never flash during the fetch
  const items = page?.items ?? null
  const total = page?.total ?? 0

  const folds = useFoldedFamilies()
  const rows = useMemo(() => nesting(items ?? [], folds, selectedId), [items, folds, selectedId])

  if (items === null) return <div className="tree-empty">loading…</div>

  return (
    <>
      {rows.map(
        (r, i) =>
          !r.hidden && (
            <SessionRow
              key={r.s.id}
              s={r.s}
              pr={r.s.gitBranch ? prs.find((p) => p.headRefName === r.s.gitBranch) : undefined}
              accounts={accounts}
              selected={selectedId === r.s.id}
              // the indexer emits handoff chains contiguously, newest first: a row whose
              // id is the previous row's `continuedFrom` renders as that row's ancestor
              chained={items[i - 1]?.continuedFrom === r.s.id}
              family={r}
              onSelect={onSelect}
              onOpenUrl={onOpenUrl}
            />
          )
      )}
      {/* an active list only comes up empty when every session is archived —
          the Archived toggle right below is the way back in */}
      {items.length === 0 && (
        <div className="tree-empty">
          no {archived ? 'archived' : 'active'} sessions
          {holder === 'cockpit' ? ' in Cockpit' : holder === 'agent' ? ' outside Cockpit' : ''}
        </div>
      )}
      {items.length < total && items.length < MAX_LOADED && (
        <button className="tree-more" role="treeitem" aria-level={2} tabIndex={-1} onClick={() => setPages((p) => p + 1)}>
          more… ({items.length}/{total})
        </button>
      )}
    </>
  )
}

/** Memoized: an index push that left this session alone must not redraw its row. */
export const SessionRow = memo(function SessionRow({
  s,
  pr,
  accounts,
  selected,
  level = 2,
  chained = false,
  family,
  onSelect,
  onOpenUrl
}: {
  s: SessionMeta
  pr?: PrStatus
  accounts?: AccountsSnapshot | null
  selected: boolean
  /** 2 under a repo/section row, 1 in flat search results */
  level?: number
  /** This session was continued by the row above it (handoff thread ancestor) */
  chained?: boolean
  /** Where the row sits in a family of sessions one session started, if in one */
  family?: Nest
  onSelect: (s: SessionMeta) => void
  onOpenUrl: (url: string) => void
}): JSX.Element {
  const timeFormat = useTimeFormat()
  // the live dot takes the row's exclusive meta slot: running beats PR beats time
  const working = useSessionBusy(s.id)
  const landed = useSessionLanded(s.id)
  const acct = accounts?.accounts.find((a) => a.provider === s.provider && a.label === s.source)
  const multiAccount =
    (accounts?.accounts.filter((a) => a.provider === s.provider).length ?? 0) > 1
  const depth = family?.depth ?? 0
  const parent = family?.parent
  const under = family?.descendants.length ?? 0
  const folded = family?.folded ?? false
  const foldLabel = `${folded ? 'Show' : 'Hide'} the ${under} ${under === 1 ? 'session' : 'sessions'} under it`
  // the row's own claim on its meta slot, in the slot's order of urgency
  const ownRank = landed?.kind === 'asks' ? 3 : working ? 2 : landed ? 1 : 0
  // who drives it: marked only where Cockpit does — the exception in a tree mostly
  // read from terminals and the agents' own apps — and said in words either way
  const held = s.control?.holder === 'cockpit'
  const hold = s.control ? holdSentence(s.control, s.provider) : null
  return (
    <div
      className={`session-row ${selected ? 'selected' : ''} ${s.archived ? 'archived' : ''} ${chained ? 'chained' : ''}`}
      role="treeitem"
      aria-selected={selected}
      aria-level={level + depth}
      aria-expanded={under > 0 ? !folded : undefined}
      data-session-id={s.id}
      tabIndex={-1}
      title={`${PROVIDER_LABEL[s.provider]}${acct ? ` — ${acct.identity ?? acct.label}` : ''}\n${s.title}${s.gitBranch ? `\n⎇ ${s.gitBranch}` : ''}${parent ? `\nstarted by ${parent.title}` : ''}${hold ? `\n${hold}` : ''}\n~${s.messageCount} messages${landed ? `\n${landingLabel(landed)}` : ''}`}
      onClick={() => onSelect(s)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect(s)
        } else if (e.key === 'ArrowRight' && under > 0 && folded) {
          toggleFamily(s.id)
        } else if (e.key === 'ArrowLeft') {
          // an open family folds; anything else steps up to the session that started it
          if (under > 0 && !folded) toggleFamily(s.id)
          else if (parent) {
            // escaped: an id is the provider's own, and a quote or bracket in one made
            // this selector throw inside the key handler
            e.currentTarget
              .closest('[role="tree"]')
              ?.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(parent.id)}"]`)
              ?.focus()
          }
        }
      }}
    >
      {(chained || depth > 0) && (
        // deeper family rows step in by one indent per level, capped so a long chain
        // of sessions starting sessions can't push the title out of a narrow rail
        <span
          className="chain-elbow"
          aria-hidden="true"
          style={depth > 1 ? ({ '--depth': Math.min(depth, 3) } as CSSProperties) : undefined}
        >
          <ElbowIcon />
        </span>
      )}
      <ProviderMark p={s.provider} titled />
      <span className="session-title">{s.title}</span>
      {held && <HeldMark />}
      {/* archived reads as strikethrough + dim visually — say it out loud too.
          sr-only is position:absolute, so it costs no row width or gap */}
      {s.archived && <span className="sr-only">(archived)</span>}
      {/* the elbow is the only visual signal, so it can't be the only signal */}
      {chained && <span className="sr-only">(continued by the session above)</span>}
      {parent && <span className="sr-only">(started by {parent.title})</span>}
      {/* only the exception is marked: with two Claude homes, every default-account row
          wearing "claude-d…" spent a third of the title's width saying nothing */}
      {multiAccount && acct && !acct.isDefault && (
        <span className="acct-chip">
          {acct.label.startsWith(`${s.provider}-`) ? acct.label.slice(s.provider.length + 1) : acct.label}
        </span>
      )}
      {/* the fold trails the title rather than leading the row: a leading chevron would
          push the parent's logo off its siblings' and the elbows below off its logo.
          Not a Tab stop — like every row control, the keys are the row's own (→ / ←) */}
      {under > 0 && (
        <button
          className="family-toggle"
          aria-label={foldLabel}
          title={foldLabel}
          tabIndex={-1}
          onClick={(e) => {
            e.stopPropagation()
            toggleFamily(s.id)
          }}
        >
          <span className={`chev ${folded ? '' : 'open'}`} aria-hidden="true">
            ▸
          </span>
          {under}
        </button>
      )}
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
          <ArchiveIcon />
        </button>
      </span>
      {/* the row's one meta slot, in order of urgency: an agent waiting on you, then
          running, then a red PR or finished-while-you-were-away, then the branch's PR,
          then when it last moved — and a folded family lends the slot to a hidden row
          that outranks this one, so folding never hides an agent that needs you */}
      <span className="row-meta">
        {folded ? (
          <FoldedNews hidden={family?.descendants ?? []} outranks={ownRank}>
            <RowMeta s={s} pr={pr} working={working} landed={landed} timeFormat={timeFormat} onOpenUrl={onOpenUrl} />
          </FoldedNews>
        ) : (
          <RowMeta s={s} pr={pr} working={working} landed={landed} timeFormat={timeFormat} onOpenUrl={onOpenUrl} />
        )}
      </span>
    </div>
  )
})

/**
 * A row's exclusive meta slot, filled from its own state (see SessionRow) — the
 * palette's session options draw the same slot, with no PR and their own time class.
 */
export function RowMeta({
  s,
  pr,
  working,
  landed,
  timeFormat,
  timeClassName,
  onOpenUrl
}: {
  s: SessionMeta
  pr?: PrStatus
  working: boolean
  landed: Landing | null
  timeFormat: TimeFormat
  /** The class the last-moved time wears, where the list styles it (the palette) */
  timeClassName?: string
  onOpenUrl: (url: string) => void
}): JSX.Element {
  return landed?.kind === 'asks' ? (
    <LandingMark landing={landed} p={s.provider} />
  ) : working ? (
    <Spinner label={`${PROVIDER_LABEL[s.provider]} is working`} />
  ) : landed ? (
    <LandingMark landing={landed} p={s.provider} plainDot />
  ) : pr ? (
    <PrBadge pr={pr} onOpen={onOpenUrl} compact />
  ) : (
    <time className={timeClassName} dateTime={new Date(s.updatedAt).toISOString()}>
      {fmtTime(s.updatedAt, timeFormat)}
    </time>
  )
}

/**
 * The meta slot of a folded family's parent: the most urgent state among the rows the
 * fold hides — asking you, then running, then finished or a red PR — when it outranks
 * the parent's own, named after the session it belongs to; otherwise the parent's own
 * slot (`children`). Only folded parents subscribe to the whole busy and landed maps.
 */
function FoldedNews({
  hidden,
  outranks,
  children
}: {
  hidden: readonly SessionMeta[]
  outranks: number
  children: JSX.Element
}): JSX.Element {
  const busy = useBusyMap()
  const landings = useLandedMap()
  let best: { readonly s: SessionMeta; readonly rank: number; readonly landing: Landing | null } | null = null
  for (const h of hidden) {
    const landing = landings.get(h.id) ?? null
    const rank = landing?.kind === 'asks' ? 3 : busy.has(h.id) ? 2 : landing ? 1 : 0
    if (rank > (best?.rank ?? outranks)) best = { s: h, rank, landing }
  }
  if (!best) return children
  const why = best.rank === 2 || !best.landing ? `${PROVIDER_LABEL[best.s.provider]} is working` : landingLabel(best.landing)
  const label = `${best.s.title} — ${why}`
  return (
    <span className="folded-news" role="img" aria-label={label} title={label}>
      {best.rank === 2 || !best.landing ? (
        <Spinner />
      ) : (
        <LandingMark landing={best.landing} p={best.s.provider} mute plainDot />
      )}
    </span>
  )
}
