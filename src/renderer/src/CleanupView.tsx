import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type {
  CleanupReport,
  CleanupResult,
  OrphanProcess,
  StaleSession,
  StaleTable,
  StaleWorktree
} from '../../shared/types'
import { api } from './api'
import {
  sessionFilters,
  sessionValues,
  tableFilters,
  tableValues,
  worktreeFilters,
  worktreeValues
} from './cleanup-filters'
import { usePicks } from './cleanup-picks'
import {
  GroupHead,
  ProcessGroup,
  ProcessRow,
  SessionRow,
  TableRow,
  WorktreeRow
} from './CleanupRows'
import { ArmedButton, useArmedConfirm } from './ConfirmRemove'
import { Select } from './Select'
import { StaleList, useStaleList, type Freed, type StaleListConfig } from './StaleList'
import { TabList, TabPanel } from './Tabs'
import { formatBytes } from '../../shared/cleanup'

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

/**
 * The card's tabs, in order — one list each. Four lists on one page read as a single
 * long scroll, so each is its own panel, and the counts on the tabs say where the work
 * is without opening them.
 */
const CLEANUP_SECTIONS = [
  { id: 'sessions', label: 'Sessions' },
  { id: 'processes', label: 'Processes' },
  { id: 'tables', label: 'Roundtables' },
  { id: 'worktrees', label: 'Worktrees' }
] as const
type CleanupSection = (typeof CLEANUP_SECTIONS)[number]['id']

/** How many rows each tab holds — the counts its pill carries. */
function sectionCounts(r: CleanupReport | null): Record<CleanupSection, number> {
  return {
    sessions: r?.sessions.length ?? 0,
    processes: r?.processes.length ?? 0,
    tables: r?.tables.length ?? 0,
    worktrees: r?.worktrees.length ?? 0
  }
}

/** A list's destructive button at rest: "Delete 3…", or "Delete…" with nothing picked. */
function counted(verb: string, n: number): string {
  return n > 0 ? `${verb} ${n}…` : `${verb}…`
}

/* ---------- what a selection actually frees ---------- */

/**
 * Bytes the selection would reclaim, and how many worktrees go with it. A shared
 * worktree counts once, and only when every session indexed in it is picked — the
 * same rule main applies, so the number beside the button is the truth.
 */
