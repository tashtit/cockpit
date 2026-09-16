import type { JSX } from 'react'
import { checkStateWord, failingChecks, needsFix } from '../../shared/pr-feedback'
import type { PrFeedback, PrStatus } from '../../shared/types'
import { LinkExternalIcon, PrBadge } from './logos'

/**
 * The branch's open PR, at the head of the review: what it is waiting on —
 * failing checks, reviews asking for changes, unresolved threads, conflicts —
 * and the key that hands all of it to the agent as one prompt. Read-only on
 * GitHub's side; every link opens the PR itself.
 */

export type Readout = { readonly text: string; readonly tone: 'ok' | 'warn' | 'danger' | 'dim' }

/** Rows per kind before the list points at GitHub for the rest. */
const LIST_MAX = 5

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/** What the PR is waiting on, as the strip's readout words. */
export function prReadout(fb: PrFeedback): Readout[] {
  const counted = fb.checks.filter((c) => c.bucket !== 'skipping').length
  const failing = failingChecks(fb.checks).length
  const pending = fb.checks.filter((c) => c.bucket === 'pending').length
  const out: Readout[] = [
    failing > 0
      ? { text: `${failing} of ${counted} checks failing`, tone: 'danger' }
      : pending > 0
        ? { text: `${pending} of ${counted} checks running`, tone: 'warn' }
        : counted > 0
          ? { text: `${plural(counted, 'check')} passed`, tone: 'ok' }
          : { text: 'no checks', tone: 'dim' }
  ]
  if (fb.changeRequests.length > 0) out.push({ text: 'changes requested', tone: 'danger' })
  if (fb.threads.length > 0) out.push({ text: plural(fb.threads.length, 'unresolved thread'), tone: 'warn' })
  if (fb.conflicts) out.push({ text: `conflicts with ${fb.baseRefName || 'the base branch'}`, tone: 'danger' })
  return out
}

export function PrStrip({
  pr,
  feedback,
  loading,
  error,
  notice,
  agent,
  fixing,
  fixDisabled,
  onFix,
  onOpenUrl
}: {
  pr: PrStatus
  feedback: PrFeedback | null
  loading: boolean
  error: string | null
  /** What the last fix prompt couldn't include (an unreadable log) */
  notice: readonly string[]
  agent: string
  fixing: boolean
  /** A turn is running — the prompt would have nowhere to go */
  fixDisabled: boolean
  /** Absent when the session takes no input */
  onFix?: () => void
  onOpenUrl: (url: string) => void
}): JSX.Element {
  const failing = feedback ? failingChecks(feedback.checks) : []
  const threads = feedback?.threads ?? []
  const reviews = feedback?.changeRequests ?? []
  const listed = failing.length + threads.length + reviews.length
  const hidden =
    Math.max(0, failing.length - LIST_MAX) + Math.max(0, threads.length - LIST_MAX) + Math.max(0, reviews.length - LIST_MAX)
  const out = (url: string, label: string): JSX.Element => (
    <button className="link-btn review-pr-link" aria-label={label} title={label} onClick={() => onOpenUrl(url)}>
      <LinkExternalIcon size={10} />
    </button>
  )
  return (
    <section className="review-pr" aria-label={`Pull request #${pr.number}`}>
      <div className="review-pr-head">
        <PrBadge pr={pr} onOpen={onOpenUrl} />
        <span className="review-sum">
          {feedback &&
            prReadout(feedback).map((r) => (
              <span key={r.text} className={`tone-${r.tone}`}>
                {r.text}
              </span>
            ))}
          {loading && (
            <span className="review-loading">
              <span className="pulse" /> reading the PR…
            </span>
          )}
        </span>
        {onFix && feedback && needsFix(feedback) && (
          <button
            className="btn-ghost small review-pr-fix"
            disabled={fixDisabled || fixing}
            title={`Put a prompt with the failing checks' logs, the review threads and the requested changes in the composer, ready to send to ${agent}`}
            onClick={onFix}
          >
            {fixing ? (
              <>
                <span className="pulse" /> Gathering what failed…
              </>
            ) : (
              `Fix with ${agent}`
            )}
          </button>
        )}
      </div>
      {error && (
        <div className="review-error" role="alert">
          {error}
        </div>
      )}
      {notice.length > 0 && (
        <div className="review-pr-notice" role="status">
          {notice.join(' ')}
        </div>
      )}
      {listed > 0 && (
        <ul className="review-pr-list" aria-label="What the pull request is waiting on">
          {failing.slice(0, LIST_MAX).map((c) => (
            <li key={`c:${c.link ?? c.name}`} className="review-pr-row">
              <span className="review-kind tone-danger">{checkStateWord(c)}</span>
              <span className="review-pr-name">{c.name}</span>
              {c.workflow && <span className="review-pr-dim">{c.workflow}</span>}
              {c.link && out(c.link, `Open the ${c.name} check on GitHub`)}
            </li>
          ))}
          {reviews.slice(0, LIST_MAX).map((r, i) => (
            <li key={`r:${i}`} className="review-pr-row">
              <span className="review-kind tone-danger">changes</span>
              <span className="review-pr-dim">@{r.author}</span>
              <span className="review-pr-excerpt">{r.body || 'see the threads'}</span>
              {r.url && out(r.url, `Open @${r.author}'s review on GitHub`)}
            </li>
          ))}
          {threads.slice(0, LIST_MAX).map((t, i) => (
            <li key={`t:${i}`} className="review-pr-row">
              <span className={`review-kind ${t.outdated ? 'tone-dim' : 'tone-warn'}`}>{t.outdated ? 'outdated' : 'thread'}</span>
              <span className="review-pr-name">
                {t.path}
                {t.line !== null && `:${t.line}`}
              </span>
              <span className="review-pr-dim">@{t.comments[0].author}</span>
              <span className="review-pr-excerpt">{t.comments[0].body}</span>
              {t.comments[0].url && out(t.comments[0].url, `Open the thread on ${t.path} on GitHub`)}
            </li>
          ))}
          {hidden > 0 && (
            <li className="review-pr-row">
              <button className="link-btn review-pr-more" onClick={() => onOpenUrl(pr.url)}>
                {hidden} more on GitHub
              </button>
            </li>
          )}
        </ul>
      )}
    </section>
  )
}
