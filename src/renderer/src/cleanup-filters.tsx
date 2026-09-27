import type { Provider, StaleSession, StaleTable, StaleWorktree } from '../../shared/types'
import type { FilterGroup, FilterOption } from './FilterBar'
import { ProviderMark, PROVIDER_LABEL } from './logos'

/**
 * The Cleanup view's filter dimensions: what each list can be narrowed by, and the
 * values each row carries for them (see `matchesFilters`). The bar owns no state —
 * every include/exclude pair lives in the view's `Selections`, so a filter survives
 * the tab switch that remounts its bar.
 */

/** Stands in for "no repository" as a filter value; a leading space keeps it out
 *  of the space of real repository names. */
const NO_REPO = ' none'

/** One include/exclude pair per dimension, keyed by group id. */
export type Selections = Record<
  string,
  { readonly included: readonly string[]; readonly excluded: readonly string[] }
>
export type SetSelections = (fn: (prev: Selections) => Selections) => void

const NONE: readonly string[] = []

type Dim = (id: string, label: string, options: FilterOption[]) => FilterGroup

/** Bind one dimension to a slot of the selections record. */
function dimension(sel: Selections, set: SetSelections): Dim {
  return (id, label, options) => ({
    id,
    label,
    options,
    included: sel[id]?.included ?? NONE,
    excluded: sel[id]?.excluded ?? NONE,
    onChange: (included, excluded) => set((prev) => ({ ...prev, [id]: { included, excluded } }))
  })
}

/** Every value a session carries for a dimension (see matchesFilters). */
export function sessionValues(s: StaleSession, groupId: string): readonly string[] {
  if (groupId === 'agent') return [s.provider]
  if (groupId === 'project') return [s.repoName ?? NO_REPO]
  const state: string[] = []
  if (s.archived) state.push('archived')
  state.push(s.worktree ? 'worktree' : 'no-worktree')
  if (s.blocks.length > 0) state.push('blocked')
  return state
}

export function tableValues(t: StaleTable, groupId: string): readonly string[] {
  if (groupId === 'agent') return t.providers
  if (groupId === 'project') return [t.repoName ?? NO_REPO]
  const state: string[] = []
  if (t.archived) state.push('archived')
  state.push(t.worktree ? 'worktree' : 'room')
  if (t.blocks.length > 0) state.push('blocked')
  return state
}

export function worktreeValues(w: StaleWorktree, groupId: string): readonly string[] {
  if (groupId === 'project') return [w.repoName]
  if (groupId === 'origin') return [w.origin]
  const state: string[] = [w.blocks.length > 0 ? 'blocked' : 'removable']
  if (w.missing) state.push('missing')
  if (w.unpushed > 0) state.push('unpushed')
  return state
}

/** Options are derived from the rows themselves, so a dimension never offers a
 *  value that would match nothing. */
function presentOptions<T, V extends string>(rows: readonly T[], of: (row: T) => V): V[] {
  return [...new Set(rows.map(of))].sort()
}

/** The Agent dimension over every agent the rows carry, each with its logo. */
function agentDim(dim: Dim, agents: readonly Provider[]): FilterGroup {
  return dim(
    'agent',
    'Agent',
    presentOptions(agents, (p) => p).map((p) => ({
      value: p,
      label: PROVIDER_LABEL[p],
      icon: (
        <ProviderMark p={p} size={11} decorative />
      )
    }))
  )
}

/** The Project dimension over every repository the rows carry — none is a value too. */
function projectDim(dim: Dim, repos: readonly (string | null)[]): FilterGroup {
  return dim(
    'project',
    'Project',
    presentOptions(repos, (r) => r ?? NO_REPO).map((r) => ({
      value: r,
      label: r === NO_REPO ? 'No repository' : r
    }))
  )
}

export function sessionFilters(
  rows: readonly StaleSession[],
  sel: Selections,
  set: SetSelections
): FilterGroup[] {
  const dim = dimension(sel, set)
  return [
    agentDim(dim, rows.map((s) => s.provider)),
    projectDim(dim, rows.map((s) => s.repoName)),
    dim('state', 'State', [
      { value: 'worktree', label: 'Has a worktree' },
      { value: 'no-worktree', label: 'No worktree' },
      { value: 'archived', label: 'Archived' },
      { value: 'blocked', label: 'Blocked' }
    ])
  ]
}

export function tableFilters(
  rows: readonly StaleTable[],
  sel: Selections,
  set: SetSelections
): FilterGroup[] {
  const dim = dimension(sel, set)
  return [
    // a seat's agent, so a table shows up under every agent sitting at it
    agentDim(dim, rows.flatMap((t) => [...t.providers])),
    projectDim(dim, rows.map((t) => t.repoName)),
    dim('state', 'State', [
      { value: 'worktree', label: 'Has a worktree' },
      { value: 'room', label: 'Scratch room' },
      { value: 'archived', label: 'Archived' },
      { value: 'blocked', label: 'Blocked' }
    ])
  ]
}

export function worktreeFilters(
  rows: readonly StaleWorktree[],
  sel: Selections,
  set: SetSelections
): FilterGroup[] {
  const dim = dimension(sel, set)
  return [
    dim('origin', 'Origin', [
      { value: 'cockpit', label: 'Cut by Cockpit' },
      { value: 'external', label: 'External' }
    ]),
    projectDim(dim, rows.map((w) => w.repoName)),
    dim('state', 'State', [
      { value: 'removable', label: 'Removable' },
      { value: 'blocked', label: 'Blocked' },
      { value: 'unpushed', label: 'Has unpushed commits' },
      { value: 'missing', label: 'Directory gone' }
    ])
  ]
}
