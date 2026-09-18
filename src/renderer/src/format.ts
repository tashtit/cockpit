/**
 * Number and elapsed-time formatting shared by the views that print usage: Settings'
 * full readout and the sidebar's footer meters must agree to the character, so both
 * import from here.
 */

/** Compact count for chips and meters: 950 → "950", 1_234 → "1.2k", 1_500_000 → "1.5M" */
export function fmtCount(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

/** "resets in 2h 15m" / "resets in 3d 4h"; `now` is injectable for tests */
export function fmtResetIn(at: number, now = Date.now()): string {
  const mins = Math.max(0, Math.round((at - now) / 60000))
  if (mins < 60) return `resets in ${mins}m`
  const h = Math.floor(mins / 60)
  if (h < 24) return `resets in ${h}h ${mins % 60}m`
  return `resets in ${Math.floor(h / 24)}d ${h % 24}h`
}

/** "just now" / "42m ago" / "3h ago", falling back to a date past a day */
export function fmtAgo(ms: number, now = Date.now()): string {
  const mins = Math.round((now - ms) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const h = Math.round(mins / 60)
  if (h < 24) return `${h}h ago`
  return new Date(ms).toLocaleDateString([], { month: 'short', day: 'numeric' })
}
