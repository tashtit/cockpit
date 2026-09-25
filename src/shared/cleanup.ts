import type { CleanupNotice } from './types'

/**
 * How cleanup speaks about what it found, in both processes: the reminder's banner is
 * written in main, the sidebar's Cleanup key and the view itself in the renderer, and
 * all of them must count and size things the same way.
 */

const UNITS = [
  [1e9, 'GB'],
  [1e6, 'MB'],
  [1e3, 'KB']
] as const

/** One decimal at most, and never a bare `.0` — "400 MB", not "400.0 MB". */
export function formatBytes(n: number | null): string {
  if (n === null) return '—'
  for (const [scale, unit] of UNITS) {
    if (n >= scale) return `${Number((n / scale).toFixed(1))} ${unit}`
  }
  return `${n} B`
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** "12 sessions · 3 worktrees · 1 process still running" — only the kinds that have any. */
export function cleanupCounts(n: CleanupNotice): string {
  return [
    n.sessions > 0 && plural(n.sessions, 'session', 'sessions'),
    n.worktrees > 0 && plural(n.worktrees, 'worktree', 'worktrees'),
    n.tables > 0 && plural(n.tables, 'roundtable', 'roundtables'),
    n.processes > 0 && `${plural(n.processes, 'process', 'processes')} still running`
  ]
    .filter((s): s is string => typeof s === 'string')
    .join(' · ')
}

/** Below this, a size says nothing worth leading with. */
const WORTH_SIZING = 1e6

/** The reminder's headline after "Cleanup": what it can free, or that there is something. */
export function cleanupHeadline(n: CleanupNotice): string {
  return n.bytes >= WORTH_SIZING ? `can free ${formatBytes(n.bytes)}` : 'has something to clear'
}
