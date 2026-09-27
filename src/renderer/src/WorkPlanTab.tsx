import { useEffect, useState, type JSX } from 'react'
import type { Provider } from '../../shared/types'
import type { WorkModel } from '../../shared/work'
import { PROVIDER_LABEL } from './logos'
import { Markdown } from './Markdown'
import { fmtTime, useTimeFormat } from './time'
import type { WorkFocus } from './work-tab'

/** The Work panel's Plan tab: the plan the agent proposed, every version of it. */
export function WorkPlanTab({
  model,
  focus,
  pendingPlanKey,
  provider
}: {
  model: WorkModel
  focus: WorkFocus
  pendingPlanKey: number | null
  provider: Provider
}): JSX.Element {
  const fmt = useTimeFormat()
  const { plans } = model
  // a row opens its own version of the plan; otherwise the latest is the one that counts
  const [at, setAt] = useState(() => indexFor(plans, focus.key))
  useEffect(() => setAt(indexFor(plans, focus.key)), [focus.at])
  if (plans.length === 0) {
    return (
      <p className="work-empty">
        No plan yet. When {PROVIDER_LABEL[provider]} proposes one in plan mode, it opens here to read before you
        approve it.
      </p>
    )
  }
  const i = Math.min(at ?? plans.length - 1, plans.length - 1)
  const plan = plans[i]!
  const latest = i === plans.length - 1
  return (
    <>
      <div className="work-meta">
        {plans.length > 1 && (
          <span className="work-versions" role="group" aria-label="Plan versions">
            <button className="btn-ghost small" disabled={i === 0} onClick={() => setAt(i - 1)}>
              Earlier
            </button>
            <span className="work-version">
              version {i + 1} of {plans.length}
            </span>
            <button className="btn-ghost small" disabled={latest} onClick={() => setAt(i + 1)}>
              Later
            </button>
          </span>
        )}
        {plan.ts && <span>proposed {fmtTime(plan.ts, fmt)}</span>}
        {plan.key === pendingPlanKey && <span className="work-flag">waiting for your approval</span>}
        {!latest && <span>a newer version follows</span>}
      </div>
      <div className="markdown work-plan">
        <Markdown text={plan.text} />
      </div>
    </>
  )
}

/** The plan a row points at, or null for "the latest". */
function indexFor(plans: WorkModel['plans'], key: number | null): number | null {
  const i = key === null ? -1 : plans.findIndex((p) => p.key === key)
  return i < 0 ? null : i
}
