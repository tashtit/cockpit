import { sep } from 'node:path'
import type { CleanupBlock, WorktreeOrigin } from '../shared/types'

/**
 * The IO-free half of cleanup: what counts as stale, how git's worktree listing
 * reads, and which facts about a worktree stand between it and removal. Kept
 * separate from cleanup.ts (which shells out to git and touches the filesystem)
 * so all of it is testable without a repo on disk — same split as
 * instructions-core.ts and roundtable-core.ts.
 */

/** Nothing is offered for cleaning before this — a month of silence is the floor. */
export const DEFAULT_STALE_DAYS = 30

/**
 * A guard rail, not a preference: below a week, "stale" would sweep up work
 * someone is between sittings on. The UI's presets start at 30.
 */
export const MIN_STALE_DAYS = 7

/** Ten years — anything higher is a typo, not an intent. */
export const MAX_STALE_DAYS = 3650

const DAY_MS = 86_400_000

/** Renderer input is untrusted, and this number decides what gets deleted. */
export function clampStaleDays(days: unknown): number {
  const n = Math.floor(Number(days))
  if (!Number.isFinite(n)) return DEFAULT_STALE_DAYS
  return Math.min(MAX_STALE_DAYS, Math.max(MIN_STALE_DAYS, n))
}

/** Epoch ms before which a thing counts as stale. */
export function staleCutoff(days: number, now: number): number {
  return now - clampStaleDays(days) * DAY_MS
}

/** One entry of `git worktree list --porcelain`. */
export type WorktreeEntry = {
  readonly path: string
  /** Short branch name; null when detached or bare */
  readonly branch: string | null
  readonly head: string | null
  readonly bare: boolean
  readonly detached: boolean
  readonly locked: boolean
  /** git itself says the registration is dead (directory gone) */
  readonly prunable: boolean
}

/**
 * Parse `git worktree list --porcelain`: blank-line-separated records, each
 * opening with `worktree <path>`. Unknown attribute lines are ignored rather
 * than rejected — git adds them between releases, and a listing we half
 * understand is still worth showing.
 */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const out: WorktreeEntry[] = []
  for (const record of porcelain.split(/\n\s*\n/)) {
    let path: string | null = null
    let branch: string | null = null
    let head: string | null = null
    let bare = false
    let detached = false
    let locked = false
    let prunable = false
    for (const raw of record.split('\n')) {
      const line = raw.trim()
      if (!line) continue
      const sp = line.indexOf(' ')
      const key = sp === -1 ? line : line.slice(0, sp)
      const value = sp === -1 ? '' : line.slice(sp + 1)
      if (key === 'worktree') path = value
      else if (key === 'HEAD') head = value
      else if (key === 'branch') branch = value.replace(/^refs\/heads\//, '')
      else if (key === 'bare') bare = true
      else if (key === 'detached') detached = true
      else if (key === 'locked') locked = true
      else if (key === 'prunable') prunable = true
    }
    if (path) out.push({ path, branch, head, bare, detached, locked, prunable })
  }
  return out
}

/** True when `child` is `parent` itself or sits inside it. */
export function isUnder(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep)
}

/**
 * Cockpit cuts its own worktrees under `<userData>/worktrees`. Everything else —
 * Claude Code's `.claude/worktrees`, a hand-made one, another tool's — is
 * external: still listed and still cleanable, just never assumed to be ours.
 */
export function worktreeOrigin(path: string, cockpitRoot: string): WorktreeOrigin {
  return isUnder(path, cockpitRoot) ? 'cockpit' : 'external'
}

/** What cleanup.ts learned about one worktree; `worktreeBlocks` turns it into reasons. */
export type WorktreeFacts = {
  /** The repository's primary checkout (first entry of the listing) */
  readonly isMain: boolean
  readonly locked: boolean
  /** `git status --porcelain` returned something */
  readonly dirty: boolean
  /** An agent turn is running in this directory right now */
  readonly busy: boolean
  /** It is a roundtable's shared room */
  readonly roundtable: boolean
  /** A process outside Cockpit still has its working directory in it */
  readonly processes: boolean
}

