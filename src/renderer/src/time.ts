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

/**
 * Built once each. `toLocale*String` with options builds a new ICU formatter on every
 * call, and every sidebar and board row shows a time — the clock setting picks which of
 * these two a row uses, so a Settings change still re-renders every row in the new one.
 */
const DATE_FORMAT = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' })
const CLOCK_FORMAT: Readonly<Record<TimeFormat, Intl.DateTimeFormat>> = {
  '12h': new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit', hour12: true }),
  '24h': new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** Today as the epoch ms it spans, local time — worked out again only once the clock leaves it. */
let today = { start: 0, end: 0 }

function isToday(ms: number): boolean {
  const now = Date.now()
  if (now < today.start || now >= today.end) {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    const start = d.getTime()
    d.setDate(d.getDate() + 1)
    today = { start, end: d.getTime() }
  }
  return ms >= today.start && ms < today.end
}

/** Session timestamps: time of day for today, short date for anything older. */
export function fmtTime(ms: number, fmt: TimeFormat): string {
  return isToday(ms) ? CLOCK_FORMAT[fmt].format(ms) : DATE_FORMAT.format(ms)
}
