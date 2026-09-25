import { useEffect, useMemo, useRef, useState, type CSSProperties, type JSX, type ReactNode } from 'react'
import type {
  ActivityDay,
  AgentSplit,
  ProfileStats,
  Provider,
  ProviderProfile,
  SessionTally
} from '../../shared/types'
import { api } from './api'
import { fmtAgo } from './format'
import { ipcErrorText } from './ipc-error'
import { ChatIcon, ProviderLogo, PROVIDER_LABEL, RepoIcon } from './logos'
import { TabList, TabPanel } from './Tabs'

/**
 * The cross-agent work profile: an activity heatmap plus per-agent totals.
 * Every number arrives pre-aggregated from main (see profile.ts) — this view
 * only formats and lays out; it never sees a session.
 *
 * Every split on the page — the headline's share bar, the squares, the hours, the
 * model, language and repo bars — paints the same three agent colors in the same
 * order (most sessions first), so the headline's key reads for all of them.
 */

/** Heatmap intensity steps. Index 0 is "no work"; the rest scale by session count. */
const LEVELS = 4

/**
 * Squares carry no text, so they scale past the 0.10–0.16 tint range used behind
 * labels. The first step is plainly visible: "did I work that day" is the grid's
 * first read, and a 0.22 wash on the dark surface was lost at arm's length.
 */
const LEVEL_ALPHA = [0, 0.3, 0.5, 0.72, 0.95]

/** Bars and their segments are graphics too: one alpha for every agent-split fill. */
const FILL_ALPHA = 0.85

const WEEKDAY_LABELS = ['Mon', 'Wed', 'Fri']

/** The hours the rhythm strip names under its bars. */
const HOUR_MARKS = [0, 6, 12, 18]

/**
 * The card's tabs, under the headline numbers: when you work, which agent did it,
 * and what it touched. Each is its own page — seven sections in one scroll was a
 * readout nobody could take in at once. A group with no data is dropped, and a tab
 * left with none is dropped with it.
 */
const PROFILE_TABS = [
  { id: 'activity', label: 'Activity' },
  { id: 'agents', label: 'Agents' },
  { id: 'code', label: 'Code' }
] as const
type ProfileTab = (typeof PROFILE_TABS)[number]['id']

const fill = (p: Provider, alpha = FILL_ALPHA): string => `rgba(var(--${p}-rgb), ${alpha})`

function fmtNum(n: number): string {
  return n.toLocaleString()
}

/** A rate, to one decimal where it has one: 3.25 → "3.3", 12 → "12" */
function fmtRate(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 1 })
}

/**
 * A count and its noun agree — "1 line", "12 lines" — and never part across a line
 * break: a narrow count column wraps at the "·" between two of them, not inside one.
 */
function counted(n: number, one: string, many = `${one}s`): string {
  return `${fmtNum(n)}\u00a0${n === 1 ? one : many}`
}

/** A share as a whole percent, never "0%" for something that happened */
function pct(n: number, total: number): string {
  if (total <= 0 || n <= 0) return '0%'
  const p = Math.round((n / total) * 100)
  return p === 0 ? '<1%' : `${p}%`
}

const hh = (h: number): string => String(h).padStart(2, '0')

function fmtDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
}

function fmtSince(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

/** A split's non-empty parts, in the page's agent order. */
function ordered(split: AgentSplit, order: readonly Provider[]): [Provider, number][] {
  const rank = (p: Provider): number => {
    const i = order.indexOf(p)
    return i < 0 ? order.length : i
  }
  return (Object.entries(split) as [Provider, number][])
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => rank(a) - rank(b))
}

/** "Claude 22 · Copilot 8" — the split in words, for tooltips and screen readers */
function splitText(split: AgentSplit, order: readonly Provider[]): string {
  return ordered(split, order)
    .map(([p, n]) => `${PROVIDER_LABEL[p]} ${fmtNum(n)}`)
    .join(' · ')
}

/** A row's or square's whole reading, for its tooltip: "acme/atlas — 8 sessions (Claude 5 · Codex 3)" */
function reading(what: string, count: string, split: string): string {
  return split ? `${what} — ${count} (${split})` : `${what} — ${count}`
}

