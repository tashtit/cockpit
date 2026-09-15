import type {
  PrChangeRequest,
  PrCheckBucket,
  PrCheckRun,
  PrFeedback,
  PrReviewThread,
  PrThreadComment
} from '../shared/types'
import { checkStateWord, failingChecks, needsFix } from '../shared/pr-feedback'

/**
 * The IO-free half of the PR fix loop: what gh prints about one open PR →
 * PrFeedback, and PrFeedback plus the failed jobs' logs → the prompt that asks
 * the agent to fix it. pr-feedback.ts runs gh; nothing here touches the network.
 * Failure-tolerant like the session parsers: GitHub's shapes drift, so a node
 * this code can't read is skipped rather than thrown on.
 */

/** `gh pr checks --json` fields. gh buckets each check itself — no second classifier here. */
export const CHECK_FIELDS = 'name,bucket,state,link,workflow'

/** One PR's review state. Resolved threads are filtered after the fact (GraphQL can't). */
export const FEEDBACK_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      number title url headRefName baseRefName mergeable
      latestReviews(first: 20) { nodes { state body url author { login } } }
      reviewThreads(first: 100) {
        nodes {
          isResolved isOutdated path line diffSide
          comments(first: 10) { totalCount nodes { body url author { login } } }
        }
      }
    }
  }
}`

/** gh's stderr when a branch has no checks at all — an empty list, not an error. */
export const NO_CHECKS_RE = /no checks reported/i

/** Bodies shipped to the renderer; the briefing trims further. */
const BODY_MAX = 2_000
const THREADS_MAX = 50

const BUCKETS: ReadonlySet<string> = new Set<PrCheckBucket>(['pass', 'fail', 'pending', 'skipping', 'cancel'])

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** Links come from GitHub; anything that isn't https is dropped rather than rendered. */
function httpsUrl(v: unknown): string | null {
  return typeof v === 'string' && v.startsWith('https://') ? v : null
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function nodes(v: unknown): unknown[] {
  const n = obj(v)?.nodes
  return Array.isArray(n) ? n : []
}

function cap(text: string, max: number): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

/**
 * `gh pr checks --json` → check runs, or null when stdout isn't gh's array (gh
 * exits non-zero with pending or failing checks, so the exit code says nothing —
 * the payload decides). A bucket this code doesn't know reads as pending: red
 * would alarm, green would hide a problem.
 */
export function parseChecks(stdout: string): PrCheckRun[] | null {
  let arr: unknown
  try {
    arr = JSON.parse(stdout)
  } catch {
    return null
  }
  if (!Array.isArray(arr)) return null
  const out: PrCheckRun[] = []
  for (const row of arr) {
    const r = obj(row)
    if (!r || typeof r.name !== 'string') continue
    out.push({
      name: r.name,
      workflow: str(r.workflow),
      bucket: typeof r.bucket === 'string' && BUCKETS.has(r.bucket) ? (r.bucket as PrCheckBucket) : 'pending',
      state: str(r.state),
      link: httpsUrl(r.link)
    })
  }
  return out
}

export type FeedbackCore = Omit<PrFeedback, 'checks' | 'warnings'>

function author(v: unknown): string {
  const login = obj(v)?.login
  // a deleted account comes back as a null author; GitHub itself shows "ghost"
  return typeof login === 'string' && login ? login : 'ghost'
}

function comment(v: unknown): PrThreadComment | null {
  const c = obj(v)
  if (!c) return null
  return { author: author(c.author), body: cap(str(c.body), BODY_MAX), url: httpsUrl(c.url) ?? '' }
}

function thread(v: unknown): PrReviewThread | null {
  const t = obj(v)
  if (!t || t.isResolved === true || typeof t.path !== 'string') return null
  const cs = obj(t.comments)
  const comments = nodes(cs)
    .map(comment)
    .filter((c): c is PrThreadComment => c !== null)
  if (comments.length === 0) return null
  const total = typeof cs?.totalCount === 'number' ? cs.totalCount : comments.length
  return {
    path: t.path,
    line: typeof t.line === 'number' ? t.line : null,
    side: t.diffSide === 'LEFT' ? 'LEFT' : 'RIGHT',
    outdated: t.isOutdated === true,
    comments,
    moreComments: Math.max(0, total - comments.length)
  }
}

function changeRequest(v: unknown): PrChangeRequest | null {
  const r = obj(v)
  if (!r || r.state !== 'CHANGES_REQUESTED') return null
  return { author: author(r.author), body: cap(str(r.body), BODY_MAX), url: httpsUrl(r.url) ?? '' }
}

/** The GraphQL response → the PR's review state; null when there is no PR in it. */
export function parseFeedbackResponse(stdout: string): FeedbackCore | null {
  let json: unknown
  try {
    json = JSON.parse(stdout)
  } catch {
    return null
  }
  const pr = obj(obj(obj(obj(json)?.data)?.repository)?.pullRequest)
  if (!pr || typeof pr.number !== 'number') return null
  return {
    number: pr.number,
    title: str(pr.title),
    url: httpsUrl(pr.url) ?? '',
    headRefName: str(pr.headRefName),
    baseRefName: str(pr.baseRefName),
    // UNKNOWN means GitHub hasn't computed it yet — not a conflict
    conflicts: pr.mergeable === 'CONFLICTING',
    threads: nodes(pr.reviewThreads)
      .map(thread)
      .filter((t): t is PrReviewThread => t !== null)
      .slice(0, THREADS_MAX),
    changeRequests: nodes(pr.latestReviews)
      .map(changeRequest)
      .filter((r): r is PrChangeRequest => r !== null)
  }
}

/** GitHub's own words when a GraphQL call is refused (no access, no such PR). */
export function graphqlError(stdout: string): string | null {
  try {
    const errs = obj(JSON.parse(stdout))?.errors
    const msg = Array.isArray(errs) ? obj(errs[0])?.message : null
    return typeof msg === 'string' ? msg : null
  } catch {
    return null
  }
}

/** An Actions job's id from its check link; null for external CI (no log to fetch). */
export function jobIdFromLink(link: string | null): string | null {
  return link?.match(/\/actions\/runs\/\d+\/job\/(\d+)/)?.[1] ?? null
}

const TIMESTAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/
// eslint-style escape class kept literal: ANSI color/erase sequences runners emit
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

/** One line of `gh run view --log-failed`: "<job>\t<step>\t<timestamp> <text>" → the text. */
export function cleanLogLine(raw: string): string {
  const parts = raw.split('\t')
  const rest = parts.length >= 3 ? parts.slice(2).join('\t') : raw
  return rest.replace(TIMESTAMP, '').replace(ANSI, '').replace(/\r$/, '')
}

export type ExcerptCaps = { readonly maxLines: number; readonly maxChars: number }

export const EXCERPT_CAPS: ExcerptCaps = { maxLines: 40, maxChars: 3_000 }

/**
 * The part of a failed job's log that says why: the failing step's output up to
 * its last `##[error]`. The step's own output starts after the `##[group]Run …`
 * echo closes, so the walk back stops at the previous group marker. The log's
 * tail is post-job cleanup — useless — so it is only the fallback when a log
 * carries no error marker at all.
 */
