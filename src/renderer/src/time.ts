import { useSyncExternalStore } from 'react'
import type { TimeFormat } from '../../shared/types'
import { api } from './api'

/**
 * Tiny shared store for the session-time clock format: SessionRow sits three
 * levels deep in the sidebar tree, so a subscription beats drilling the value
 * through every list component. Default matches the main process ('24h').
 */
let format: TimeFormat = '24h'
const listeners = new Set<() => void>()

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Pull the persisted format once at startup (App's mount effect). */
export async function initTimeFormat(): Promise<void> {
  format = await api.getTimeFormat()
  listeners.forEach((l) => l())
}

/** Live clock format — a Settings change re-renders every subscribed row. */
export function useTimeFormat(): TimeFormat {
  return useSyncExternalStore(subscribe, () => format)
}

export function setTimeFormat(f: TimeFormat): void {
  format = f
  listeners.forEach((l) => l())
  void api.setTimeFormat(f)
}

/** Running-turn duration for the board: "41s", "2m 14s", "1h 03m". */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** Session timestamps: time of day for today, short date for anything older. */
export function fmtTime(ms: number, fmt: TimeFormat): string {
  const d = new Date(ms)
  const today = new Date().toDateString() === d.toDateString()
  if (!today) return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  return fmt === '12h'
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}
