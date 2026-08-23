import { useCallback, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import type {
  CleanupBlock,
  CleanupReport,
  CleanupResult,
  Provider,
  StaleSession,
  StaleWorktree
} from '../../shared/types'
import { api } from './api'
import { useArmedConfirm } from './ConfirmRemove'
import {
  FilterBar,
  matchesFilters,
  type FilterGroup,
  type FilterOption
} from './FilterBar'
import { BranchChip, BranchIcon, ProviderLogo, PROVIDER_LABEL, RepoIcon } from './logos'
import { Select } from './Select'

/**
 * Cleanup: one place for everything that has gone quiet, across every agent and
 * every repository.
 *
 * The unit here is a piece of *work*, not a file. A session and the worktree it
 * ran in are one thing, so the worktree rides on its session's row and goes with
 * it — cleaning a transcript while leaving a 400MB abandoned checkout behind is
 * not a cleanup. The separate worktree list is what is left over: checkouts with
 * no session to tie them to.
 *
 * Two tiers, never blurred. Archive is Cockpit config and reversible — it hides a
 * session and reclaims nothing. Delete removes the agent's own log file, the
 * worktree, and the branch when git says it is fully merged.
 *
 * Rows arrive pre-judged from main (see cleanup.ts): this view never decides what
 * is stale or what is safe, it only lets the user choose among what it was given.
 */

/** Idle-threshold presets. Main clamps to a 7-day floor, so nothing below it here. */
const STALE_OPTIONS = [
  { value: '30', label: 'Idle over 30 days' },
  { value: '60', label: 'Idle over 60 days' },
  { value: '90', label: 'Idle over 90 days' },
  { value: '180', label: 'Idle over 6 months' },
  { value: '365', label: 'Idle over a year' }
]

/** Stands in for "no repository" as a filter value; a leading space keeps it out
 *  of the space of real repository names. */
const NO_REPO = ' none'
const DAY_MS = 86_400_000

const UNITS = [
  [1e9, 'GB'],
  [1e6, 'MB'],
  [1e3, 'KB']
] as const

/** One decimal at most, and never a bare `.0` — "400 MB", not "400.0 MB". */
function fmtBytes(n: number | null): string {
  if (n === null) return '—'
  for (const [scale, unit] of UNITS) {
    if (n >= scale) return `${Number((n / scale).toFixed(1))} ${unit}`
  }
  return `${n} B`
}

/** "idle 47d" / "idle 8mo" — coarse on purpose; this view is about abandonment. */
function fmtIdle(since: number, now: number): string {
  if (since <= 0) return 'never used'
  const days = Math.max(0, Math.floor((now - since) / DAY_MS))
  if (days < 60) return `idle ${days}d`
  if (days < 365) return `idle ${Math.round(days / 30)}mo`
  return `idle ${(days / 365).toFixed(1)}y`
}

const BLOCK_LABEL: Record<CleanupBlock, string> = {
  main: 'the repo’s own checkout',
  roundtable: 'a roundtable’s room',
  busy: 'an agent is running',
  dirty: 'uncommitted changes',
  locked: 'locked'
}

/* ---------- selection ---------- */

type Picks = {
  readonly picked: ReadonlySet<string>
  /** Toggle one row; `range` extends from the last row touched (shift-click) */
  readonly toggle: (index: number, on: boolean, range: boolean) => void
  readonly toggleAll: (on: boolean) => void
  readonly clear: () => void
  /** Selected rows the current filter actually shows */
  readonly shown: number
  readonly selectable: number
}

/**
 * Selection over the *filtered* rows, which is what makes "filter, then select
 * all" work: the master toggle only ever reaches what is on screen, while
 * selections made under a previous filter survive (and are disclosed as hidden).
 * Blocked rows are never selectable — not by click, not by range, not by the
 * master toggle — so nothing can be armed that main would only refuse.
 */
function usePicks<T>(
  rows: readonly T[],
  keyOf: (row: T) => string,
  blocked: (row: T) => boolean
): Picks {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set())
  const anchor = useRef<number | null>(null)

  const toggle = useCallback(
    (index: number, on: boolean, range: boolean): void => {
      // read the anchor here, not inside the updater: the updater runs during the
      // next render, by which point `anchor.current` is already this row and every
      // range would collapse to a single one
      const from = range && anchor.current !== null ? Math.min(anchor.current, index) : index
      const to = range && anchor.current !== null ? Math.max(anchor.current, index) : index
      anchor.current = index
      setPicked((prev) => {
        const next = new Set(prev)
        for (let i = from; i <= to; i++) {
          const row = rows[i]
          if (!row || blocked(row)) continue
          if (on) next.add(keyOf(row))
          else next.delete(keyOf(row))
        }
        return next
      })
    },
    [rows, keyOf, blocked]
  )

  const toggleAll = useCallback(
    (on: boolean): void => {
      setPicked((prev) => {
        const next = new Set(prev)
        for (const row of rows) {
          if (blocked(row)) continue
          if (on) next.add(keyOf(row))
          else next.delete(keyOf(row))
        }
        return next
      })
      anchor.current = null
    },
    [rows, keyOf, blocked]
  )

  const clear = useCallback((): void => {
    setPicked(new Set())
    anchor.current = null
  }, [])

  const selectable = rows.filter((r) => !blocked(r))
  return {
    picked,
    toggle,
    toggleAll,
    clear,
    shown: selectable.filter((r) => picked.has(keyOf(r))).length,
    selectable: selectable.length
  }
}

