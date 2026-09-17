import type { PrChecks, PrReview, PrState, PrStatus } from '../shared/types'
import { nodes, obj } from './pr-feedback-core'

/**
 * The IO-free half of github.ts: turning what `gh pr list --json` prints into
 * PrStatus rows, and folding in the unresolved-thread counts GitHub's GraphQL
 * API reports beside it. Pure on purpose — the unit tests feed it fixtures, never gh.
 */

/** The `--json` fields the list call asks for, next to the parser that reads them. */
export const PR_LIST_FIELDS =
  'number,title,state,isDraft,headRefName,headRefOid,url,statusCheckRollup,reviewDecision'

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
    headSha: typeof r.headRefOid === 'string' ? r.headRefOid : '',
    url: typeof r.url === 'string' ? r.url : '',
    checks: summarizeChecks(r.statusCheckRollup),
    review: mapReviewDecision(r.reviewDecision),
    // not a `gh pr list` field — withUnresolvedThreads fills it in for open PRs
    unresolvedThreads: 0
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

/**
 * `gh pr list --json` has no review-thread field, so the counts come from one
 * GraphQL call per repo beside it. Newest first like `gh pr list`, so the open PRs
 * it lists are the ones counted; a PR past either page reads as 0, never as a guess.
 * Resolved threads can't be filtered server-side — they are counted after the fact.
 */
export const OPEN_THREADS_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    pullRequests(states: OPEN, first: 100, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes { number reviewThreads(first: 100) { nodes { isResolved } } }
    }
  }
}`

/**
 * The GraphQL response → PR number → unresolved threads. Fails soft to an empty
 * map: no response, an error payload or a drifted shape just means no counts.
 * Only an explicit `isResolved: false` counts — a thread this code can't read
 * stays uncounted, because a phantom "waiting on you" is worse than a missing one.
 */
export function parseUnresolvedThreads(stdout: string): Map<number, number> {
  const counts = new Map<number, number>()
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    return counts
  }
  const prs = obj(obj(obj(json)?.data)?.repository)?.pullRequests
  for (const node of nodes(prs)) {
    const pr = obj(node)
    if (!pr || typeof pr.number !== 'number') continue
    const open = nodes(pr.reviewThreads).filter((t) => obj(t)?.isResolved === false).length
    if (open > 0) counts.set(pr.number, open)
  }
  return counts
}

/** Counts land on open PRs only: a merged or closed PR's leftover threads wait on nobody. */
export function withUnresolvedThreads(
  prs: readonly PrStatus[],
  counts: ReadonlyMap<number, number>
): PrStatus[] {
  return prs.map((pr) => {
    const n = pr.state === 'OPEN' ? (counts.get(pr.number) ?? 0) : 0
    return n === pr.unresolvedThreads ? pr : { ...pr, unresolvedThreads: n }
  })
}
