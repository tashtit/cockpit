import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { CleanupBlock, CleanupResult, CleanupReport, StaleSession, StaleWorktree } from '../../shared/types'
import { api } from './api'
import { useArmedConfirm } from './ConfirmRemove'
import { BranchChip, ProviderLogo, PROVIDER_LABEL, RepoIcon } from './logos'
import { Select } from './Select'

/**
 * Cleanup: one place for everything that has gone quiet, across every agent and
 * every repository. Two lists, two risk levels — archiving a session is Cockpit
 * config and reversible, deleting its files and removing a worktree are not, so
 * both destructive actions are two-step and anything git or the index objects to
 * is shown as a reason rather than offered as a force.
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

const DAY_MS = 86_400_000

function fmtBytes(n: number | null): string {
  if (n === null) return '—'
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`
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

/** Why a row can't be cleaned — never color alone, always the words. */
function BlockTag({ block }: { block: CleanupBlock }): JSX.Element {
  return <span className="cl-block">{BLOCK_LABEL[block]}</span>
}

function Picker({
  checked,
  disabled,
  label,
  onChange
}: {
  checked: boolean
  disabled: boolean
  label: string
  onChange: (on: boolean) => void
}): JSX.Element {
  return (
    <input
      type="checkbox"
      className="cl-pick"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => onChange(e.target.checked)}
    />
  )
}

