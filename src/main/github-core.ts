import type { PrChecks, PrReview, PrState, PrStatus } from '../shared/types'

/**
 * The IO-free half of github.ts: turning what `gh pr list --json` prints into
 * PrStatus rows. Pure on purpose — the unit tests feed it fixtures, never gh.
 */

/** The `--json` fields the list call asks for, next to the parser that reads them. */
export const PR_LIST_FIELDS =
  'number,title,state,isDraft,headRefName,url,statusCheckRollup,reviewDecision'

/**
 * One entry of gh's `statusCheckRollup`. GitHub reports two shapes — Checks-API
 * runs (`CheckRun`: a status, then a conclusion once completed) and legacy commit
 * statuses (`StatusContext`: a single state). Only the fields read here are typed.
 */
export type RollupItem = {
  readonly __typename?: string
  /** CheckRun: QUEUED | IN_PROGRESS | COMPLETED | WAITING | PENDING | REQUESTED */
  readonly status?: string | null
  /** CheckRun, once COMPLETED: SUCCESS | FAILURE | NEUTRAL | CANCELLED | SKIPPED | TIMED_OUT | ACTION_REQUIRED | STALE | STARTUP_FAILURE */
  readonly conclusion?: string | null
  /** StatusContext: SUCCESS | FAILURE | ERROR | PENDING | EXPECTED */
  readonly state?: string | null
}

/** Conclusions/states GitHub's own merge box counts against the PR. */
const FAILED: ReadonlySet<string> = new Set([
  'FAILURE',
  'ERROR',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'CANCELLED'
])
/** …and the ones it lets through (neutral and skipped satisfy required checks). */
const PASSED: ReadonlySet<string> = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])

type ItemOutcome = 'passed' | 'failed' | 'pending'

/**
 * A run that has not completed is pending whatever its (null) conclusion says.
 * A verdict this code does not know reads as pending too — GitHub adds
 * conclusions between releases, and a yellow dot is the least harmful misread:
 * red would alarm, green would hide a problem.
 */
function classify(item: RollupItem): ItemOutcome {
  if (typeof item.status === 'string' && item.status !== 'COMPLETED') return 'pending'
  const verdict = item.conclusion ?? item.state ?? ''
  if (FAILED.has(verdict)) return 'failed'
  if (PASSED.has(verdict)) return 'passed'
  return 'pending'
}

/**
 * Fold a PR's rollup into one word: any failure wins, then any run still going,
 * else everything passed. No (readable) checks at all is `none`, not `passing`.
 */
export function summarizeChecks(rollup: unknown): PrChecks {
  if (!Array.isArray(rollup)) return 'none'
  let seen = 0
  let pending = false
  for (const item of rollup) {
    if (typeof item !== 'object' || item === null) continue
    seen += 1
    const outcome = classify(item as RollupItem)
    if (outcome === 'failed') return 'failing'
    if (outcome === 'pending') pending = true
  }
  if (seen === 0) return 'none'
  return pending ? 'pending' : 'passing'
}

/** gh prints GitHub's enum, or "" when the repo requires no review. */
export function mapReviewDecision(decision: unknown): PrReview {
  switch (decision) {
    case 'APPROVED':
      return 'approved'
    case 'CHANGES_REQUESTED':
      return 'changes_requested'
    case 'REVIEW_REQUIRED':
      return 'review_required'
    default:
      return 'none'
  }
}

const PR_STATES: ReadonlySet<string> = new Set<PrState>(['OPEN', 'MERGED', 'CLOSED'])

/** One gh row → PrStatus; null when it lacks the two fields nothing can work without. */
export function toPrStatus(row: unknown): PrStatus | null {
  if (typeof row !== 'object' || row === null) return null
  const r = row as Record<string, unknown>
  if (typeof r.number !== 'number' || typeof r.state !== 'string' || !PR_STATES.has(r.state)) {
    return null
  }
  return {
    number: r.number,
    title: typeof r.title === 'string' ? r.title : '',
    state: r.state as PrState,
    isDraft: r.isDraft === true,
    headRefName: typeof r.headRefName === 'string' ? r.headRefName : '',
    url: typeof r.url === 'string' ? r.url : '',
    checks: summarizeChecks(r.statusCheckRollup),
    review: mapReviewDecision(r.reviewDecision)
  }
}

/** Fails soft: anything but a JSON array of PR rows is an empty list, never a throw. */
export function parsePrList(stdout: string): PrStatus[] {
  try {
    const arr: unknown = JSON.parse(stdout)
    if (!Array.isArray(arr)) return []
    return arr.map(toPrStatus).filter((p): p is PrStatus => p !== null)
  } catch {
    return []
  }
}
