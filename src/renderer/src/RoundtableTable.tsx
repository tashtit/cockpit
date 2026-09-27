import type { JSX } from 'react'
import type { RoundtableEntry, RoundtableParticipant, RoundtableSnapshot } from '../../shared/types'
import { ProviderLogo } from './logos'
import { cycleReplies, uiSeatName } from './roundtable-seats'

/** One line naming how a seat was set up: model, thinking, and the knobs it has on. */
function seatSetup(p: RoundtableParticipant): string {
  const o = p.options ?? {}
  return [
    o.model ?? 'default model',
    o.effort ? `${o.effort} thinking` : null,
    o.fast ? 'fast' : null,
    o.longContext ? 'long context' : null,
    o.modelEndpoint ? 'custom provider' : null
  ]
    .filter(Boolean)
    .join(' · ')
}

/** Point on the table edge (a quadratic arc) at parameter t ∈ [0,1], in % of the panel. */
function arcPoint(t: number): { x: number; y: number } {
  const u = 1 - t
  // P0 (4,91) — C (50,-36) — P1 (96,91), mirroring the SVG path below
  return {
    x: u * u * 4 + 2 * u * t * 50 + t * t * 96,
    y: u * u * 91 + 2 * u * t * -36 + t * t * 91
  }
}

/**
 * The table itself — the view's one signature element. Seats sit around an arc (the
 * tabletop edge), each carrying its live state: thinking, agrees, not yet, or quiet.
 * Everything it shows is derived; the arc breathes only while a round runs.
 */
export function RoundtableTable({
  rt,
  entries,
  speaking,
  running
}: {
  rt: RoundtableSnapshot
  entries: readonly RoundtableEntry[]
  speaking: readonly number[]
  running: boolean
}): JSX.Element {
  const replies = cycleReplies(rt.participants, entries)
  const seats = rt.participants.map((p, i) => {
    const last = replies[i]
    const thinking = speaking.includes(i)
    const status = thinking
      ? 'thinking…'
      : last?.stance === 'agree'
        ? 'agrees'
        : last?.stance === 'continue'
          ? 'not yet'
          : last
            ? 'spoke'
            : 'quiet'
    return {
      provider: p.provider,
      name: uiSeatName(rt.participants, i),
      status,
      thinking,
      setup: seatSetup(p)
    }
  })
  const n = seats.length
  return (
    <div className={`rt-table ${running ? 'running' : ''}`} role="group" aria-label="The table">
      <svg className="rt-table-arc" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <path className="rt-table-edge" d="M 4 91 Q 50 -36 96 91" />
        <path className="rt-table-glow" d="M 4 91 Q 50 -36 96 91" />
      </svg>
      {seats.map((s, i) => {
        const p = arcPoint((i + 1) / (n + 1))
        return (
          <div
            key={i}
            className={`rt-table-seat ${s.thinking ? 'thinking' : ''} status-${
              s.status === 'agrees' ? 'agree' : s.status === 'not yet' ? 'continue' : 'other'
            }`}
            style={{ left: `${p.x}%`, top: `${p.y}%` }}
            title={`${s.name}\n${s.setup}`}
          >
            <span className={`rt-seat plogo-${s.provider}`}>
              <ProviderLogo p={s.provider} size={14} />
              {s.thinking && <span className={`pulse pulse-${s.provider} rt-seat-pulse`} />}
            </span>
            <span className="rt-table-name">{s.name}</span>
            <span className="rt-table-status">{s.status}</span>
            {/* what this seat runs on — the form's choices, readable on the table itself */}
            <span className="rt-table-setup">{s.setup}</span>
          </div>
        )
      })}
    </div>
  )
}