/**
 * Everything standing between a worktree and `git worktree remove`, in the order
 * the UI shows them (most fundamental first). Empty means safe to remove.
 *
 * Unpushed commits are deliberately absent: removing a worktree leaves its branch
 * in the repository, so no commit is lost. They only gate deleting the branch,
 * which cleanup.ts hands to `git branch -d` — git's own merged check.
 */
export function worktreeBlocks(facts: WorktreeFacts): CleanupBlock[] {
  const blocks: CleanupBlock[] = []
  if (facts.isMain) blocks.push('main')
  if (facts.roundtable) blocks.push('roundtable')
  if (facts.busy) blocks.push('busy')
  if (facts.processes) blocks.push('process')
  if (facts.dirty) blocks.push('dirty')
  if (facts.locked) blocks.push('locked')
  return blocks
}

/**
 * When a worktree was last touched: the newest of its branch tip, any session
 * Cockpit indexed running in it, and the directory's own mtime. Missing signals
 * are 0 and drop out; all-zero means "no evidence of life", which reads as
 * maximally stale — correct for a registration whose directory is gone.
 */
export function lastWorktreeActivity(
  signals: readonly (number | null | undefined)[]
): number {
  let newest = 0
  for (const s of signals) if (typeof s === 'number' && s > newest) newest = s
  return newest
}

export function isStale(lastActivity: number, cutoff: number): boolean {
  return lastActivity < cutoff
}

export function sumBytes(items: readonly { readonly bytes: number | null }[]): number {
  return items.reduce((n, i) => n + (i.bytes ?? 0), 0)
}

/* ---------- processes left running in old worktrees ---------- */

/** One process as `ps` and `lsof` describe it — only what the judgement needs. */
export type ProcessFacts = {
  readonly pid: number
  readonly ppid: number
  /** Full command line */
  readonly command: string
  /** Epoch ms; 0 when `ps` gave no readable elapsed time */
  readonly startedAt: number
  readonly cwd: string
}

/**
 * `lsof -a -d cwd -F pn`: a `p<pid>` line opens each process, its `n<path>` line
 * names the working directory. Other field lines (`f`, anything lsof adds) are
 * skipped. lsof keeps reporting a directory's old path after it is deleted, which
 * is exactly what makes a process inside a removed worktree findable at all
 * (Linux marks such a path with a trailing ` (deleted)`, dropped here).
 */
export function parseLsofCwds(out: string): Map<number, string> {
  const cwds = new Map<number, string>()
  let pid: number | null = null
  for (const line of out.split('\n')) {
    if (line.startsWith('p')) {
      const n = Number(line.slice(1))
      pid = Number.isInteger(n) && n > 0 ? n : null
    } else if (line.startsWith('n') && pid !== null && !cwds.has(pid)) {
      cwds.set(pid, line.slice(1).replace(/ \(deleted\)$/, ''))
    }
  }
  return cwds
}

/** `ps -o etime=`: `[[dd-]hh:]mm:ss`, in seconds; null when it isn't that shape. */
export function parseElapsed(etime: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim())
  if (!m) return null
  const [, d, h, min, s] = m
  return Number(d ?? 0) * 86_400 + Number(h ?? 0) * 3_600 + Number(min) * 60 + Number(s)
}

/** One row of `ps -Ao pid=,ppid=,etime=,command=`, before the cwd is joined in. */
export type PsRow = {
  readonly pid: number
  readonly ppid: number
  readonly startedAt: number
  readonly command: string
}

/** `ps -Ao pid=,ppid=,etime=,command=` — the command is last, so it may hold spaces. */
export function parsePs(out: string, now: number): PsRow[] {
  const rows: PsRow[] = []
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!m) continue
    const elapsed = parseElapsed(m[3])
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      startedAt: elapsed === null ? 0 : now - elapsed * 1000,
      command: m[4].trim()
    })
  }
  return rows
}

/**
 * Cockpit's own process tree: itself, what launched it (a dev `npm run dev` in a
 * worktree must never be offered for stopping — that stops the app), and every
 * process it spawned (agent turns, which ChatManager already tracks as busy).
 */
