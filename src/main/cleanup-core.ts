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
