import { useEffect, useMemo, useState, type JSX } from 'react'
import type { Provider, ProviderUsage, UsageSnapshot, UsageWindow } from '../../shared/types'
import { api } from './api'
import { useBusyMap } from './busy'
import { fmtCount, fmtResetIn } from './format'
import { ProviderLogo, PROVIDER_LABEL } from './logos'

/**
 * The sidebar footer's subscription meters: one compact cell per provider that reports
 * numbers, so "which agent gets the next task" can be decided without opening
 * Settings. Main throttles the expensive parts (usage.ts); this only decides what one
 * cell says.
 */

/** How often the footer re-asks main; main's own caches make a call cheap. */
export const USAGE_POLL_MS = 60_000
/** From this percentage on a cell carries the warning glyph next to its color. */
export const USAGE_WARN_PERCENT = 80

const PROVIDER_ORDER: Provider[] = ['claude', 'codex', 'copilot']

export type UsageMeter = {
  readonly provider: Provider
  /** The tightest window's percent used, when the provider reports a limit */
  readonly percent: number | null
  /** What the cell prints: "42%", or a compact count when no limit is known */
  readonly text: string
  readonly warn: boolean
  /** Every window's detail, one per line — the cell's tooltip */
  readonly title: string
  /** The same reading in words — feeds the footer button's accessible name */
  readonly spoken: string
}

/** One tooltip line per window: what was used, and when it resets. */
function windowLine(w: UsageWindow, now: number): string {
  let used: string
  if (typeof w.usedPercent === 'number') {
    used = `${Math.round(w.usedPercent)}% used`
  } else if (w.tokens) {
    used =
      w.requests === 0
        ? 'no activity'
        : `${fmtCount(w.tokens.input + w.tokens.output)} tokens` +
          (typeof w.requests === 'number' ? ` · ${fmtCount(w.requests)} requests` : '')
  } else if (typeof w.requests === 'number') {
    used =
      `${fmtCount(w.requests)} used` +
      ((w.requestsBilled ?? 0) > 0 ? ` · ${fmtCount(w.requestsBilled!)} billed beyond plan` : '')
  } else {
    used = 'no data'
  }
  return `${w.label}: ${used}${w.resetsAt ? ` · ${fmtResetIn(w.resetsAt, now)}` : ''}`
}

/**
 * What one provider's cell shows, or null when there is nothing honest to show
 * (usage unavailable, or windows with no measurable number). The tightest window
 * is the one with the highest reported percentage; providers that report no limit
 * (claude's local measurement, copilot's request count) print their first window's
 * count instead — the one that moves with each turn.
 */
export function usageMeter(u: ProviderUsage, now = Date.now()): UsageMeter | null {
  if (u.unavailable || u.windows.length === 0) return null
  let tightest: UsageWindow | null = null
  for (const w of u.windows) {
    if (typeof w.usedPercent !== 'number') continue
    if (tightest === null || w.usedPercent > tightest.usedPercent!) tightest = w
  }
  const lead = tightest ?? u.windows[0]
  const percent = tightest ? Math.round(tightest.usedPercent!) : null
  let text: string | null = null
  if (percent !== null) text = `${percent}%`
  else if (lead.tokens) text = fmtCount(lead.tokens.input + lead.tokens.output)
  else if (typeof lead.requests === 'number') text = fmtCount(lead.requests)
  if (text === null) return null

  const billed = u.windows.find((w) => (w.requestsBilled ?? 0) > 0)
  const reason =
    percent !== null && percent >= USAGE_WARN_PERCENT
      ? `${lead.label} at ${percent}%`
      : billed
        ? `${fmtCount(billed.requestsBilled!)} requests billed beyond the plan`
        : null
  const name = PROVIDER_LABEL[u.provider]
  const head = u.identity ? `${name} — ${u.identity}` : name
  const lines = u.windows.map((w) => windowLine(w, now))
  return {
    provider: u.provider,
    percent,
    text,
    warn: reason !== null,
    title: [head, ...lines, ...(reason ? [`warning: ${reason}`] : [])].join('\n'),
    spoken: `${name} ${windowLine(lead, now)}${reason ? ' (warning)' : ''}`
  }
}

/**
 * One meter per provider in livery order. A provider with several config homes
 * (two claude accounts) shows the home closest to its limit — the footer is a
 * glance; per-account rows live in Settings.
 */
export function usageMeters(snapshot: UsageSnapshot, now = Date.now()): UsageMeter[] {
  const best = new Map<Provider, UsageMeter>()
  for (const u of snapshot.providers) {
    const m = usageMeter(u, now)
    if (!m) continue
    const cur = best.get(u.provider)
    if (!cur || (m.percent ?? -1) > (cur.percent ?? -1)) best.set(u.provider, m)
  }
  return PROVIDER_ORDER.flatMap((p) => best.get(p) ?? [])
}

/** 10px warning triangle — local so the sidebar's parallel icon edits stay clear. */
function WarnGlyph(): JSX.Element {
  return (
    <svg className="usage-warn" width="10" height="10" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" />
    </svg>
  )
}

/**
 * The footer row itself. Renders nothing until a provider reports numbers — absence
 * is not an error state, the identity bar below still opens Settings.
 */
export function UsageMeters({ onOpen }: { onOpen: () => void }): JSX.Element | null {
  const [usage, setUsage] = useState<UsageSnapshot | null>(null)
  const busy = useBusyMap()

  // the busy map's identity changes exactly when a session starts or finishes — the
  // moments the numbers move — so it doubles as the refetch trigger next to the timer
  useEffect(() => {
    let dead = false
    const load = (): void => {
      api.getUsage().then((s) => {
        if (!dead) setUsage(s)
      }, () => {})
    }
    load()
    const timer = setInterval(load, USAGE_POLL_MS)
    return () => {
      dead = true
      clearInterval(timer)
    }
  }, [busy])

  const meters = useMemo(() => (usage ? usageMeters(usage) : []), [usage])
  if (meters.length === 0) return null
  return (
    <button
      className="footer-usage"
      onClick={onOpen}
      aria-label={`Subscription usage — ${meters.map((m) => m.spoken).join('; ')} — open settings`}
    >
      {meters.map((m) => (
        <span
          key={m.provider}
          className={`usage-cell usage-cell-${m.provider}${m.warn ? ' warn' : ''}`}
          title={m.title}
        >
          <span className={`plogo plogo-${m.provider}`}>
            <ProviderLogo p={m.provider} size={12} />
          </span>
          {m.percent !== null && (
            <span className="usage-mini">
              <span className="usage-mini-fill" style={{ width: `${m.percent}%` }} />
            </span>
          )}
          {m.warn && <WarnGlyph />}
          <span className="usage-cell-num">{m.text}</span>
        </span>
      ))}
    </button>
  )
}
