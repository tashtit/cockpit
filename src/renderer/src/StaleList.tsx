import { useMemo, useState, type JSX, type ReactNode } from 'react'
import { formatBytes } from '../../shared/cleanup'
import type { Selections, SetSelections } from './cleanup-filters'
import { usePicks, type Picks } from './cleanup-picks'
import { GroupHead, type RowProps } from './CleanupRows'
import { FilterBar, matchesFilters, type FilterGroup } from './FilterBar'
import { plural } from './format'

/** What a selection would free: its bytes, and how many worktrees go along with it. */
export type Freed = { readonly bytes: number; readonly trees: number }

/**
 * Everything one of Cleanup's filtered lists is made of — Sessions, Roundtables and
 * Worktrees differ only here, and share the shape: a filter bar, a head saying what
 * is picked and what it frees, the head's actions, the rows. Declare a config at
 * module level: its functions are identities the picks and the filter memo depend on.
 */
export type StaleListConfig<T> = {
  /** A row's pick key */
  readonly key: (row: T) => string
  /** A blocked row is unselectable by every path — click, range and master toggle */
  readonly blocked: (row: T) => boolean
  /** What the free-text filter searches */
  readonly text: (row: T) => string
  readonly filters: (rows: readonly T[], sel: Selections, set: SetSelections) => FilterGroup[]
  /** Every value a row carries for a dimension (see matchesFilters) */
  readonly values: (row: T, groupId: string) => readonly string[]
  /** What the picked rows would free, out of every row and the shown ones */
  readonly frees: (all: readonly T[], shown: readonly T[], picked: ReadonlySet<string>) => Freed
  readonly Row: (props: RowProps<T>) => JSX.Element
  /** The sentence for a scan that found nothing at all */
  readonly empty: string
  /** The panel's opening prose: what the list holds, what acting on it takes */
  readonly about: ReactNode
  readonly bar: {
    readonly defaultPinned: readonly string[]
    /** The free-text box's name and placeholder */
    readonly label: string
    readonly placeholder: string
  }
  /** What the head's master toggle names: "Select all shown — stale sessions" */
  readonly head: string
  /** Nothing shown while the scan is still walking — "not read yet", never a verdict */
  readonly reading: string
  /** Nothing shown once it has landed: the filter matches nothing */
  readonly noMatch: string
}

/** One list's live state — see `useStaleList`. */
export type StaleListState<T> = {
  readonly all: readonly T[]
  /** The rows the filter bar and the free text let through */
  readonly shown: readonly T[]
  readonly groups: readonly FilterGroup[]
  readonly query: string
  readonly setQuery: (query: string) => void
  readonly picks: Picks
}

/**
 * One list's query, filter selections and picks, filtered down to what is shown. It
 * belongs to the view, not the panel: the card tabs remount a panel on every switch,
 * and a query, a filter and a selection all outlive one.
 */
export function useStaleList<T>(rows: readonly T[], config: StaleListConfig<T>): StaleListState<T> {
  const { key, blocked, text, filters, values } = config
  const [query, setQuery] = useState('')
  // one include/exclude pair per dimension, keyed by group id — the bar owns no state
  const [sel, setSel] = useState<Selections>({})

  const groups = useMemo(() => filters(rows, sel, setSel), [filters, rows, sel])

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((row) => {
      if (!matchesFilters(groups, (id) => values(row, id))) return false
      if (!q) return true
      return text(row).toLowerCase().includes(q)
    })
  }, [rows, query, groups, values, text])

  const picks = usePicks(shown, key, blocked)
  return { all: rows, shown, groups, query, setQuery, picks }
}

/**
 * A list's panel: its prose, its filter bar, the head — what is picked, what that
 * frees, what is picked but filtered out of sight, and `children`, the actions on
 * the pick — then the rows. An empty list before the scan lands is "not read yet",
 * never a verdict.
 */
export function StaleList<T>({
  config,
  list,
  now,
  scanning,
  footer,
  children
}: {
  readonly config: StaleListConfig<T>
  readonly list: StaleListState<T>
  /** When the scan measured the rows, which is what their ages count from */
  readonly now: number
  readonly scanning: boolean
  /** Under the rows — the notice that the list is capped */
  readonly footer?: ReactNode
  readonly children: ReactNode
}): JSX.Element {
  const { all, shown, groups, query, setQuery, picks } = list
  if (all.length === 0 && !scanning) return <p className="ns-hint">{config.empty}</p>

  const picked = picks.picked
  const gain = config.frees(all, shown, picked)
  const hidden = picked.size - picks.shown
  const { Row } = config
  return (
    <>
      <p className="ns-hint">{config.about}</p>
      <FilterBar
        groups={groups}
        defaultPinned={config.bar.defaultPinned}
        search={{
          value: query,
          onChange: setQuery,
          label: config.bar.label,
          placeholder: config.bar.placeholder
        }}
      />

      <GroupHead
        picks={picks}
        label={config.head}
        summary={
          picked.size > 0 ? (
            <>
              <strong>{picked.size}</strong> selected · {formatBytes(gain.bytes)}
              {gain.trees > 0 && ` · ${plural(gain.trees, 'worktree')}`}
              {hidden > 0 && <span className="cl-hidden"> · {hidden} not shown</span>}
            </>
          ) : (
            <>
              {shown.length} shown
              {shown.length !== all.length && ` of ${all.length}`}
            </>
          )
        }
      >
        {children}
      </GroupHead>

      {shown.length === 0 ? (
        <p className="ns-hint cl-empty">{scanning ? config.reading : config.noMatch}</p>
      ) : (
        <ul className="source-list cl-list">
          {shown.map((row, i) => (
            <Row
              key={config.key(row)}
              row={row}
              now={now}
              picked={picked.has(config.key(row))}
              onPick={(on, range) => picks.toggle(i, on, range)}
            />
          ))}
        </ul>
      )}
      {footer}
    </>
  )
}
