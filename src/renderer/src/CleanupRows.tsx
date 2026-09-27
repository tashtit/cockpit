import { useEffect, useRef, type JSX, type ReactNode } from 'react'
import type {
  CleanupBlock,
  OrphanProcess,
  StaleSession,
  StaleTable,
  StaleWorktree
} from '../../shared/types'
import type { Picks } from './cleanup-picks'
import { SeatCluster } from './SeatCluster'
import {
  BranchChip,
  BranchIcon,
  ProcessIcon,
  ProviderMark,
  PROVIDER_LABEL,
  RepoIcon
} from './logos'
import { formatBytes } from '../../shared/cleanup'
import { shortPath } from '../../shared/library'
import { plural } from './format'

/**
 * The Cleanup view's rows and the head over each list. Rows arrive pre-judged from
 * main (see cleanup.ts): a row only shows what it was handed — its blocks in words,
 * what it takes with it — and never decides what is stale or safe.
 */

const DAY_MS = 86_400_000

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
  process: 'a process is running',
  dirty: 'uncommitted changes',
  detached: 'commits on no branch',
  locked: 'locked'
}

/** "running 3d" — how long a left-behind process has outlived its work. */
function fmtRunning(since: number, now: number): string {
  if (since <= 0) return 'running'
  const mins = Math.max(0, Math.floor((now - since) / 60_000))
  if (mins < 60) return `running ${mins}m`
  if (mins < 60 * 24) return `running ${Math.floor(mins / 60)}h`
  return `running ${Math.floor(mins / (60 * 24))}d`
}

/** The executable's own name, without its path — `node`, not `/usr/local/bin/node`. */
function processName(command: string): string {
  const first = command.trim().split(/\s+/)[0] ?? ''
  return first.slice(first.lastIndexOf('/') + 1) || 'process'
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
export function GroupHead({
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

/** Why a row can't be cleaned, in words — a disabled checkbox alone says nothing. */
function Blocks({ blocks }: { blocks: readonly CleanupBlock[] }): JSX.Element {
  return (
    <>
      {blocks.map((b) => (
        <span key={b} className="cl-block">
          {BLOCK_LABEL[b]}
        </span>
      ))}
    </>
  )
}

/* ---------- rows ---------- */

/** What every row is handed: its item, the scan's clock, and its pick. */
export type RowProps<T> = {
  readonly row: T
  readonly now: number
  readonly picked: boolean
  readonly onPick: (on: boolean, range: boolean) => void
}

export function SessionRow({ row: s, now, picked, onPick }: RowProps<StaleSession>): JSX.Element {
  const w = s.worktree
  return (
    <li className={`cl-row tint-${s.provider} ${picked ? 'picked' : ''}`}>
      <Pick
        checked={picked}
        disabled={s.blocks.length > 0}
        label={`Select session ${s.title}`}
        onPick={onPick}
      />
      <ProviderMark p={s.provider} decorative />
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
              takes its worktree · {formatBytes(w.bytes)}
              {w.sessionCount > 1 && <span className="cl-shared"> · shared ×{w.sessionCount}</span>}
            </span>
          ) : (
            s.cwd && (
              <span className="cl-path" title={s.cwd}>
                {' · '}
                {shortPath(s.cwd)}
              </span>
            )
          )}
        </div>
      </div>
      <div className="cl-meta">
        <Blocks blocks={s.blocks} />
        <span className="cl-size">{formatBytes(s.bytes)}</span>
        <time dateTime={new Date(s.updatedAt).toISOString()}>{fmtIdle(s.updatedAt, now)}</time>
      </div>
    </li>
  )
}

/**
 * A roundtable row. The carry chip says what leaves with it — the seats and the
 * worktree — because the table is the unit, exactly as a session's worktree rides
 * on the session above.
 */
export function TableRow({ row: t, now, picked, onPick }: RowProps<StaleTable>): JSX.Element {
  const carry = [
    t.seatCount > 0 && plural(t.seatCount, 'seat session'),
    t.worktree ? 'its worktree' : 'its room'
  ].filter(Boolean)
  return (
    <li className={`cl-row ${picked ? 'picked' : ''}`}>
      <Pick
        checked={picked}
        disabled={t.blocks.length > 0}
        label={`Select roundtable ${t.title}`}
        onPick={onPick}
      />
      <SeatCluster providers={t.providers} decorative />
      <div className="cl-body">
        <div className="cl-title">
          {t.title}
          {t.repoName && <span className="cl-tag">{t.repoName}</span>}
          {t.archived && <span className="cl-tag">archived</span>}
          {t.worktree?.branch && <BranchChip branch={t.worktree.branch} />}
        </div>
        <div className="cl-sub">
          {plural(t.entryCount, 'message')} · takes {carry.join(' · ')}
        </div>
      </div>
      <div className="cl-meta">
        <Blocks blocks={t.blocks} />
        {/* sizes are never a bare 0 (MASTER: "— when unmeasurable, never 0") — an
            empty room with its seats already gone has nothing to free */}
        <span className="cl-size">{formatBytes(t.bytes ? t.bytes : null)}</span>
        <span className="cl-age">{fmtIdle(t.updatedAt, now)}</span>
      </div>
    </li>
  )
}

export function WorktreeRow({ row: w, now, picked, onPick }: RowProps<StaleWorktree>): JSX.Element {
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
          {shortPath(w.path)}
        </div>
      </div>
      <div className="cl-meta">
        <Blocks blocks={w.blocks} />
        {w.unpushed > 0 && (
          <span
            className="cl-unpushed"
            title="Commits no remote has — the branch is kept unless git says it is fully merged"
          >
            {w.unpushed} unpushed
          </span>
        )}
        {w.sessionCount > 0 && <span className="repo-count">{w.sessionCount}</span>}
        <span className="cl-size">{formatBytes(w.bytes)}</span>
        <time dateTime={new Date(w.lastActivity || now).toISOString()}>
          {fmtIdle(w.lastActivity, now)}
        </time>
      </div>
    </li>
  )
}

