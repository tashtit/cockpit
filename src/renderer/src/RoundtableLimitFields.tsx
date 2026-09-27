import type { JSX } from 'react'
import type { RoundtableLimits } from '../../shared/types'
import { Select, type SelectOption } from './Select'

/** Ceiling presets — within ROUNDTABLE_LIMIT_RANGE, which main enforces */
const MESSAGE_LIMITS = [4, 8, 12, 16, 24, 32, 64]
const TABLE_LIMITS = [20, 40, 80, 160, 320, 0]
/** Time-limit presets, in minutes */
const MINUTE_LIMITS = [5, 10, 15, 30, 60, 0]

/** Presets plus whatever value is current, shown as itself — a hand-edited or saved
 *  value off the list must not read as the first preset. */
function withCurrent(presets: readonly number[], current: number): readonly number[] {
  // 0 means "no ceiling" / "no limit", so it sorts as the largest
  const rank = (n: number): number => (n === 0 ? Infinity : n)
  return presets.includes(current) ? presets : [...presets, current].sort((a, b) => rank(a) - rank(b))
}

/** A ceiling's options: its presets plus whatever value is current, shown as itself. */
function limitOptions(presets: readonly number[], current: number): SelectOption[] {
  return withCurrent(presets, current).map((n) => ({ value: String(n), label: n === 0 ? 'no ceiling' : `${n} turns` }))
}

/** The time-limit presets, plus a hand-edited value shown as itself; 0 = no limit. */
function minuteOptions(current: number): SelectOption[] {
  return withCurrent(MINUTE_LIMITS, current).map((n) => ({
    value: String(n),
    label: n === 0 ? 'no limit' : `${n} min`,
    title: 'a seat still going after this is skipped — the round carries on without it'
  }))
}

/**
 * What a table may spend — agent turns per message, for the whole table, and the
 * longest a seat may take — as the New roundtable form sets them and the table's own
 * editor raises them. The caller supplies the group around them.
 */
export function RoundtableLimitFields({
  idPrefix,
  limits,
  onChange
}: {
  /** Prefixes each field's id, so the form's and the table's never collide */
  idPrefix: string
  limits: RoundtableLimits
  onChange: (limits: RoundtableLimits) => void
}): JSX.Element {
  return (
    <>
      <div className="ns-opt">
        <label className="ns-label" htmlFor={`${idPrefix}-message`}>Agent turns per message</label>
        <Select
          id={`${idPrefix}-message`}
          ariaLabel="Agent turns per message"
          value={String(limits.maxTurnsPerMessage)}
          options={limitOptions(MESSAGE_LIMITS, limits.maxTurnsPerMessage)}
          onChange={(v) => onChange({ ...limits, maxTurnsPerMessage: Number(v) })}
        />
      </div>
      <div className="ns-opt">
        <label className="ns-label" htmlFor={`${idPrefix}-table`}>Agent turns for the table</label>
        <Select
          id={`${idPrefix}-table`}
          ariaLabel="Agent turns for the table"
          value={String(limits.maxTurnsPerTable)}
          options={limitOptions(TABLE_LIMITS, limits.maxTurnsPerTable)}
          onChange={(v) => onChange({ ...limits, maxTurnsPerTable: Number(v) })}
        />
      </div>
      <div className="ns-opt">
        <label className="ns-label" htmlFor={`${idPrefix}-minutes`}>Longest a seat may take</label>
        <Select
          id={`${idPrefix}-minutes`}
          ariaLabel="Longest a seat may take"
          value={String(limits.maxTurnMinutes)}
          options={minuteOptions(limits.maxTurnMinutes)}
          onChange={(v) => onChange({ ...limits, maxTurnMinutes: Number(v) })}
        />
      </div>
    </>
  )
}
