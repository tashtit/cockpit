import { useEffect, useState, type JSX, type RefObject } from 'react'
import type { Provider } from '../../shared/types'
import { CHECK_LABEL, checkSummary, type CheckRun, type CheckWork, type WorkModel } from '../../shared/work'
import { PROVIDER_LABEL } from './logos'
import { fmtTime, plural } from './format'
import { useTimeFormat } from './time'
import { useRing, type WorkFocus } from './work-tab'

/** The Work panel's Checks tab: how each check the agent ran last ended. */

/** A run's state as its word and tone — the word always, so the colour never carries it alone */
function verdict(run: CheckRun | null): { word: string; tone: string } {
  if (run?.status === 'passed') return { word: 'passed', tone: 'tone-ok' }
  if (run?.status === 'failed') return { word: 'failed', tone: 'tone-danger' }
  return { word: 'no result', tone: 'tone-dim' }
}

export function WorkChecksTab({
  model,
  focus,
  provider,
  scroller
}: {
  model: WorkModel
  focus: WorkFocus
  provider: Provider
  scroller: RefObject<HTMLDivElement | null>
}): JSX.Element {
  const { checks } = model
  // a row opened the panel at its run: bring that run into view and ring it
  const ringed = useRing(scroller, focus, (key) => checks.some((c) => c.runs.some((r) => r.key === key)))

  if (checks.length === 0) {
    return (
      <p className="work-empty">
        No checks yet. When {PROVIDER_LABEL[provider]} runs its tests, a typecheck, a linter or a build, how each one
        last ended shows here.
      </p>
    )
  }
  return (
    <>
      <div className="work-meta">
        <span>{checkSummary(checks)}</span>
      </div>
      <p className="work-note">
        Read off each command's exit code and what it printed. A check is out of date once the agent edits files after
        it.
      </p>
      <ul className="work-checks">
        {checks.map((c) => (
          <CheckBlock key={c.kind} check={c} ringed={ringed} />
        ))}
      </ul>
    </>
  )
}

function CheckBlock({ check, ringed }: { check: CheckWork; ringed: number | null }): JSX.Element {
  const fmt = useTimeFormat()
  // the run that decides the state, else the newest, which has no verdict yet
  const shown = check.last ?? check.runs[check.runs.length - 1]!
  const state = verdict(check.last)
  const earlier = check.runs.filter((r) => r !== shown).reverse()
  const failedEarlier = earlier.filter((r) => r.status === 'failed').length
  // a row that opened the panel at an earlier run opens the fold; the ring clearing doesn't close it
  const ringsEarlier = earlier.some((r) => r.key === ringed)
  const [runsOpen, setRunsOpen] = useState(ringsEarlier)
  useEffect(() => {
    if (ringsEarlier) setRunsOpen(true)
  }, [ringsEarlier])
  return (
    <li className={`work-check${ringed === shown.key ? ' ringed' : ''}`} data-work-key={shown.key}>
      <div className="work-check-head">
        <span className={`review-kind ${state.tone}`}>{state.word}</span>
        <span className="work-check-name">{CHECK_LABEL[check.kind]}</span>
        {shown.exitCode !== undefined && shown.exitCode !== 0 && (
          <span className="work-check-meta">exit {shown.exitCode}</span>
        )}
        {check.editedSince > 0 && (
          <span className="work-flag">
            {plural(check.editedSince, 'file')} edited since
          </span>
        )}
        {shown.ts && <span className="work-check-meta work-check-time">{fmtTime(shown.ts, fmt)}</span>}
      </div>
      <code className="work-check-cmd" title={shown.command}>
        {shown.command}
      </code>
      {shown.output && <pre className="work-check-out">{shown.output.join('\n')}</pre>}
      {earlier.length > 0 && (
        <details
          className="work-check-runs"
          open={runsOpen}
          onToggle={(e) => {
            // a details element reports its first paint too: only a change is a choice
            if (e.currentTarget.open !== runsOpen) setRunsOpen(e.currentTarget.open)
          }}
        >
          <summary>
            {plural(earlier.length, 'earlier run')}
            {failedEarlier > 0 && ` · ${failedEarlier} failed`}
          </summary>
          <ol className="work-check-list">
            {earlier.map((r, i) => {
              const v = verdict(r)
              return (
                <li
                  key={`${r.key}-${i}`}
                  className={`work-check-run${ringed === r.key ? ' ringed' : ''}`}
                  data-work-key={r.key}
                >
                  {r.ts && <span className="work-check-meta">{fmtTime(r.ts, fmt)}</span>}
                  <span className={`review-kind ${v.tone}`}>{v.word}</span>
                  <code className="work-check-cmd" title={r.command}>
                    {r.command}
                  </code>
                </li>
              )
            })}
          </ol>
        </details>
      )}
    </li>
  )
}