/** The agent that ran most that day — decides the square's hue. */
function dominant(day: ActivityDay): Provider | null {
  let best: Provider | null = null
  let n = 0
  for (const [p, count] of Object.entries(day.byProvider)) {
    if ((count ?? 0) > n) {
      n = count ?? 0
      best = p as Provider
    }
  }
  return best
}

/**
 * Bucket a day's session count into an intensity step, against the busiest day in
 * the grid. On a square root, not a straight line: one 15-session day would otherwise
 * put every one- and two-session day on the first step, and the grid would read as
 * one bright square in a blank year.
 */
function level(sessions: number, busiest: number): number {
  if (sessions <= 0) return 0
  if (busiest <= 1) return LEVELS
  return Math.max(1, Math.min(LEVELS, Math.ceil(Math.sqrt(sessions / busiest) * LEVELS)))
}

/**
 * A track whose filled length is `share` of it, cut into one segment per agent.
 * Decorative: the row it sits in says the same thing in words.
 */
function SplitBar({
  split,
  share,
  order
}: {
  split: AgentSplit
  share: number
  order: readonly Provider[]
}): JSX.Element {
  return (
    <span className="pv-bar" aria-hidden="true">
      <span className="pv-bar-fill" style={{ width: `${Math.max(2, Math.round(share * 100))}%` }}>
        {ordered(split, order).map(([p, n]) => (
          <i key={p} style={{ flexGrow: n, background: fill(p) }} />
        ))}
      </span>
    </span>
  )
}

type BarRow = {
  readonly key: string
  readonly name: ReactNode
  /** The row's full reading, for the hover tooltip */
  readonly title: string
  readonly split: AgentSplit
  /** What the bar's length is measured in */
  readonly value: number
  readonly label: ReactNode
}

/**
 * The page's one list grammar — models, languages, repos: a name, its agent-split
 * bar, its count. The columns are shared (subgrid), so every track starts and ends
 * at the same x whatever the count beside it says.
 */
function BarList({
  rows,
  order,
  mono
}: {
  rows: readonly BarRow[]
  order: readonly Provider[]
  /** Machine identifiers (model names, extensions) set in mono */
  mono?: boolean
}): JSX.Element {
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <ul className="pv-bars">
      {rows.map((r) => (
        <li key={r.key} title={r.title}>
          <span className={mono ? 'pv-bar-name pv-mono' : 'pv-bar-name'}>{r.name}</span>
          <SplitBar split={r.split} share={r.value / max} order={order} />
          <span className="pv-bar-n">
            {r.label}
            <span className="sr-only">, {splitText(r.split, order)}</span>
          </span>
        </li>
      ))}
    </ul>
  )
}

function Square({
  day,
  busiest,
  order
}: {
  day: ActivityDay
  busiest: number
  order: readonly Provider[]
}): JSX.Element {
  const lv = level(day.sessions, busiest)
  const agent = dominant(day)
  const label =
    day.sessions === 0
      ? `${fmtDay(day.day)} — no sessions`
      : reading(fmtDay(day.day), counted(day.sessions, 'session'), splitText(day.byProvider, order))
  return (
    <div
      className="pv-sq"
      title={label}
      style={lv === 0 || !agent ? undefined : { background: fill(agent, LEVEL_ALPHA[lv]) }}
    />
  )
}

/**
 * GitHub-style grid: 7 rows (Mon–Sun), one column per week, oldest column first.
 * Leading blanks pad the first week so weekdays line up across columns.
 */
