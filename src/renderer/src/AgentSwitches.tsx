import type { JSX } from 'react'
import { PROVIDERS, isDrift, type PanelRow } from '../../shared/library'
import type { Provider } from '../../shared/types'
import { disarmOn } from './disarm'
import { ProviderLogo, PROVIDER_LABEL } from './logos'

/** What every set of chips shares with the panel around it. */
export type Switching = {
  /** key whose destructive action is in its armed step */
  readonly armed: string | null
  /** cell key or row id currently being written */
  readonly busy: string | null
  readonly onFlip: (row: PanelRow, agent: Provider, on: boolean) => void
  readonly onDisarm: () => void
}

export function cellKey(row: PanelRow, agent: Provider): string {
  return `${row.id}|${agent}`
}

/** Whether one of this row's chips is in its armed step. */
export function chipArmed(row: PanelRow, armed: string | null): boolean {
  return armed !== null && armed.startsWith(`${row.id}|`)
}

/** The armed state reads as a placard in the row's flag slot, like every other warning. */
export function ArmedFlag(): JSX.Element {
  return <em className="pnl-flag danger">click again to remove</em>
}

/**
 * The row's signature: one self-labelling switch per agent, in that agent's livery.
 * Its own component because the Instructions section shows the switches without the
 * row around them — the editor above already is that row, opened.
 */
export function AgentSwitches({
  row,
  armed,
  busy,
  onFlip,
  onDisarm
}: Switching & { readonly row: PanelRow }): JSX.Element {
  return (
    <span className="pnl-chips">
      {PROVIDERS.map((p) => {
        const cell = row.cells[p]
        const key = cellKey(row, p)
        if (cell.state === 'na') {
          return (
            <span key={p} className="ag-chip na" title={cell.reason}>
              <ProviderLogo p={p} size={11} />
              {PROVIDER_LABEL[p]}
              <span className="sr-only">: not available — {cell.reason}</span>
            </span>
          )
        }
        const isArmed = armed === key
        return (
          <button
            key={p}
            role="switch"
            aria-checked={cell.desired}
            aria-label={`${row.name} in ${PROVIDER_LABEL[p]}`}
            title={
              isArmed
                ? 'Click again to remove it from this agent'
                : cell.kept
                  ? `${cell.detail || 'on'} — its own definition, kept on purpose`
                  : cell.state === 'pending'
                    ? cell.gone
                      ? 'on — but removed from its config outside Cockpit'
                      : 'on — but not written there yet'
                    : cell.detail || (cell.desired ? 'on' : 'off')
            }
            disabled={busy !== null}
            className={`ag-chip ag-${p} ${cell.desired ? 'on' : 'off'} ${
              isDrift(cell.state) ? 'drift' : ''
            } ${isArmed ? 'armed' : ''} ${busy === key ? 'working' : ''}`}
            {...(isArmed ? disarmOn(onDisarm) : {})}
            onClick={() => onFlip(row, p, !cell.desired)}
          >
            <ProviderLogo p={p} size={11} />
            {PROVIDER_LABEL[p]}
          </button>
        )
      })}
    </span>
  )
}
