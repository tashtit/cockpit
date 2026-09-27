import type { TimeFormat, UsageWindow } from '../../shared/types'

/**
 * How the renderer writes numbers, counts and times. Views that show the same reading
 * must agree to the character — Settings' full usage readout and the sidebar's footer
 * meters, every row's timestamp — so all of them import from here. The clock setting
 * itself (12- or 24-hour) is a store, in `time.ts`.
 */

/** Compact count for chips and meters: 950 → "950", 1_234 → "1.2k", 1_500_000 → "1.5M" */
export function fmtCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

/** A count and its noun: "1 file", "3 files" — `many` for a plural that isn't one + "s". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** "resets in 2h 15m" / "resets in 3d 4h"; `now` is injectable for tests */
export function fmtResetIn(at: number, now = Date.now()): string {
  const mins = Math.max(0, Math.round((at - now) / 60000))
  if (mins < 60) return `resets in ${mins}m`
  const h = Math.floor(mins / 60)
  if (h < 24) return `resets in ${h}h ${mins % 60}m`
  return `resets in ${Math.floor(h / 24)}d ${h % 24}h`
}

/**
 * What a usage window has spent when it gives no percentage: tokens (and requests) for a
 * measured window, "no activity" for one with no requests in it, requests (and what was
 * billed beyond the plan) for a counted one. Null when it reports neither.
 */
export function usageSpent(w: UsageWindow): string | null {
  if (w.tokens) {
    if (w.requests === 0) return 'no activity'
    return (
      `${fmtCount(w.tokens.input + w.tokens.output)} tokens` +
      (typeof w.requests === 'number' ? ` · ${fmtCount(w.requests)} ${w.requests === 1 ? 'request' : 'requests'}` : '')
    )
  }
  if (typeof w.requests === 'number') {
    return (
      `${fmtCount(w.requests)} used` +
      ((w.requestsBilled ?? 0) > 0 ? ` · ${fmtCount(w.requestsBilled!)} billed beyond plan` : '')
    )
  }
  return null
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

/** "just now" / "42m ago" / "3h ago", falling back to a date past a day */
export function fmtAgo(ms: number, now = Date.now()): string {
  const mins = Math.round((now - ms) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const h = Math.round(mins / 60)
  if (h < 24) return `${h}h ago`
  return DATE_FORMAT.format(ms)
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

/** Running-turn duration for the board: "41s", "2m 14s", "1h 03m". */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** Paths inside a directory read relative to it — the header already names the directory
 *  (a session's, a roundtable's room), so repeating it in every row only pushes the file
 *  off-screen. No directory, or an empty one, leaves the text as it is. */
export function relativeTo(text: string, dir: string | undefined): string {
  return dir ? text.split(`${dir}/`).join('') : text
}
