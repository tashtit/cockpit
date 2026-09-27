import type { JSX, RefObject } from 'react'
import { shortPath } from '../../shared/library'
import type { SessionProvider } from '../../shared/types'
import { followUpSummary, type FollowUpEntry, type WorkModel } from '../../shared/work'
import { PROVIDER_LABEL } from './logos'
import { storedValue } from './stored-value'
import { fmtTime } from './format'
import { useTimeFormat } from './time'
import { useRing, type WorkFocus } from './work-tab'

/** The Work panel's Follow-ups tab: work the agent suggested for sessions of their own. */

/** When the person started each suggestion, per machine (`stored-value.ts`): a
 *  convenience, so a lost one only offers Start again */
const startedAt = storedValue<Readonly<Record<string, number>>>('cockpit:follow-ups-started', {
  parse: (raw) => {
    const v: unknown = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, number>) : undefined
  },
  serialize: (started) => JSON.stringify(started),
  fallback: {}
})

export function WorkFollowUpsTab({
  model,
  focus,
  provider,
  sessionId,
  scroller,
  onStart
}: {
  model: WorkModel
  focus: WorkFocus
  provider: SessionProvider
  sessionId: string | null
  scroller: RefObject<HTMLDivElement | null>
  onStart?: (followUp: { readonly title: string; readonly prompt: string; readonly cwd?: string }) => void
}): JSX.Element {
  const fmt = useTimeFormat()
  const { followUps } = model
  const started = startedAt.use()
  const ringed = useRing(scroller, focus, (key) => followUps.some((f) => f.key === key))

  if (followUps.length === 0) {
    return (
      <p className="work-empty">
        No follow-ups yet. When {PROVIDER_LABEL[provider]} spots work outside this task, it suggests it here as a
        session of its own.
      </p>
    )
  }
  const idOf = (f: FollowUpEntry): string => `${sessionId ?? ''}:${f.taskId ?? `row-${f.key}`}`
  return (
    <>
      <div className="work-meta">
        <span>{followUpSummary(followUps)}</span>
      </div>
      <p className="work-note">
        Work the agent spotted outside this task. Starting one fills in a new session with its prompt, with any agent.
      </p>
      <ul className="work-follows">
        {followUps.map((f) => {
          const at = started[idOf(f)]
          return (
            <li
              key={f.key}
              className={`work-follow${f.dismissed ? ' dismissed' : ''}${ringed === f.key ? ' ringed' : ''}`}
              data-work-key={f.key}
            >
              <div className="work-follow-head">
                <span className="work-follow-title">{f.title}</span>
                {f.dismissed && <span className="review-kind tone-dim">withdrawn</span>}
                {f.ts && <span className="work-check-meta">{fmtTime(f.ts, fmt)}</span>}
              </div>
              {f.summary && <p className="work-note">{f.summary}</p>}
              {f.dismissed && f.dismissed !== 'withdrawn' && <p className="work-note">Withdrawn: {f.dismissed}</p>}
              {f.cwd && (
                <span className="work-check-meta" title={f.cwd}>
                  in {shortPath(f.cwd)}
                </span>
              )}
              <details className="work-follow-prompt">
                <summary>the prompt it starts with</summary>
                <pre className="work-check-out">{f.prompt}</pre>
              </details>
              {!f.dismissed && onStart && (
                <div className="work-follow-actions">
                  <button
                    className="btn-ghost small"
                    onClick={() => {
                      startedAt.set({ ...startedAt.get(), [idOf(f)]: Date.now() })
                      onStart({ title: f.title, prompt: f.prompt, ...(f.cwd ? { cwd: f.cwd } : {}) })
                    }}
                  >
                    {at ? 'Start another session…' : 'Start a session…'}
                  </button>
                  {at && <span className="work-check-meta">started {fmtTime(at, fmt)}</span>}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </>
  )
}