export function ProcessRow({ row: p, now, picked, onPick }: RowProps<OrphanProcess>): JSX.Element {
  const name = processName(p.command)
  return (
    <li className={`cl-row ${picked ? 'picked' : ''}`}>
      <Pick checked={picked} label={`Select process ${name} (pid ${p.pid})`} onPick={onPick} />
      <span className="repo-icon" aria-hidden="true">
        <ProcessIcon size={13} />
      </span>
      <div className="cl-body">
        <div className="cl-title" title={p.command}>
          <span className="cl-proc">{name}</span>
        </div>
        {/* the group names the worktree; the command line is what tells siblings apart */}
        <div className="cl-sub cl-path" title={`${p.command}\n${p.cwd}`}>
          {p.command}
        </div>
      </div>
      <div className="cl-meta">
        <span className="cl-size">pid {p.pid}</span>
        <span>{fmtRunning(p.startedAt, now)}</span>
      </div>
    </li>
  )
}

/** One worktree's left-behind processes, under a line that names the worktree once. */
export function ProcessGroup({
  procs,
  children
}: {
  procs: readonly OrphanProcess[]
  children: ReactNode
}): JSX.Element {
  const head = procs[0]
  return (
    <li className="cl-proc-group">
      <div className="cl-title cl-proc-where">
        {head.repoName && <span className="cl-proc-repo">{head.repoName}</span>}
        {head.branch && <BranchChip branch={head.branch} />}
        {procs.some((p) => p.worktreeGone) && <span className="cl-tag">worktree removed</span>}
        <span className="cl-sub cl-path" title={head.worktreePath}>
          {shortPath(head.worktreePath)}
        </span>
      </div>
      <ul className="source-list">{children}</ul>
    </li>
  )
}