function Heatmap({
  days,
  busiest,
  order
}: {
  days: ActivityDay[]
  busiest: number
  order: readonly Provider[]
}): JSX.Element {
  const { cells, months } = useMemo(() => {
    if (days.length === 0) return { cells: [] as (ActivityDay | null)[], months: [] }
    const first = days[0]
    const [y, m, d] = first.day.split('-').map(Number)
    // getDay() is 0=Sun; shift so Monday starts the column
    const pad = (new Date(y, m - 1, d).getDay() + 6) % 7
    const cells: (ActivityDay | null)[] = [...Array(pad).fill(null), ...days]

    // one label per column whose week contains the 1st of a month
    const months: { col: number; label: string }[] = []
    for (let i = pad; i < cells.length; i++) {
      const day = cells[i]
      if (!day) continue
      const dayOfMonth = Number(day.day.split('-')[2])
      if (dayOfMonth > 7) continue
      const col = Math.floor(i / 7)
      if (months.some((x) => x.col === col)) continue
      const [yy, mm] = day.day.split('-').map(Number)
      const label = new Date(yy, mm - 1, 1).toLocaleDateString(undefined, { month: 'short' })
      if (months[months.length - 1]?.label === label) continue
      months.push({ col, label })
    }
    return { cells, months }
  }, [days])

  const weeks = Math.ceil(cells.length / 7)
  const active = days.filter((d) => d.sessions > 0)
  // the hues in words: color must not be the only thing that carries the agent mix
  const led: AgentSplit = {}
  for (const d of active) {
    const p = dominant(d)
    if (p) led[p] = (led[p] ?? 0) + 1
  }
  const ledText = ordered(led, order)
    .map(([p, n]) => `${PROVIDER_LABEL[p]} led ${n}`)
    .join(', ')
  const label = `Activity over the last ${days.length} days: ${counted(active.length, 'active day')}`

  return (
    <div className="pv-heat-scroll">
      <div className="pv-heat" style={{ '--pv-weeks': weeks } as CSSProperties}>
        <div className="pv-months" aria-hidden="true">
          {months.map((mo) => (
            <span key={`${mo.col}-${mo.label}`} style={{ gridColumn: mo.col + 1 }}>
              {mo.label}
            </span>
          ))}
        </div>
        <div className="pv-weekdays" aria-hidden="true">
          {WEEKDAY_LABELS.map((w, i) => (
            <span key={w} style={{ gridRow: i * 2 + 1 }}>
              {w}
            </span>
          ))}
        </div>
        <div
          className="pv-grid"
          role="img"
          aria-label={ledText ? `${label} — ${ledText}` : label}
        >
          {cells.map((day, i) =>
            day ? (
              <Square key={day.day} day={day} busiest={busiest} order={order} />
            ) : (
              <div key={`pad-${i}`} className="pv-sq pv-sq-pad" />
            )
          )}
        </div>
      </div>
    </div>
  )
}

/**
 * Sessions started per hour, midnight→23, each bar stacked by the agents that ran
 * them. A quiet strip — the tallest hour is named in the line under it, the bars just
 * show the shape of the day. Bars and marks share one 24-column grid, so "18" sits
 * under the 18:00 bar rather than wherever even spacing happened to put it.
 */
function Rhythm({ hours, order }: { hours: SessionTally[]; order: readonly Provider[] }): JSX.Element {
  const totals = hours.map((h) => h.sessions)
  const max = Math.max(1, ...totals)
  const peak = totals.indexOf(Math.max(...totals))
  const total = totals.reduce((a, b) => a + b, 0)
  const label = `Sessions by hour of day; busiest around ${hh(peak)}:00`
  return (
    <div className="pv-rhythm-wrap">
      <div className="pv-rhythm" role="img" aria-label={label}>
        {hours.map((h, i) => (
          <span
            key={i}
            className="pv-hour"
            title={reading(`${hh(i)}:00`, counted(h.sessions, 'session'), splitText(h.byProvider, order))}
          >
            {h.sessions > 0 && (
              <span
                className="pv-hour-fill"
                style={{ height: `${Math.max(8, Math.round((h.sessions / max) * 100))}%` }}
              >
                {ordered(h.byProvider, order).map(([p, n]) => (
                  <i key={p} style={{ flexGrow: n, background: fill(p) }} />
                ))}
              </span>
            )}
          </span>
        ))}
      </div>
      <div className="pv-rhythm-axis" aria-hidden="true">
        {HOUR_MARKS.map((h) => (
          <span key={h} style={{ gridColumn: h + 1 }}>
            {hh(h)}
          </span>
        ))}
      </div>
      {total > 0 && (
        <p className="ns-hint">
          Busiest around {hh(peak)}:00 — {counted(hours[peak].sessions, 'session')} started in that
          hour.
        </p>
      )}
    </div>
  )
}