function SessionRow({
  s,
  now,
  picked,
  onPick
}: {
  s: StaleSession
  now: number
  picked: boolean
  onPick: (on: boolean) => void
}): JSX.Element {
  const blocked = s.blocks.length > 0
  return (
    <li className={`cl-row tint-${s.provider}`}>
      <Picker
        checked={picked}
        disabled={blocked}
        label={`Select session ${s.title}`}
        onChange={onPick}
      />
      <span className={`plogo plogo-${s.provider}`} aria-hidden="true">
        <ProviderLogo p={s.provider} size={13} />
      </span>
      <div className="cl-body">
        <div className="cl-title" title={s.title}>
          {s.title || `${PROVIDER_LABEL[s.provider]} session`}
          {s.archived && <span className="cl-tag">archived</span>}
        </div>
        <div className="cl-sub" title={s.cwd ?? undefined}>
          {s.repoName ?? 'no repository'}
          {s.cwd && <span className="cl-path"> · {s.cwd}</span>}
        </div>
      </div>
      <div className="cl-meta">
        {s.blocks.map((b) => (
          <BlockTag key={b} block={b} />
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
  onPick: (on: boolean) => void
}): JSX.Element {
  const blocked = w.blocks.length > 0
  return (
    <li className="cl-row">
      <Picker
        checked={picked}
        disabled={blocked}
        label={`Select worktree ${w.path}`}
        onChange={onPick}
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
          <BlockTag key={b} block={b} />
        ))}
        {w.unpushed > 0 && (
          <span className="cl-unpushed" title="Commits no remote has — the branch is kept unless git says it is fully merged">
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

export function CleanupView({ onClose }: { onClose: () => void }): JSX.Element {
  const [report, setReport] = useState<CleanupReport | null>(null)
  const [staleDays, setStaleDays] = useState('30')
  const [scanning, setScanning] = useState(true)
  const [working, setWorking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState('')
  const [pickedSessions, setPickedSessions] = useState<ReadonlySet<string>>(new Set())
  const [pickedTrees, setPickedTrees] = useState<ReadonlySet<string>>(new Set())
  const confirm = useArmedConfirm()
  const headingRef = useRef<HTMLHeadingElement>(null)

  const scan = useCallback(async (): Promise<void> => {
    setScanning(true)
    setError(null)
    try {
      const r = await api.scanCleanup()
      setReport(r)
      setStaleDays(String(r.staleDays))
      // a stale row that was just cleaned must not stay selected under the next scan
      setPickedSessions(new Set())
      setPickedTrees(new Set())
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
    await scan()
  }

  /** Every action ends the same way: report what happened, then re-scan the truth. */
  const run = async (verb: string, action: () => Promise<CleanupResult>): Promise<void> => {
    setWorking(true)
    setError(null)
    confirm.disarm()
    try {
      const res = await action()
      // the rescan comes first: it clears the previous error, so a refusal reported
      // before it would be wiped off the screen the moment the truth came back
      await scan()
      const failed = res.failed.length
      const freed = res.freedBytes > 0 ? ` · ${fmtBytes(res.freedBytes)} freed` : ''
      const branches = res.branchesDeleted?.length
        ? ` · ${res.branchesDeleted.length} merged branch${res.branchesDeleted.length === 1 ? '' : 'es'} deleted`
        : ''
      setStatus(`${verb} ${res.cleaned}${freed}${branches}${failed ? ` · ${failed} kept` : ''}`)
      if (failed) setError(res.failed.map((f) => `${f.target} — ${f.reason}`).join('\n'))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setWorking(false)
    }
  }

  const toggle = (
    set: ReadonlySet<string>,
    key: string,
    on: boolean
  ): ReadonlySet<string> => {
    const next = new Set(set)
    if (on) next.add(key)
    else next.delete(key)
    return next
  }

  const sessions = report?.sessions ?? []
  const worktrees = report?.worktrees ?? []
  const freeSessions = sessions.filter((s) => s.blocks.length === 0)
  const freeTrees = worktrees.filter((w) => w.blocks.length === 0)
  const now = report?.scannedAt ?? Date.now()
  const nSessions = pickedSessions.size
  const nTrees = pickedTrees.size
  const truncated = (report?.staleSessionCount ?? 0) > sessions.length

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
          What has gone quiet, across every agent and every repository — sessions from all
          three CLIs, and every git worktree they run in, including the ones Cockpit never
          created. Archiving only hides a session in Cockpit; deleting removes the agent&apos;s
          own log file.
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
            <ul className="source-list cl-list">
              {sessions.map((s) => (
                <SessionRow
                  key={s.id}
                  s={s}
                  now={now}
                  picked={pickedSessions.has(s.id)}
                  onPick={(on) => setPickedSessions((p) => toggle(p, s.id, on))}
                />
              ))}
            </ul>
            {truncated && (
              <p className="ns-hint">
                Showing the {sessions.length} oldest of {report?.staleSessionCount} — clean these,
                then rescan for the rest.
              </p>
            )}
            <div className="ns-actions">
              <button
                className="btn-ghost"
                onClick={() =>
                  setPickedSessions(
                    nSessions === freeSessions.length
                      ? new Set()
                      : new Set(freeSessions.map((s) => s.id))
                  )
                }
              >
                {nSessions === freeSessions.length && nSessions > 0 ? 'Clear' : 'Select all'}
              </button>
              <button
                className="btn-ghost"
                disabled={working || nSessions === 0}
                onClick={() => void run('Archived', () => api.archiveSessions([...pickedSessions]))}
              >
                {nSessions ? `Archive ${nSessions}` : 'Archive'}
              </button>
              {confirm.armed === 'sessions' ? (
                <button
                  className="btn-danger"
                  title="Deletes the agents' own session log files. This cannot be undone."
                  onBlur={confirm.disarm}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.stopPropagation()
                      confirm.disarm()
                    }
                  }}
                  onClick={() =>
                    void run('Deleted', () => api.deleteSessions([...pickedSessions]))
                  }
                >
                  Delete {nSessions} for good?
                </button>
              ) : (
                <button
                  className="btn-ghost danger"
                  disabled={working || nSessions === 0}
                  onClick={() => confirm.arm('sessions')}
                >
                  Delete files…
                </button>
              )}
            </div>
          </>
        )}

        <h3 className="ns-label">Stale worktrees</h3>
        {worktrees.length === 0 && !scanning ? (
          <p className="ns-hint">No abandoned worktrees — every checkout is still in use.</p>
        ) : (
          <>
            <ul className="source-list cl-list">
              {worktrees.map((w) => (
                <WorktreeRow
                  key={w.path}
                  w={w}
                  now={now}
                  picked={pickedTrees.has(w.path)}
                  onPick={(on) => setPickedTrees((p) => toggle(p, w.path, on))}
                />
              ))}
            </ul>
            <p className="ns-hint">
              Removing a worktree keeps its branch — only branches git reports as fully merged are
              deleted with it. Anything with uncommitted work is listed but never removable.
            </p>
            <div className="ns-actions">
              <button
                className="btn-ghost"
                onClick={() =>
                  setPickedTrees(
                    nTrees === freeTrees.length ? new Set() : new Set(freeTrees.map((w) => w.path))
                  )
                }
              >
                {nTrees === freeTrees.length && nTrees > 0 ? 'Clear' : 'Select all'}
              </button>
              {confirm.armed === 'worktrees' ? (
                <button
                  className="btn-danger"
                  title="Runs git worktree remove on each — the directory goes, the branch stays unless git says it is fully merged."
                  onBlur={confirm.disarm}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.stopPropagation()
                      confirm.disarm()
                    }
                  }}
                  onClick={() => void run('Removed', () => api.removeWorktrees([...pickedTrees]))}
                >
                  Remove {nTrees} worktree{nTrees === 1 ? '' : 's'}?
                </button>
              ) : (
                <button
                  className="btn-ghost danger"
                  disabled={working || nTrees === 0}
                  onClick={() => confirm.arm('worktrees')}
                >
                  {nTrees ? `Remove ${nTrees}…` : 'Remove…'}
                </button>
              )}
            </div>
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