/* ---------- shared bits ---------- */

/**
 * A checkbox that can also read "some". Shift is taken off the native event so
 * range-select works from the keyboard (shift+space) exactly as it does from the
 * mouse — the click a checkbox synthesises carries the modifier either way.
 */
function Pick({
  checked,
  indeterminate,
  disabled,
  label,
  onPick
}: {
  checked: boolean
  indeterminate?: boolean
  disabled?: boolean
  label: string
  onPick: (on: boolean, range: boolean) => void
}): JSX.Element {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate === true
  }, [indeterminate])
  return (
    <input
      ref={ref}
      type="checkbox"
      className="cl-pick"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => onPick(e.target.checked, (e.nativeEvent as MouseEvent).shiftKey === true)}
    />
  )
}

/** The group's one control surface: master toggle, what is selected, what it frees. */
function GroupHead({
  picks,
  label,
  summary,
  children
}: {
  picks: Picks
  label: string
  summary: ReactNode
  children: ReactNode
}): JSX.Element {
  const all = picks.selectable > 0 && picks.shown === picks.selectable
  return (
    <div className="cl-head">
      <Pick
        checked={all}
        indeterminate={picks.shown > 0 && !all}
        disabled={picks.selectable === 0}
        label={all ? `Clear selection — ${label}` : `Select all shown — ${label}`}
        onPick={(on) => picks.toggleAll(on)}
      />
      <span className="cl-head-summary">{summary}</span>
      <div className="cl-head-actions">{children}</div>
    </div>
  )
}

/** Two-step destructive button: arms on first click, commits on second. */
function ArmedAction({
  id,
  armed,
  disabled,
  labels,
  confirm
}: {
  id: string
  armed: string | null
  disabled: boolean
  /** [resting, armed, tooltip on the armed state] */
  labels: readonly [string, string, string]
  confirm: {
    readonly arm: (id: string) => void
    readonly disarm: () => void
    readonly commit: () => void
  }
}): JSX.Element {
  const [idle, live, title] = labels
  if (armed !== id) {
    return (
      <button className="btn-ghost danger" disabled={disabled} onClick={() => confirm.arm(id)}>
        {idle}
      </button>
    )
  }
  return (
    <button
      className="btn-danger"
      title={title}
      onBlur={confirm.disarm}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          confirm.disarm()
        }
      }}
      onClick={confirm.commit}
    >
      {live}
    </button>
  )
}