function Stat({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="pv-stat">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function Diff({ added, removed }: { added: number; removed: number }): JSX.Element {
  return (
    <span className="pv-diff">
      <em className="pv-add">+{fmtNum(added)}</em>
      <em className="pv-del">−{fmtNum(removed)}</em>
    </span>
  )
}

/**
 * The page's thesis at a glance, and the key to every agent color below it: one bar
 * of sessions cut by agent, with the share of each spelled out.
 */
function AgentMix({ providers }: { providers: readonly ProviderProfile[] }): JSX.Element {
  const total = providers.reduce((n, p) => n + p.sessions, 0)
  return (
    <div className="pv-mix">
      <span className="pv-bar pv-mix-bar" aria-hidden="true">
        <span className="pv-bar-fill">
          {providers.map((p) => (
            <i key={p.provider} style={{ flexGrow: p.sessions, background: fill(p.provider) }} />
          ))}
        </span>
      </span>
      <div className="pv-mix-key">
        <span className="pv-mix-label" aria-hidden="true">
          sessions by agent
        </span>
        <ul aria-label="Sessions by agent">
          {providers.map((p) => (
            <li
              key={p.provider}
              title={`${PROVIDER_LABEL[p.provider]} — ${counted(p.sessions, 'session')}`}
            >
              <i className="pv-swatch" style={{ background: fill(p.provider) }} aria-hidden="true" />
              {PROVIDER_LABEL[p.provider]} <strong>{pct(p.sessions, total)}</strong>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

const UNTRACKED =
  'No edit-tool calls in these logs. Edits made through shell commands — sed, a heredoc, ' +
  'a script — leave nothing countable behind.'

/**
 * The comparison the view exists for: agents as columns, one measure per row, so
 * reading across a row is reading Claude against Codex against Copilot. Rates are per
 * session the deep pass could read — a session whose log it couldn't open added nothing.
 */
function Compare({ providers }: { providers: readonly ProviderProfile[] }): JSX.Element {
  /** A measure read from the logs themselves: nothing to say when they were unreadable */
  const deep = (p: ProviderProfile, cell: () => ReactNode): ReactNode =>
    p.deepUnavailable ? (
      <span className="pv-na" title={p.deepUnavailable}>
        —
      </span>
    ) : (
      cell()
    )
  const none = <span className="pv-na">—</span>
  const rows: { label: string; cell: (p: ProviderProfile) => ReactNode }[] = [
    { label: 'Sessions', cell: (p) => fmtNum(p.sessions) },
    { label: 'Active days', cell: (p) => fmtNum(p.activeDays) },
    {
      label: 'Prompts per session',
      cell: (p) => deep(p, () => (p.readSessions > 0 ? fmtRate(p.prompts / p.readSessions) : none))
    },
    {
      label: 'Tool calls per prompt',
      cell: (p) => deep(p, () => (p.prompts > 0 ? fmtRate(p.toolCalls / p.prompts) : none))
    },
    {
      label: 'Lines edited',
      cell: (p) =>
        p.deepUnavailable ? (
          <span className="source-warn">{p.deepUnavailable}</span>
        ) : p.linesAdded === 0 && p.linesRemoved === 0 ? (
          // Not a parse failure: an agent that edits through shell commands rather
          // than a structured edit tool leaves nothing countable in its log
          <span className="pv-untracked" title={UNTRACKED}>
            none measured
          </span>
        ) : (
          <Diff added={p.linesAdded} removed={p.linesRemoved} />
        )
    },
    {
      label: 'Files edited',
      cell: (p) => deep(p, () => (p.filesTouched > 0 ? fmtNum(p.filesTouched) : none))
    },
    {
      label: 'Top tools',
      cell: (p) =>
        deep(p, () =>
          p.tools.length === 0 ? (
            none
          ) : (
            <ol className="pv-tools" title={p.tools.map((t) => `${t.name} ${t.count}`).join(', ')}>
              {p.tools.slice(0, 3).map((t) => (
                <li key={t.name}>
                  <span className="pv-tool-name">{t.name}</span>
                  <span className="pv-tool-n">{fmtNum(t.count)}</span>
                </li>
              ))}
            </ol>
          )
        )
    }
  ]
  return (
    <div className="pv-compare-wrap">
      <table className="pv-compare">
        <thead>
          <tr>
            <td />
            {providers.map((p) => (
              <th
                key={p.provider}
                scope="col"
                style={{ '--pv-agent': `var(--${p.provider}-rgb)` } as CSSProperties}
              >
                <span className="pv-th">
                  <span className={`plogo plogo-${p.provider}`} aria-hidden="true">
                    <ProviderLogo p={p.provider} size={13} />
                  </span>
                  {PROVIDER_LABEL[p.provider]}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <th scope="row">{r.label}</th>
              {providers.map((p) => (
                <td key={p.provider}>{r.cell(p)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function ProfileView({ onClose }: { onClose: () => void }): JSX.Element {
  const [profile, setProfile] = useState<ProfileStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<ProfileTab>('activity')
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
    let live = true
    api
      .getProfile()
      .then((p) => live && setProfile(p))
      .catch((e) => live && setError(ipcErrorText(e)))
    return () => {
      live = false
    }
  }, [])

  // scale the grid by the busiest day *in the grid*: busiestDay is all-time and
  // can sit outside the rendered window, which would flatten every square to L1
  const busiest = Math.max(0, ...(profile?.days ?? []).map((d) => d.sessions))
  const providers = profile?.providers ?? []
  const order = providers.map((p) => p.provider)
  const lead = order[0] ?? null
  const busiestDay = profile?.busiestDay ?? null
  const linesAdded = providers.reduce((n, p) => n + p.linesAdded, 0)
  const linesRemoved = providers.reduce((n, p) => n + p.linesRemoved, 0)

  /** One page per tab: a `Record` will not compile with a tab that has no page behind it. */
  const panels: Record<ProfileTab, JSX.Element> | null = profile && {
    activity: (
      <>
        <h3 className="ns-label">By day</h3>
        <Heatmap days={profile.days} busiest={busiest} order={order} />
        <div className="pv-legend">
          <span>
            {busiestDay &&
              `Busiest day ${fmtDay(busiestDay.day)} · ${counted(busiestDay.sessions, 'session')}`}
          </span>
          {/* intensity, in the hue most squares wear; the headline's key names the rest */}
          <span className="pv-scale">
            Less
            {Array.from({ length: LEVELS + 1 }, (_, i) => (
              <i
                key={i}
                className="pv-sq"
                style={i === 0 || !lead ? undefined : { background: fill(lead, LEVEL_ALPHA[i]) }}
              />
            ))}
            More
          </span>
        </div>

        <h3 className="ns-label">By hour</h3>
        <Rhythm hours={profile.hours} order={order} />
      </>
    ),
    agents: (
      <>
        <h3 className="ns-label">By agent</h3>
        <p className="ns-hint ns-prose">
          Prompts are the messages you sent. Lines are counted from each agent&apos;s own edit
          tools — they measure edits made, not diff that survived to a commit.
        </p>
        <Compare providers={providers} />

        {profile.models.length > 0 && (
          <>
            <h3 className="ns-label">Models</h3>
            <p className="ns-hint ns-prose">
              Counted in assistant messages and split by the agent that served them — model
              families cross agent lines.
            </p>
            <BarList
              mono
              order={order}
              rows={profile.models.map((m) => ({
                key: m.name,
                name: m.name,
                title: reading(m.name, counted(m.count, 'message'), splitText(m.byProvider, order)),
                split: m.byProvider,
                value: m.count,
                label: counted(m.count, 'msg')
              }))}
            />
          </>
        )}

        {profile.accounts.length > 0 && (
          <>
            <h3 className="ns-label">Accounts</h3>
            <ul className="pv-accounts">
              {profile.accounts.map((a) => (
                <li key={`${a.provider}:${a.label}`}>
                  <span className={`plogo plogo-${a.provider}`} aria-hidden="true">
                    <ProviderLogo p={a.provider} size={13} />
                  </span>
                  {a.identity ? (
                    <span className={`acct-chip acct-${a.provider}`}>{a.identity}</span>
                  ) : (
                    <span className="acct-chip missing">not signed in</span>
                  )}
                  <span className="pv-acct-label">{a.label}</span>
                  {a.lastActivity > 0 && (
                    <time
                      className="pv-acct-last"
                      dateTime={new Date(a.lastActivity).toISOString()}
                      title={`Last session ${new Date(a.lastActivity).toLocaleString()}`}
                    >
                      {fmtAgo(a.lastActivity)}
                    </time>
                  )}
                  <span className="repo-count">{fmtNum(a.sessions)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </>
    ),
    code: (
      <>
        {profile.languages.length > 0 && (
          <>
            <h3 className="ns-label">Languages</h3>
            <BarList
              mono
              order={order}
              rows={profile.languages.map((l) => ({
                key: l.ext,
                name: `.${l.ext}`,
                title: reading(
                  `.${l.ext}`,
                  `${counted(l.linesAdded, 'line')} added in ${counted(l.files, 'file')}`,
                  splitText(l.byProvider, order)
                ),
                split: l.byProvider,
                value: l.linesAdded,
                label: `${counted(l.linesAdded, 'line')} · ${counted(l.files, 'file')}`
              }))}
            />
          </>
        )}

        {profile.repos.length > 0 && (
          <>
            <h3 className="ns-label">Top repos</h3>
            <BarList
              order={order}
              rows={profile.repos.map((r) => {
                const chats = r.key === 'general'
                const [owner, name] = r.fullName?.includes('/') ? r.fullName.split('/') : [null, r.name]
                return {
                  key: r.key,
                  name: (
                    <>
                      {chats ? <ChatIcon size={13} /> : <RepoIcon size={13} />}
                      {chats ? (
                        'Chats'
                      ) : (
                        <>
                          {owner && <span className="repo-owner">{owner}/</span>}
                          {name}
                        </>
                      )}
                    </>
                  ),
                  title: reading(
                    chats ? 'Chats' : (r.fullName ?? r.name),
                    counted(r.sessions, 'session'),
                    splitText(r.byProvider, order)
                  ),
                  split: r.byProvider,
                  value: r.sessions,
                  label: <span className="repo-count">{fmtNum(r.sessions)}</span>
                }
              })}
            />
          </>
        )}
      </>
    )
  }

  return (
    <main className="chat settings-view">
      <div className="ns-card">
        <div className="ns-head">
          <h2 ref={headingRef} tabIndex={-1}>
            Profile
          </h2>
          <button className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>

        {error ? (
          <p className="ns-hint ns-prose">Couldn&apos;t build the profile — {error}</p>
        ) : !profile ? (
          <p className="ns-hint" aria-live="polite">
            <span className="pulse" aria-hidden="true" /> Reading your session history…
          </p>
        ) : profile.totalSessions === 0 ? (
          <p className="ns-hint ns-prose">No sessions indexed yet — start one and this fills in.</p>
        ) : (
          <>
            <p className="ns-hint ns-prose">
              {profile.login ? <strong>{profile.login}</strong> : 'Your work'} across every agent
              Cockpit indexes
              {profile.since ? <> — since {fmtSince(profile.since)}</> : null}.
            </p>

            <div className="pv-stats">
              <dl className="pv-nums">
                <Stat label="sessions">{fmtNum(profile.totalSessions)}</Stat>
                <Stat label="active days">{fmtNum(profile.activeDays)}</Stat>
                <Stat label="day streak">{fmtNum(profile.currentStreak)}</Stat>
                <Stat label="longest streak">{fmtNum(profile.longestStreak)}</Stat>
                <Stat label="lines edited">
                  {linesAdded === 0 && linesRemoved === 0 ? (
                    '0'
                  ) : (
                    <Diff added={linesAdded} removed={linesRemoved} />
                  )}
                </Stat>
              </dl>
              {providers.length > 0 && <AgentMix providers={providers} />}
            </div>

            <TabList
              id="profile"
              label="Profile sections"
              tabs={PROFILE_TABS.filter(
                (t) => t.id !== 'code' || profile.languages.length > 0 || profile.repos.length > 0
              )}
              selected={tab}
              onSelect={setTab}
            />
            <TabPanel id="profile" selected={tab}>
              {panels?.[tab]}
            </TabPanel>
          </>
        )}
      </div>
    </main>
  )
}
