import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type { ActivityDay, ModelStat, ProfileStats, Provider } from '../../shared/types'
import { api } from './api'
import { ProviderLogo, PROVIDER_LABEL, RepoIcon } from './logos'

/**
 * The cross-agent work profile: an activity heatmap plus per-agent totals.
 * Every number arrives pre-aggregated from main (see profile.ts) — this view
 * only formats and lays out; it never sees a session.
 */

/** Heatmap intensity steps. Index 0 is "no work"; the rest scale by session count. */
const LEVELS = 4

/** Squares carry no text, so they scale past the 0.10–0.16 tint range used behind labels. */
const LEVEL_ALPHA = [0, 0.22, 0.42, 0.66, 0.92]

const WEEKDAY_LABELS = ['Mon', 'Wed', 'Fri']

function fmtNum(n: number): string {
  return n.toLocaleString()
}

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
 * Bucket a day's session count into an intensity step. Scaled against the
 * busiest day so the grid reads the same whether you run 5 or 50 a day.
 */
function level(sessions: number, busiest: number): number {
  if (sessions <= 0) return 0
  if (busiest <= 1) return LEVELS
  return Math.max(1, Math.min(LEVELS, Math.ceil((sessions / busiest) * LEVELS)))
}

function Square({ day, busiest }: { day: ActivityDay; busiest: number }): JSX.Element {
  const lv = level(day.sessions, busiest)
  const agent = dominant(day)
  const parts = Object.entries(day.byProvider)
    .map(([p, n]) => `${n} ${PROVIDER_LABEL[p as Provider]}`)
    .join(' · ')
  const label =
    day.sessions === 0
      ? `${fmtDay(day.day)} — no sessions`
      : `${fmtDay(day.day)} — ${day.sessions} session${day.sessions === 1 ? '' : 's'} (${parts})`
  return (
    <div
      className="pv-sq"
      title={label}
      style={
        lv === 0 || !agent
          ? undefined
          : { background: `rgba(var(--${agent}-rgb), ${LEVEL_ALPHA[lv]})` }
      }
    />
  )
}

/**
 * GitHub-style grid: 7 rows (Mon–Sun), one column per week, oldest column first.
 * Leading blanks pad the first week so weekdays line up across columns.
 */