function reclaim(rows: readonly StaleSession[], picked: ReadonlySet<string>): Freed {
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

/** A table or a leftover worktree frees just itself: the picked rows on screen. */
function shownBytes<T>(
  key: (row: T) => string,
  bytes: (row: T) => number | null
): StaleListConfig<T>['frees'] {
  return (_all, shown, picked) => ({
    bytes: shown.filter((row) => picked.has(key(row))).reduce((n, row) => n + (bytes(row) ?? 0), 0),
    trees: 0
  })
}

/* ---------- the lists ---------- */

const sessionKey = (s: StaleSession): string => s.id
const tableKey = (t: StaleTable): string => t.id
const treeKey = (w: StaleWorktree): string => w.path
const processKey = (p: OrphanProcess): string => String(p.pid)

const SESSIONS: StaleListConfig<StaleSession> = {
  key: sessionKey,
  blocked: (s) => s.blocks.length > 0,
  text: (s) => `${s.title} ${s.repoName ?? ''} ${s.cwd ?? ''}`,
  filters: sessionFilters,
  values: sessionValues,
  // every session, not just the shown ones: a shared worktree goes only with all of them
  frees: (all, _shown, picked) => reclaim(all, picked),
  Row: SessionRow,
  empty: 'Nothing idle that long — every session is still recent.',
  about: (
    <>
      Deleting a session takes the worktree it ran in with it, and the branch when git
      reports that branch as fully merged. Archiving only hides a session in Cockpit — it
      frees nothing.
    </>
  ),
  bar: {
    defaultPinned: ['agent', 'project'],
    label: 'Filter sessions',
    placeholder: 'Filter by title, project or path…'
  },
  head: 'stale sessions',
  reading: 'Still reading every source…',
  noMatch: 'No sessions match this filter.'
}

const TABLES: StaleListConfig<StaleTable> = {
  key: tableKey,
  blocked: (t) => t.blocks.length > 0,
  text: (t) => `${t.title} ${t.repoName ?? ''} ${t.cwd}`,
  filters: tableFilters,
  values: tableValues,
  frees: shownBytes(tableKey, (t) => t.bytes),
  Row: TableRow,
  empty: 'No table archived, and none gone quiet that long — every roundtable is recent.',
  about: (
    <>
      Tables nobody has spoken to in a while, plus every table you archived — that is
      already a decision, so it needs no waiting. Deleting one takes the seat sessions
      that ran inside it and the room it ran in — its worktree and, when git reports the
      branch fully merged, that too.
    </>
  ),
  bar: {
    defaultPinned: ['agent', 'state'],
    label: 'Filter roundtables',
    placeholder: 'Filter by topic, project or path…'
  },
  head: 'roundtables',
  reading: 'Still reading every table…',
  noMatch: 'No roundtables match this filter.'
}

const WORKTREES: StaleListConfig<StaleWorktree> = {
  key: treeKey,
  blocked: (w) => w.blocks.length > 0,
  text: (w) => `${w.repoName} ${w.branch ?? ''} ${w.path}`,
  filters: worktreeFilters,
  values: worktreeValues,
  frees: shownBytes(treeKey, (w) => w.bytes),
  Row: WorktreeRow,
  empty: 'No leftovers — every stale worktree belongs to a stale session, or is still in use.',
  about: (
    <>
      Checkouts no stale session claims, including ones Cockpit never cut — a session’s
      own worktree goes with it, under Sessions. Removing one keeps its branch unless git
      reports it as fully merged.
    </>
  ),
  bar: {
    defaultPinned: ['origin', 'state'],
    label: 'Filter worktrees',
    placeholder: 'Filter by project, branch or path…'
  },
  head: 'worktrees',
  reading: 'Still asking git in every repository…',
  noMatch: 'No worktrees match this filter.'
}

const neverBlocked = (): boolean => false

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
  /** null until the first scan lands, which opens the first tab holding anything —
   *  unless you picked one while it was still walking */
  const [tab, setTab] = useState<CleanupSection | null>(null)
  const current = tab ?? 'sessions'

  const sessions = useMemo(() => report?.sessions ?? [], [report])
  const worktrees = useMemo(() => report?.worktrees ?? [], [report])
  const tables = useMemo(() => report?.tables ?? [], [report])
  // one directory can hold a dozen `node`s: group by worktree, oldest group first,
  // and pick over the grouped order so a shift-range follows what is on screen
  const processGroups = useMemo(() => {
    const by = new Map<string, OrphanProcess[]>()
    for (const p of report?.processes ?? []) {
      by.set(p.worktreePath, [...(by.get(p.worktreePath) ?? []), p])
    }
    return [...by.values()]
  }, [report])
  const processes = useMemo(() => processGroups.flat(), [processGroups])

  // each list's query, filters and picks live here, so they survive a tab switch
  const sList = useStaleList(sessions, SESSIONS)
  const tList = useStaleList(tables, TABLES)
  const wList = useStaleList(worktrees, WORKTREES)
  const pPicks = usePicks(processes, processKey, neverBlocked)
  const allPicks = [sList.picks, wList.picks, pPicks, tList.picks]

  // Scans overlap — the threshold can change while one runs — and finish in any
  // order: a report measured at the old threshold landing last would show the wrong
  // rows and flip the picker back. Only the newest scan's answer is applied.
  const scanSeq = useRef(0)
  const scan = useCallback(async (): Promise<void> => {
    const seq = ++scanSeq.current
    setScanning(true)
    setError(null)
    try {
      const r = await api.scanCleanup()
      if (seq !== scanSeq.current) return
      setReport(r)
      setStaleDays(String(r.staleDays))
      const counts = sectionCounts(r)
      setTab((t) => t ?? CLEANUP_SECTIONS.find((s) => counts[s.id] > 0)?.id ?? 'sessions')
    } catch (err) {
      if (seq === scanSeq.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (seq === scanSeq.current) setScanning(false)
    }
  }, [])

  useEffect(() => {
    headingRef.current?.focus()
    void scan()
  }, [scan])

  const changeThreshold = async (days: string): Promise<void> => {
    setStaleDays(days)
    await api.setStaleDays(Number(days))
    // every list's picks, the tables' included: a table picked at the old threshold
    // may not be listed at the new one — a pick left behind rode along, unseen, into
    // the next delete
    for (const p of allPicks) p.clear()
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
      for (const p of allPicks) p.clear()
      await scan()
      const failed = res.failed.length
      const freed = res.freedBytes > 0 ? ` · ${formatBytes(res.freedBytes)} freed` : ''
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

  const sPicked = sList.picks.picked
  const tPicked = tList.picks.picked
  const wPicked = wList.picks.picked
  const pPicked = pPicks.picked
  const counts = sectionCounts(report)
  const truncated = (report?.staleSessionCount ?? 0) > sessions.length
  const now = report?.scannedAt ?? Date.now()

  /** One panel per tab: a `Record` will not compile if a tab is added to
   *  `CLEANUP_SECTIONS` without a list behind it. */
  const panels: Record<CleanupSection, JSX.Element> = {
    sessions: (
      <StaleList
        config={SESSIONS}
        list={sList}
        now={now}
        scanning={scanning}
        footer={
          truncated && (
            <p className="ns-hint">
              Showing the {sessions.length} oldest of {report?.staleSessionCount} — clean these,
              then rescan for the rest.
            </p>
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
        <ArmedButton
          id="sessions"
          slot={armed}
          disabled={working || sPicked.size === 0}
          rest={counted('Delete', sPicked.size)}
          ask={`Delete ${sPicked.size} for good?`}
          title="Deletes the agents' own log files, the worktrees these sessions ran in, and any branch git reports as fully merged. This cannot be undone."
          onConfirm={() => void run('Deleted', () => api.deleteSessions([...sPicked]))}
        />
      </StaleList>
    ),
    processes:
      processes.length === 0 && !scanning ? (
        <p className="ns-hint">
          Nothing left running — no process is still working in a stale or removed worktree.
        </p>
      ) : (
        <>
          <p className="ns-hint">
            Dev servers, watchers and shells still running in a worktree that has gone stale, or
            in one already removed from under them. A worktree stays unremovable while one runs
            inside it.
          </p>
          <GroupHead
            picks={pPicks}
            label="processes"
            summary={
              pPicked.size > 0 ? (
                <>
                  <strong>{pPicked.size}</strong> selected
                </>
              ) : (
                <>{processes.length} shown</>
              )
            }
          >
            <ArmedButton
              id="processes"
              slot={armed}
              disabled={working || pPicked.size === 0}
              rest={counted('Stop', pPicked.size)}
              ask={`Stop ${pPicked.size} process${pPicked.size === 1 ? '' : 'es'}?`}
              title="Sends SIGTERM to each, asking it to exit. Anything unsaved inside those processes is lost; one that ignores the signal is reported, never killed."
              onConfirm={() =>
                void run('Stopped', () =>
                  api.stopProcesses(
                    processes
                      .filter((p) => pPicked.has(processKey(p)))
                      .map(({ pid, command, startedAt }) => ({ pid, command, startedAt }))
                  )
                )
              }
            />
          </GroupHead>
          {processes.length === 0 ? (
            <p className="ns-hint cl-empty">Still looking for processes in old worktrees…</p>
          ) : (
            <ul className="source-list cl-list">
              {processGroups.map((group) => (
                <ProcessGroup key={group[0].worktreePath} procs={group}>
                  {group.map((p) => {
                    const i = processes.indexOf(p)
                    return (
                      <ProcessRow
                        key={p.pid}
                        row={p}
                        now={now}
                        picked={pPicked.has(processKey(p))}
                        onPick={(on, range) => pPicks.toggle(i, on, range)}
                      />
                    )
                  })}
                </ProcessGroup>
              ))}
            </ul>
          )}
        </>
      ),
    tables: (
      <StaleList config={TABLES} list={tList} now={now} scanning={scanning}>
        <ArmedButton
          id="tables"
          slot={armed}
          disabled={working || tPicked.size === 0}
          rest={counted('Delete', tPicked.size)}
          ask={`Delete ${tPicked.size} roundtable${tPicked.size === 1 ? '' : 's'}?`}
          title="Takes each table, its seat sessions and the directory it ran in. This cannot be undone."
          onConfirm={() => void run('Deleted', () => api.deleteRoundtables([...tPicked]))}
        />
      </StaleList>
    ),
    worktrees: (
      <StaleList config={WORKTREES} list={wList} now={now} scanning={scanning}>
        <ArmedButton
          id="worktrees"
          slot={armed}
          disabled={working || wPicked.size === 0}
          rest={counted('Remove', wPicked.size)}
          ask={`Remove ${wPicked.size} worktree${wPicked.size === 1 ? '' : 's'}?`}
          title="Runs git worktree remove on each — the directory goes, the branch stays unless git says it is fully merged."
          onConfirm={() => void run('Removed', () => api.removeWorktrees([...wPicked]))}
        />
      </StaleList>
    )
  }

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
          What has gone quiet, across every agent and every repository, and what can safely go.
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
              {formatBytes(report.staleSessionBytes)} · {report.staleWorktreeCount} of{' '}
              {report.totalWorktrees} worktrees
              {report.totalTables > 0 &&
                ` · ${report.staleTableCount} of ${report.totalTables} roundtables`}
              {report.processes.length > 0 &&
                ` · ${report.processes.length} process${
                  report.processes.length === 1 ? '' : 'es'
                } left running`}
              {status && ` — ${status}`}
            </>
          ) : (
            status
          )}
        </p>

        {/* the threshold and the scan above govern every list, so they sit over the
            tabs; each list is its own page under them, never a heading further down */}
        <TabList
          id="cleanup"
          label="Cleanup sections"
          tabs={CLEANUP_SECTIONS.map((s) => ({ ...s, count: counts[s.id] }))}
          selected={current}
          onSelect={(t) => {
            // an armed Delete is a question about the list on screen — leaving it is "no"
            armed.disarm()
            setTab(t)
          }}
        />
        <TabPanel id="cleanup" selected={current}>
          {panels[current]}
        </TabPanel>

        {error && (
          <div role="alert" className="new-error">
            {error}
          </div>
        )}
      </div>
    </main>
  )
}