export function failedExcerpt(log: string, caps: ExcerptCaps = EXCERPT_CAPS): string {
  const lines = log.split('\n').map(cleanLogLine)
  const marker = (l: string): boolean => l.startsWith('##[group]') || l.startsWith('##[endgroup]')
  const first = lines.findIndex((l) => l.startsWith('##[error]'))
  let window: string[]
  if (first === -1) {
    window = lines.filter((l) => l.trim() !== '' && !marker(l)).slice(-caps.maxLines)
  } else {
    let start = first
    while (start > 0 && !marker(lines[start - 1])) start--
    let stepEnd = lines.findIndex((l, i) => i > first && l.startsWith('##[group]'))
    if (stepEnd === -1) stepEnd = lines.length
    let last = first
    for (let i = first; i < stepEnd; i++) if (lines[i].startsWith('##[error]')) last = i
    window = lines
      .slice(start, last + 1)
      .filter((l) => !marker(l) && !l.startsWith('##[debug]'))
      .slice(-caps.maxLines)
  }
  const text = window
    .map((l) => l.replace(/^##\[error\]/, 'Error: '))
    .join('\n')
    .trim()
  return text.length > caps.maxChars ? `…${text.slice(-(caps.maxChars - 1))}` : text
}

/** The briefing rides to the CLI as one argv entry — see handoff-core's BRIEFING_MAX_CHARS. */
export const FIX_BRIEFING_MAX_CHARS = 16_000
/** Section budgets, so a wall of logs can't crowd the reviewers out, or the other way round. */
const CHECKS_BUDGET = 8_000
const REVIEW_BUDGET = 6_500

function checkName(c: PrCheckRun): string {
  return c.workflow ? `${c.name} (${c.workflow})` : c.name
}

function quote(text: string, indent: string): string {
  return text
    .split('\n')
    .map((l) => `${indent}${l}`)
    .join('\n')
}

/** Items in order until the budget is spent; the rest are counted, never silently lost. */
function within(items: readonly string[], budget: number): { kept: string[]; dropped: number } {
  const kept: string[] = []
  let used = 0
  for (const item of items) {
    if (used + item.length > budget) break
    kept.push(item)
    used += item.length
  }
  return { kept, dropped: items.length - kept.length }
}

/**
 * The prompt for "Fix with <agent>". Deterministic — no timestamps — so the
 * same PR state always gives the same text. `logs` maps a check's link to the
 * excerpt of its failed step, or null when the log couldn't be read.
 */
export function buildFixBriefing(fb: PrFeedback, logs: ReadonlyMap<string, string | null>): string {
  const failing = failingChecks(fb.checks)
  const pending = fb.checks.filter((c) => c.bucket === 'pending').length
  const counted = fb.checks.filter((c) => c.bucket !== 'skipping').length
  const head = fb.headRefName || 'this branch'
  const base = fb.baseRefName || 'the base branch'

  const out: string[] = [
    `# Fix pull request #${fb.number}: ${fb.title}`,
    '',
    `PR #${fb.number} (${head} → ${base}) is not ready to merge. You are on its branch, in its ` +
      'worktree. Work through every item below, commit the fixes, and push the branch so the PR updates.',
    ...(fb.url ? [fb.url] : [])
  ]

  if (fb.conflicts) {
    out.push(
      '',
      '## Merge conflicts',
      `${head} conflicts with ${base}. Merge ${base} into it (or rebase onto it) and resolve the conflicts first.`
    )
  }

  if (failing.length > 0) {
    const items = failing.map((c) => {
      const lines = [`### ${checkName(c)} — ${checkStateWord(c)}`]
      if (c.link) lines.push(c.link)
      if (c.bucket === 'cancel') lines.push('Cancelled before it finished — re-run it once the other fixes are in.')
      else if (c.link && logs.has(c.link)) {
        const log = logs.get(c.link)
        if (log) lines.push('Output of the failed step:', '```text', log, '```')
        else lines.push('(The failed step\'s log could not be read — open the link above.)')
      }
      return lines.join('\n')
    })
    const { kept, dropped } = within(items, CHECKS_BUDGET)
    out.push('', `## Failing checks (${failing.length} of ${counted})`)
    for (const item of kept) out.push('', item)
    if (dropped > 0) out.push('', `(${dropped} more failing ${dropped === 1 ? 'check' : 'checks'} not included — see the PR.)`)
  }
  if (pending > 0) {
    out.push(
      '',
      pending === 1
        ? '1 check is still running — its result is not in yet.'
        : `${pending} checks are still running — their results are not in yet.`
    )
  }

  // one item per review and per thread, so the budget cuts between them, never inside
  const reviewItems: string[] = []
  if (fb.changeRequests.length > 0) {
    reviewItems.push('## Changes requested')
    for (const r of fb.changeRequests) {
      reviewItems.push(
        r.body ? `- @${r.author}:\n${quote(cap(r.body, 900), '  > ')}` : `- @${r.author} (no summary — see the threads)`
      )
    }
  }
  if (fb.threads.length > 0) {
    const threads = fb.threads.map((t, i) => {
      const where = t.line === null ? `${t.path} (outdated — the line has changed since)` : `${t.path} line ${t.line}${t.side === 'LEFT' ? ' (removed side)' : ''}`
      const [first, ...replies] = t.comments
      const lines = [`${i + 1}. ${where}`, `   @${first.author}:`, quote(cap(first.body, 700), '   > ')]
      for (const r of replies.slice(0, 2)) lines.push(`   @${r.author} replied:`, quote(cap(r.body, 300), '   > '))
      const more = replies.length - Math.min(replies.length, 2) + t.moreComments
      if (more > 0) lines.push(`   (${more} more ${more === 1 ? 'reply' : 'replies'} on GitHub)`)
      return lines.join('\n')
    })
    reviewItems.push(`## Unresolved review threads (${fb.threads.length})`, ...threads)
  }
  if (reviewItems.length > 0) {
    const { kept, dropped } = within(reviewItems, REVIEW_BUDGET)
    for (const item of kept) {
      // the "Changes requested" entries stay a tight list; everything else gets a blank line
      if (!item.startsWith('- ')) out.push('')
      out.push(item)
    }
    if (dropped > 0) out.push('', `(${dropped} more review ${dropped === 1 ? 'item' : 'items'} not included — see the PR.)`)
  }

  if (!needsFix(fb)) {
    out.push('', 'Nothing is failing and no review is waiting on changes right now.')
  } else {
    out.push(
      '',
      'Reproduce each failing check locally where you can (the repository\'s CI workflow has the exact ' +
        'commands) before pushing. When you are done, list what you changed for each item.'
    )
  }
  const text = out.join('\n')
  return text.length > FIX_BRIEFING_MAX_CHARS ? `${text.slice(0, FIX_BRIEFING_MAX_CHARS - 1)}…` : text
}