/* ---------- rows ---------- */

function SessionRow({
  s,
  now,
  picked,
  onPick
}: {
  s: StaleSession
  now: number
  picked: boolean
  onPick: (on: boolean, range: boolean) => void
}): JSX.Element {
  const w = s.worktree
  return (
    <li className={`cl-row tint-${s.provider} ${picked ? 'picked' : ''}`}>
      <Pick
        checked={picked}
        disabled={s.blocks.length > 0}
        label={`Select session ${s.title}`}
        onPick={onPick}
      />
      <span className={`plogo plogo-${s.provider}`} aria-hidden="true">
        <ProviderLogo p={s.provider} size={13} />
      </span>
      <div className="cl-body">
        <div className="cl-title" title={s.title}>
          {s.title || `${PROVIDER_LABEL[s.provider]} session`}
          {s.archived && <span className="cl-tag">archived</span>}
        </div>
        <div className="cl-sub">
          {s.repoName ?? 'no repository'}
          {w ? (
            <span
              className="cl-carry"
              title={
                w.sessionCount > 1
                  ? `${w.path} — shared with ${w.sessionCount - 1} other session${
                      w.sessionCount === 2 ? '' : 's'
                    }; only removed when all of them are`
                  : `${w.path} — removed with this session`
              }
            >
              <BranchIcon size={10} />
              takes its worktree · {fmtBytes(w.bytes)}
              {w.sessionCount > 1 && <span className="cl-shared"> · shared ×{w.sessionCount}</span>}
            </span>
          ) : (
            s.cwd && (
              <span className="cl-path" title={s.cwd}>
                {' · '}
                {s.cwd}
              </span>
            )
          )}
        </div>
      </div>
      <div className="cl-meta">
        {s.blocks.map((b) => (
          <span key={b} className="cl-block">
            {BLOCK_LABEL[b]}
          </span>
        ))}
        <span className="cl-size">{fmtBytes(s.bytes)}</span>
        <time dateTime={new Date(s.updatedAt).toISOString()}>{fmtIdle(s.updatedAt, now)}</time>
      </div>
    </li>
  )
}

function WorktreeRow({
  w,
  now,
  picked,
  onPick
}: {
  w: StaleWorktree
  now: number
  picked: boolean
  onPick: (on: boolean, range: boolean) => void
}): JSX.Element {
  return (
    <li className={`cl-row ${picked ? 'picked' : ''}`}>
      <Pick
        checked={picked}
        disabled={w.blocks.length > 0}
        label={`Select worktree ${w.path}`}
        onPick={onPick}
      />
      <span className="repo-icon" aria-hidden="true">
        <RepoIcon size={13} />
      </span>
      <div className="cl-body">
        <div className="cl-title">
          {w.repoName}
          <span className={`cl-origin cl-origin-${w.origin}`}>
            {w.origin === 'cockpit' ? 'cockpit' : 'external'}
          </span>
          {w.branch && <BranchChip branch={w.branch} />}
          {w.missing && <span className="cl-tag">directory gone</span>}
        </div>
        <div className="cl-sub cl-path" title={w.path}>
          {w.path}
        </div>
      </div>
      <div className="cl-meta">
        {w.blocks.map((b) => (
          <span key={b} className="cl-block">
            {BLOCK_LABEL[b]}
          </span>
        ))}
        {w.unpushed > 0 && (
          <span
            className="cl-unpushed"
            title="Commits no remote has — the branch is kept unless git says it is fully merged"
          >
            {w.unpushed} unpushed
          </span>
        )}
        {w.sessionCount > 0 && <span className="repo-count">{w.sessionCount}</span>}
        <span className="cl-size">{fmtBytes(w.bytes)}</span>
        <time dateTime={new Date(w.lastActivity || now).toISOString()}>
          {fmtIdle(w.lastActivity, now)}
        </time>
      </div>
    </li>
  )
}

/* ---------- what a selection actually frees ---------- */

