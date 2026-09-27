import type { JSX } from 'react'
import {
  RECOMMENDED_MARKETPLACE,
  isRecommended,
  type PanelReport,
  type PanelRow
} from '../../shared/library'
import { AgentSwitches, ArmedFlag, chipArmed, type Switching } from './AgentSwitches'
import { api } from './api'
import { recommendationAnswered } from './recommended'

/**
 * Whether this visit offers the recommended marketplace: to someone who runs it in no
 * agent and hasn't answered the offer before. Decided once per visit, so the callout
 * stays while they add it agent by agent, and is gone the next time the panel opens.
 * Its row only exists in Global — marketplaces are per machine.
 */
export function offerFor(report: PanelReport): boolean {
  const row = report.rows.find(isRecommended)
  return row !== undefined && row.holders.length === 0 && !recommendationAnswered()
}

/** What the recommended marketplace is, said once for the callout and its own row. */
export const RECOMMENDED_PITCH =
  'Open-source plugins for focused commits and pull requests, secure CI, structured logging, API design and code review. Adding the marketplace installs none of them — you choose which, in each agent.'

/**
 * The panel's one recommendation: Tashtit's marketplace, offered to someone who runs it
 * in no agent. It carries the row's own switches, so adding it is an agent's chip — the
 * same reversible click as anywhere in the panel, and never more than the person picks.
 * Answering it (Not now, or Done once added) puts it away for good; the row stays under
 * Marketplaces either way.
 */
export function Recommendation({
  row,
  armed,
  busy,
  onFlip,
  onDisarm,
  onAnswer
}: Switching & {
  readonly row: PanelRow
  readonly onAnswer: () => void
}): JSX.Element {
  return (
    <section className="pnl-rec" aria-labelledby="pnl-rec-title">
      <div className="pnl-rec-head">
        <h3 id="pnl-rec-title" className="pnl-rec-title">
          Tashtit — engineering standards for your agents
        </h3>
        <span className="pnl-rec-tag">recommended</span>
      </div>
      <p className="pnl-rec-what">{RECOMMENDED_PITCH}</p>
      <div className="pnl-rec-act">
        <span className="pnl-sync-label">Add it to</span>
        <AgentSwitches row={row} armed={armed} busy={busy} onFlip={onFlip} onDisarm={onDisarm} />
        {chipArmed(row, armed) && <ArmedFlag />}
        <span className="pnl-rec-more">
          <button className="link-btn" onClick={() => void api.openExternal(RECOMMENDED_MARKETPLACE.page)}>
            What’s in it
          </button>
          <button className="btn-ghost small" disabled={busy !== null} onClick={onAnswer}>
            {row.holders.length > 0 ? 'Done' : 'Not now'}
          </button>
        </span>
      </div>
    </section>
  )
}