export function ownProcessTree(rows: readonly PsRow[], selfPid: number): Set<number> {
  const parentOf = new Map(rows.map((r) => [r.pid, r.ppid]))
  const own = new Set<number>([selfPid])
  for (let p = parentOf.get(selfPid); p !== undefined && p > 1 && !own.has(p); p = parentOf.get(p)) {
    own.add(p)
  }
  const children = new Map<number, number[]>()
  for (const r of rows) children.set(r.ppid, [...(children.get(r.ppid) ?? []), r.pid])
  const queue = [selfPid]
  while (queue.length > 0) {
    for (const c of children.get(queue.pop() as number) ?? []) {
      if (own.has(c)) continue
      own.add(c)
      queue.push(c)
    }
  }
  return own
}

/** A worktree as far as process judgement cares. */
export type ProcessWorktree = {
  readonly path: string
  readonly repoName: string
  readonly branch: string | null
  readonly isMain: boolean
  /** Idle past the threshold, or its directory is gone */
  readonly stale: boolean
  readonly missing: boolean
}

/**
 * A directory worktrees are cut under — Cockpit's own root, a repo's
 * `.claude/worktrees`, Codex's `~/.codex/worktrees`. It is what lets a process be
 * tied to a worktree whose registration has already been removed: git has
 * forgotten it, but a deleted directory under one of these was a worktree.
 */
export type WorktreeHome = {
  readonly path: string
  readonly repoName: string | null
}

/** A process judged to be left behind in an old worktree. */
export type JudgedProcess = ProcessFacts & {
  /** The worktree it runs in — or, when that is gone, the removed directory */
  readonly worktreePath: string
  readonly repoName: string | null
  readonly branch: string | null
  readonly directoryGone: boolean
}

/** Deepest path in `candidates` containing `child`. */
function deepest<T extends { readonly path: string }>(
  candidates: readonly T[],
  child: string
): T | null {
  let best: T | null = null
  for (const c of candidates) {
    if (isUnder(child, c.path) && (!best || c.path.length > best.path.length)) best = c
  }
  return best
}

/**
 * Which processes are left running in old worktrees. Two ways to be one:
 *
 *   - its cwd is inside a linked worktree git still lists, and that worktree is
 *     stale (or its directory is gone);
 *   - its cwd no longer exists and sits under a worktree home — the worktree was
 *     removed (by this view, by `git worktree remove`, by hand) while something
 *     kept running in it.
 *
 * A process in the repository's own checkout, in a worktree still in use, or in
 * a deleted directory that was never a worktree is none of cleanup's business.
 * `exists` is the one filesystem question, injected so this stays IO-free.
 */
export function judgeProcesses(input: {
  readonly processes: readonly ProcessFacts[]
  readonly worktrees: readonly ProcessWorktree[]
  readonly homes: readonly WorktreeHome[]
  readonly exists: (path: string) => boolean
}): JudgedProcess[] {
  const out: JudgedProcess[] = []
  for (const p of input.processes) {
    const tree = deepest(input.worktrees, p.cwd)
    if (tree && !tree.isMain) {
      if (!tree.stale && !tree.missing) continue
      out.push({
        ...p,
        worktreePath: tree.path,
        repoName: tree.repoName,
        branch: tree.branch,
        directoryGone: tree.missing || !input.exists(p.cwd)
      })
      continue
    }
    if (input.exists(p.cwd)) continue
    const home = deepest(input.homes, p.cwd)
    if (!home || home.path === p.cwd) continue
    // the removed worktree is the topmost missing directory below its home
    let gone = p.cwd
    for (let up = parentOf(gone); up !== home.path && isUnder(up, home.path); up = parentOf(up)) {
      if (input.exists(up)) break
      gone = up
    }
    out.push({
      ...p,
      worktreePath: gone,
      repoName: home.repoName,
      branch: null,
      directoryGone: true
    })
  }
  return out.sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid)
}

function parentOf(path: string): string {
  const i = path.lastIndexOf(sep)
  return i <= 0 ? sep : path.slice(0, i)
}