function Heatmap({ days, busiest }: { days: ActivityDay[]; busiest: number }): JSX.Element {
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
  const active = days.filter((d) => d.sessions > 0).length

  return (
    <div className="pv-heat-scroll">
      <div className="pv-heat" style={{ '--pv-weeks': weeks } as React.CSSProperties}>
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
          aria-label={`Activity over the last ${days.length} days: ${active} active days`}
        >
          {cells.map((day, i) =>
            day ? (
              <Square key={day.day} day={day} busiest={busiest} />
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
 * One model's usage bar, segmented by the agents that served it. The split is
 * the point: model families cross agent boundaries (Copilot serves claude-opus,
 * Claude serves fable), so a flat bar would erase the page's best insight.
 */
function ModelBar({ model, max }: { model: ModelStat; max: number }): JSX.Element {
  const width = Math.max(2, Math.round((model.count / max) * 100))
  const parts = Object.entries(model.byProvider) as [Provider, number][]
  const split = parts.map(([p, n]) => `${PROVIDER_LABEL[p]} ${fmtNum(n)}`).join(' · ')
  return (
    <li title={`${model.name} — ${fmtNum(model.count)} messages (${split})`}>
      <span className="pv-model-name">{model.name}</span>
      <span className="pv-bar" aria-hidden="true">
        <span className="pv-bar-split" style={{ width: `${width}%` }}>
          {parts.map(([p, n]) => (
            <i
              key={p}
              style={{
                flexGrow: n,
                background: `rgba(var(--${p}-rgb), 0.85)`
              }}
            />
          ))}
        </span>
      </span>
      <span className="pv-lang-n">{fmtNum(model.count)} msgs</span>
    </li>
  )
}

/**
 * Sessions started per hour, midnight→23. A quiet strip — the tallest hour is
 * labeled in the summary line, the bars just show the shape of the day.
 */
function Rhythm({ hours }: { hours: number[] }): JSX.Element {
  const max = Math.max(1, ...hours)
  const peak = hours.indexOf(Math.max(...hours))
  const total = hours.reduce((a, b) => a + b, 0)
  const label = `Sessions by hour of day; busiest around ${String(peak).padStart(2, '0')}:00`
  return (
    <div className="pv-rhythm-wrap">
      <div className="pv-rhythm" role="img" aria-label={label}>
        {hours.map((n, h) => (
          <i
            key={h}
            style={{ height: `${Math.max(n > 0 ? 8 : 2, Math.round((n / max) * 100))}%` }}
            title={`${String(h).padStart(2, '0')}:00 — ${fmtNum(n)} session${n === 1 ? '' : 's'}`}
          />
        ))}
      </div>
      <div className="pv-rhythm-axis" aria-hidden="true">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>23</span>
      </div>
      {total > 0 && (
        <p className="ns-hint">
          Busiest around {String(peak).padStart(2, '0')}:00 — {fmtNum(hours[peak])} sessions
          started in that hour.
        </p>
      )}
    </div>
  )
}

function Stat({ value, label }: { value: string; label: string }): JSX.Element {
  return (
    <div className="pv-stat">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  )
}

export function ProfileView({ onClose }: { onClose: () => void }): JSX.Element {
  const [profile, setProfile] = useState<ProfileStats | null>(null)
  const [error, setError] = useState<string | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
    let live = true
    api
      .getProfile()
      .then((p) => live && setProfile(p))
      .catch((e) => live && setError(String(e?.message ?? e)))
    return () => {
      live = false
    }
  }, [])

  const busiest = profile?.busiestDay?.sessions ?? 0
  const totalLines = (profile?.providers ?? []).reduce((n, p) => n + p.linesAdded, 0)
  const maxLang = Math.max(1, ...(profile?.languages ?? []).map((l) => l.linesAdded))

  return (
    <main className="chat settings-view">
      <div className="ns-card wide">
        <div className="ns-head">
          <h2 ref={headingRef} tabIndex={-1}>
            Profile
          </h2>
          <button className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>

        {error ? (
          <p className="ns-hint">Couldn&apos;t build the profile — {error}</p>
        ) : !profile ? (
          <p className="ns-hint" aria-live="polite">
            <span className="pulse" aria-hidden="true" /> Reading your session history…
          </p>
        ) : profile.totalSessions === 0 ? (
          <p className="ns-hint">No sessions indexed yet — start one and this fills in.</p>
        ) : (
          <>
            <p className="ns-hint">
              {profile.login ? <strong>{profile.login}</strong> : 'Your work'} across every agent
              Cockpit indexes
              {profile.since ? <> — since {fmtSince(profile.since)}</> : null}.
            </p>

            <div className="pv-stats">
              <Stat value={fmtNum(profile.totalSessions)} label="sessions" />
              <Stat value={fmtNum(profile.activeDays)} label="active days" />
              <Stat value={fmtNum(profile.currentStreak)} label="day streak" />
              <Stat value={fmtNum(profile.longestStreak)} label="longest streak" />
              <Stat value={fmtNum(totalLines)} label="lines edited" />
            </div>

            <h3 className="ns-label">Activity</h3>
            <Heatmap days={profile.days} busiest={busiest} />
            <div className="pv-legend">
              <span>
                {profile.busiestDay
                  ? `Busiest day ${fmtDay(profile.busiestDay.day)} · ${profile.busiestDay.sessions} sessions`
                  : ''}
              </span>
              <span className="pv-scale">
                Less
                {Array.from({ length: LEVELS + 1 }, (_, i) => (
                  <i
                    key={i}
                    className="pv-sq"
                    style={
                      i === 0
                        ? undefined
                        : { background: `rgba(var(--accent-rgb), ${LEVEL_ALPHA[i]})` }
                    }
                  />
                ))}
                More
              </span>
            </div>

            <h3 className="ns-label">Rhythm</h3>
            <Rhythm hours={profile.hourCounts} />

            <h3 className="ns-label">Agents</h3>
            <p className="ns-hint">
              Lines are counted from each agent&apos;s own edit tools — they measure edits made,
              not diff that survived to a commit.
            </p>
            <ul className="pv-agents">
              {profile.providers.map((p) => (
                <li key={p.provider} className={`pv-agent tint-${p.provider}`}>
                  <span className={`plogo plogo-${p.provider}`} aria-hidden="true">
                    <ProviderLogo p={p.provider} size={13} />
                  </span>
                  <div className="pv-agent-body">
                    <div className="pv-agent-head">
                      {PROVIDER_LABEL[p.provider]}
                      <span className="repo-count">{fmtNum(p.sessions)}</span>
                      <span className="pv-agent-days">
                        {p.activeDays} active day{p.activeDays === 1 ? '' : 's'}
                        {p.avgTurns > 0 && <> · ~{fmtNum(p.avgTurns)} turns/session</>}
                      </span>
                    </div>
                    <div className="pv-agent-meta">
                      {p.deepUnavailable ? (
                        <span className="source-warn">{p.deepUnavailable}</span>
                      ) : (
                        <>
                          {p.linesAdded === 0 && p.linesRemoved === 0 ? (
                            // Not a parse failure: some agents (codex especially) edit
                            // through shell commands rather than a structured edit tool,
                            // and those leave nothing countable in the log.
                            <span
                              className="pv-untracked"
                              title="This agent edits through shell commands rather than a structured edit tool, so its line changes aren't recorded in the session log."
                            >
                              no measurable edits
                            </span>
                          ) : (
                            <>
                              <span className="pv-diff">
                                <em className="pv-add">+{fmtNum(p.linesAdded)}</em>
                                <em className="pv-del">−{fmtNum(p.linesRemoved)}</em>
                              </span>
                              <span>{fmtNum(p.filesTouched)} files</span>
                            </>
                          )}
                          {p.tools.length > 0 && (
                            <span className="pv-tools" title={p.tools.map((t) => `${t.name} ${t.count}`).join(', ')}>
                              {p.tools.slice(0, 3).map((t) => t.name).join(' · ')}
                            </span>
                          )}
                        </>
                      )}
                    </div>
                    {p.models.length > 0 && (
                      <div className="pv-models">
                        {p.models.slice(0, 3).map((m) => (
                          <span key={m.name} className={`acct-chip acct-${p.provider}`}>
                            {m.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ul>

            {profile.models.length > 0 && (
              <>
                <h3 className="ns-label">Models</h3>
                <p className="ns-hint">
                  Counted in assistant messages, colored by the agent that served them — model
                  families cross agent lines, so the split is worth watching.
                </p>
                <ul className="pv-langs pv-models-list">
                  {profile.models.map((m) => (
                    <ModelBar key={m.name} model={m} max={profile.models[0].count} />
                  ))}
                </ul>
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
                      <span className="repo-count">{fmtNum(a.sessions)}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {profile.languages.length > 0 && (
              <>
                <h3 className="ns-label">Languages</h3>
                <ul className="pv-langs">
                  {profile.languages.map((l) => (
                    <li key={l.ext}>
                      <span className="pv-lang-ext">.{l.ext}</span>
                      <span className="pv-bar" aria-hidden="true">
                        <i style={{ width: `${Math.round((l.linesAdded / maxLang) * 100)}%` }} />
                      </span>
                      <span className="pv-lang-n">
                        {fmtNum(l.linesAdded)} lines · {fmtNum(l.files)} files
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {profile.repos.length > 0 && (
              <>
                <h3 className="ns-label">Top repos</h3>
                <ul className="pv-repos">
                  {profile.repos.map((r) => (
                    <li key={r.key}>
                      <RepoIcon size={13} />
                      <span className="pv-repo-name">{r.name}</span>
                      <span className="repo-count">{fmtNum(r.sessions)}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
    </main>
  )
}