/**
 * Bytes the selection would reclaim, and how many worktrees go with it. A shared
 * worktree counts once, and only when every session indexed in it is picked — the
 * same rule main applies, so the number beside the button is the truth.
 */
function reclaim(
  rows: readonly StaleSession[],
  picked: ReadonlySet<string>
): { readonly bytes: number; readonly trees: number } {
  let bytes = 0
  const trees = new Map<string, { picked: number; of: number; bytes: number }>()
  for (const s of rows) {
    const on = picked.has(s.id)
    if (on) bytes += s.bytes
    if (!s.worktree) continue
    const e = trees.get(s.worktree.path) ?? {
      picked: 0,
      of: s.worktree.sessionCount,
      bytes: s.worktree.bytes ?? 0
    }
    if (on) e.picked++
    trees.set(s.worktree.path, e)
  }
  let n = 0
  for (const e of trees.values()) {
    if (e.picked > 0 && e.picked >= e.of) {
      bytes += e.bytes
      n++
    }
  }
  return { bytes, trees: n }
}

/* ---------- filter dimensions ---------- */

type Selections = Record<string, { readonly included: readonly string[]; readonly excluded: readonly string[] }>

const NONE: readonly string[] = []

/** Bind one dimension to a slot of the selections record. */
function dimension(
  sel: Selections,
  set: (fn: (prev: Selections) => Selections) => void
): (id: string, label: string, options: FilterOption[]) => FilterGroup {
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
function sessionValues(s: StaleSession, groupId: string): readonly string[] {
  if (groupId === 'agent') return [s.provider]
  if (groupId === 'project') return [s.repoName ?? NO_REPO]
  const state: string[] = []
  if (s.archived) state.push('archived')
  state.push(s.worktree ? 'worktree' : 'no-worktree')
  if (s.blocks.length > 0) state.push('blocked')
  return state
}

function worktreeValues(w: StaleWorktree, groupId: string): readonly string[] {
  if (groupId === 'project') return [w.repoName]
  if (groupId === 'origin') return [w.origin]
  const state: string[] = [w.blocks.length > 0 ? 'blocked' : 'removable']
  if (w.missing) state.push('missing')
  if (w.unpushed > 0) state.push('unpushed')
  return state
}

/** Options are derived from the rows themselves, so a dimension never offers a
 *  value that would match nothing. */
function presentOptions<T>(rows: readonly T[], of: (row: T) => string): string[] {
  return [...new Set(rows.map(of))].sort()
}

function sessionFilters(
  rows: readonly StaleSession[],
  sel: Selections,
  set: (fn: (prev: Selections) => Selections) => void
): FilterGroup[] {
  const dim = dimension(sel, set)
  return [
    dim(
      'agent',
      'Agent',
      presentOptions(rows, (s) => s.provider).map((p) => ({
        value: p,
        label: PROVIDER_LABEL[p as Provider],
        icon: (
          <span className={`plogo plogo-${p}`} aria-hidden="true">
            <ProviderLogo p={p as Provider} size={11} />
          </span>
        )
      }))
    ),
    dim(
      'project',
      'Project',
      presentOptions(rows, (s) => s.repoName ?? NO_REPO).map((r) => ({
        value: r,
        label: r === NO_REPO ? 'No repository' : r
      }))
    ),
    dim('state', 'State', [
      { value: 'worktree', label: 'Has a worktree' },
      { value: 'no-worktree', label: 'No worktree' },
      { value: 'archived', label: 'Archived' },
      { value: 'blocked', label: 'Blocked' }
    ])
  ]
}

function worktreeFilters(
  rows: readonly StaleWorktree[],
  sel: Selections,
  set: (fn: (prev: Selections) => Selections) => void
): FilterGroup[] {
  const dim = dimension(sel, set)
  return [
    dim('origin', 'Origin', [
      { value: 'cockpit', label: 'Cut by Cockpit' },
      { value: 'external', label: 'External' }
    ]),
    dim(
      'project',
      'Project',
      presentOptions(rows, (w) => w.repoName).map((r) => ({ value: r, label: r }))
    ),
    dim('state', 'State', [
      { value: 'removable', label: 'Removable' },
      { value: 'blocked', label: 'Blocked' },
      { value: 'unpushed', label: 'Has unpushed commits' },
      { value: 'missing', label: 'Directory gone' }
    ])
  ]
}

/* ---------- the view ---------- */

export function CleanupView({ onClose }: { onClose: () => void }): JSX.Element {
  const [report, setReport] = useState<CleanupReport | null>(null)
  const [staleDays, setStaleDays] = useState('30')
  const [scanning, setScanning] = useState(true)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const armed = useArmedConfirm()
  const headingRef = useRef<HTMLHeadingElement>(null)

  const [sq, setSq] = useState('')
  const [wq, setWq] = useState('')
  // one include/exclude pair per dimension, keyed by group id — the bar owns no state
  const [sSel, setSSel] = useState<Selections>({})
  const [wSel, setWSel] = useState<Selections>({})

  const sessions = useMemo(() => report?.sessions ?? [], [report])
  const worktrees = useMemo(() => report?.worktrees ?? [], [report])

  const sessionGroups = useMemo(
    () => sessionFilters(sessions, sSel, setSSel),
    [sessions, sSel]
  )
  const treeGroups = useMemo(() => worktreeFilters(worktrees, wSel, setWSel), [worktrees, wSel])

  const shownSessions = useMemo(() => {
    const q = sq.trim().toLowerCase()
    return sessions.filter((s) => {
      if (!matchesFilters(sessionGroups, (id) => sessionValues(s, id))) return false
      if (!q) return true
      return `${s.title} ${s.repoName ?? ''} ${s.cwd ?? ''}`.toLowerCase().includes(q)
    })
  }, [sessions, sq, sessionGroups])

  const shownWorktrees = useMemo(() => {
    const q = wq.trim().toLowerCase()
    return worktrees.filter((w) => {
      if (!matchesFilters(treeGroups, (id) => worktreeValues(w, id))) return false
      if (!q) return true
      return `${w.repoName} ${w.branch ?? ''} ${w.path}`.toLowerCase().includes(q)
    })
  }, [worktrees, wq, treeGroups])

  const sessionKey = useCallback((s: StaleSession) => s.id, [])
  const sessionBlocked = useCallback((s: StaleSession) => s.blocks.length > 0, [])
  const treeKey = useCallback((w: StaleWorktree) => w.path, [])
  const treeBlocked = useCallback((w: StaleWorktree) => w.blocks.length > 0, [])
  const sPicks = usePicks(shownSessions, sessionKey, sessionBlocked)
  const wPicks = usePicks(shownWorktrees, treeKey, treeBlocked)

  const scan = useCallback(async (): Promise<void> => {
    setScanning(true)
    setError(null)
    try {
      const r = await api.scanCleanup()
      setReport(r)
      setStaleDays(String(r.staleDays))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setScanning(false)
    }
  }, [])

  useEffect(() => {
    headingRef.current?.focus()
    void scan()
  }, [scan])

  const changeThreshold = async (days: string): Promise<void> => {
    setStaleDays(days)
    await api.setStaleDays(Number(days))
    sPicks.clear()
    wPicks.clear()
    await scan()
  }

  /** Every action ends the same way: re-scan the truth, then report what happened. */
  const run = async (verb: string, action: () => Promise<CleanupResult>): Promise<void> => {
    setWorking(true)
    setError(null)
    armed.disarm()
    try {
      const res = await action()
      // the rescan comes first: it clears the previous error, so a refusal reported
      // before it would be wiped off the screen the moment the truth came back
      sPicks.clear()
      wPicks.clear()
      await scan()
      const failed = res.failed.length
      const freed = res.freedBytes > 0 ? ` · ${fmtBytes(res.freedBytes)} freed` : ''
      const branches = res.branchesDeleted?.length
        ? ` · ${res.branchesDeleted.length} merged branch${
            res.branchesDeleted.length === 1 ? '' : 'es'
          } deleted`
        : ''
      setStatus(`${verb} ${res.cleaned}${freed}${branches}${failed ? ` · ${failed} kept` : ''}`)
      if (failed) setError(res.failed.map((f) => `${f.target} — ${f.reason}`).join('\n'))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWorking(false)
    }
  }

  const sPicked = sPicks.picked
  const wPicked = wPicks.picked
  const gain = reclaim(sessions, sPicked)
  const hiddenSessions = sPicked.size - sPicks.shown
  const treeGain = shownWorktrees
    .filter((w) => wPicked.has(w.path))
    .reduce((n, w) => n + (w.bytes ?? 0), 0)
  const hiddenTrees = wPicked.size - wPicks.shown
  const truncated = (report?.staleSessionCount ?? 0) > sessions.length
  const now = report?.scannedAt ?? Date.now()

  return (
    <main className="chat settings-view">
      <div className="ns-card">
        <div className="ns-head">
          <h2 ref={headingRef} tabIndex={-1}>
            Cleanup
          </h2>
          <button className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="ns-hint">
          What has gone quiet, across every agent and every repository. Deleting a session takes
          the worktree it ran in with it, and the branch when git reports that branch as fully
          merged. Archiving only hides a session in Cockpit — it frees nothing.
        </p>

        <div className="ns-options">
          <div className="ns-opt">
            <label className="ns-label" htmlFor="stale-days">
              Idle threshold
            </label>
            <Select
              id="stale-days"
              ariaLabel="Idle threshold"
              value={staleDays}
              options={STALE_OPTIONS}
              onChange={(v) => void changeThreshold(v)}
            />
          </div>
          <div className="ns-opt cl-rescan">
            <button className="btn-ghost" disabled={scanning || working} onClick={() => void scan()}>
              {scanning ? 'Scanning…' : 'Rescan'}
            </button>
          </div>
        </div>

        <p className="ns-hint" aria-live="polite">
          {scanning ? (
            <>
              <span className="pulse" aria-hidden="true" /> Walking every source and repository…
            </>
          ) : report ? (
            <>
              {report.staleSessionCount} of {report.totalSessions} sessions ·{' '}
              {fmtBytes(report.staleSessionBytes)} · {report.staleWorktreeCount} of{' '}
              {report.totalWorktrees} worktrees{status && ` — ${status}`}
            </>
          ) : (
            status
          )}
        </p>

        <h3 className="ns-label">Stale sessions</h3>
        {sessions.length === 0 && !scanning ? (
          <p className="ns-hint">Nothing idle that long — every session is still recent.</p>
        ) : (
          <>
            <FilterBar
              groups={sessionGroups}
              defaultPinned={['agent', 'project']}
              search={{
                value: sq,
                onChange: setSq,
                label: 'Filter sessions',
                placeholder: 'Filter by title, project or path…'
              }}
            />

            <GroupHead
              picks={sPicks}
              label="stale sessions"
              summary={
                sPicked.size > 0 ? (
                  <>
                    <strong>{sPicked.size}</strong> selected · {fmtBytes(gain.bytes)}
                    {gain.trees > 0 && ` · ${gain.trees} worktree${gain.trees === 1 ? '' : 's'}`}
                    {hiddenSessions > 0 && (
                      <span className="cl-hidden"> · {hiddenSessions} not shown</span>
                    )}
                  </>
                ) : (
                  <>
                    {shownSessions.length} shown
                    {shownSessions.length !== sessions.length && ` of ${sessions.length}`}
                  </>
                )
              }
            >
              <button
                className="btn-ghost"
                disabled={working || sPicked.size === 0}
                title="Hides them in Cockpit. Nothing on disk is touched."
                onClick={() => void run('Archived', () => api.archiveSessions([...sPicked]))}
              >
                Archive{sPicked.size > 0 ? ` ${sPicked.size}` : ''}
              </button>
              <ArmedAction
                id="sessions"
                armed={armed.armed}
                disabled={working || sPicked.size === 0}
                labels={[
                  sPicked.size > 0 ? `Delete ${sPicked.size}…` : 'Delete…',
                  `Delete ${sPicked.size} for good?`,
                  "Deletes the agents' own log files, the worktrees these sessions ran in, and any branch git reports as fully merged. This cannot be undone."
                ]}
                confirm={{
                  arm: armed.arm,
                  disarm: armed.disarm,
                  commit: () => void run('Deleted', () => api.deleteSessions([...sPicked]))
                }}
              />
            </GroupHead>

            {shownSessions.length === 0 ? (
              <p className="ns-hint cl-empty">No sessions match this filter.</p>
            ) : (
              <ul className="source-list cl-list">
                {shownSessions.map((s, i) => (
                  <SessionRow
                    key={s.id}
                    s={s}
                    now={now}
                    picked={sPicked.has(s.id)}
                    onPick={(on, range) => sPicks.toggle(i, on, range)}
                  />
                ))}
              </ul>
            )}
            {truncated && (
              <p className="ns-hint">
                Showing the {sessions.length} oldest of {report?.staleSessionCount} — clean these,
                then rescan for the rest.
              </p>
            )}
          </>
        )}

        <h3 className="ns-label">Worktrees with no session</h3>
        {worktrees.length === 0 && !scanning ? (
          <p className="ns-hint">
            No leftovers — every stale worktree belongs to a session above, or is still in use.
          </p>
        ) : (
          <>
            <p className="ns-hint">
              Checkouts nothing in the list above claims, including ones Cockpit never cut.
              Removing one keeps its branch unless git reports it as fully merged.
            </p>
            <FilterBar
              groups={treeGroups}
              defaultPinned={['origin', 'state']}
              search={{
                value: wq,
                onChange: setWq,
                label: 'Filter worktrees',
                placeholder: 'Filter by project, branch or path…'
              }}
            />

            <GroupHead
              picks={wPicks}
              label="worktrees"
              summary={
                wPicked.size > 0 ? (
                  <>
                    <strong>{wPicked.size}</strong> selected · {fmtBytes(treeGain)}
                    {hiddenTrees > 0 && (
                      <span className="cl-hidden"> · {hiddenTrees} not shown</span>
                    )}
                  </>
                ) : (
                  <>
                    {shownWorktrees.length} shown
                    {shownWorktrees.length !== worktrees.length && ` of ${worktrees.length}`}
                  </>
                )
              }
            >
              <ArmedAction
                id="worktrees"
                armed={armed.armed}
                disabled={working || wPicked.size === 0}
                labels={[
                  wPicked.size > 0 ? `Remove ${wPicked.size}…` : 'Remove…',
                  `Remove ${wPicked.size} worktree${wPicked.size === 1 ? '' : 's'}?`,
                  'Runs git worktree remove on each — the directory goes, the branch stays unless git says it is fully merged.'
                ]}
                confirm={{
                  arm: armed.arm,
                  disarm: armed.disarm,
                  commit: () => void run('Removed', () => api.removeWorktrees([...wPicked]))
                }}
              />
            </GroupHead>

            {shownWorktrees.length === 0 ? (
              <p className="ns-hint cl-empty">No worktrees match this filter.</p>
            ) : (
              <ul className="source-list cl-list">
                {shownWorktrees.map((w, i) => (
                  <WorktreeRow
                    key={w.path}
                    w={w}
                    now={now}
                    picked={wPicked.has(w.path)}
                    onPick={(on, range) => wPicks.toggle(i, on, range)}
                  />
                ))}
              </ul>
            )}
          </>
        )}

        {error && (
          <div role="alert" className="new-error">
            {error}
          </div>
        )}
      </div>
    </main>
  )
}
