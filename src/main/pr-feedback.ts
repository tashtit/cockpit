import type { PrFeedback, PrFixBriefing } from '../shared/types'
import { execText } from './env'
import {
  buildFixBriefing,
  CHECK_FIELDS,
  failedExcerpt,
  FEEDBACK_QUERY,
  graphqlError,
  jobIdFromLink,
  NO_CHECKS_RE,
  parseChecks,
  parseFeedbackResponse
} from './pr-feedback-core'

/**
 * IO around pr-feedback-core: the gh calls that describe one open PR and the
 * failed-step logs a fix prompt quotes. Read-only on GitHub's side — nothing
 * here comments, resolves or re-runs anything. Always read fresh: the review
 * panel asks when it opens and when a turn settles, and a stale "failing" is
 * exactly the wrong thing to hand an agent.
 */

/** Logs are fetched for at most this many failing jobs — the briefing budget can't hold more. */
const LOG_JOBS_MAX = 4
/** A failed job's log can be long; the excerpt only ever needs its failing step. */
const LOG_MAX_BYTES = 32 * 1024 * 1024
const EXCERPT_CACHE_MAX = 50

/** A finished job's log never changes — excerpts are kept by job id. */
const excerpts = new Map<string, string>()

/** Tests only. */
export function clearPrFeedbackCache(): void {
  excerpts.clear()
}

/** The PR number is renderer input and lands on gh's argv — a positive integer or nothing. */
export function asPrNumber(n: unknown): number {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 100_000_000) {
    throw new Error('invalid pull request number')
  }
  return n
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}

function ghFailure(r: { stderr: string; error: string | null }): string {
  if (r.error && /ENOENT/.test(r.error)) return 'the GitHub CLI (gh) was not found'
  return firstLine(r.stderr) || firstLine(r.error ?? '') || 'gh returned nothing'
}

export async function getPrFeedback(repoRoot: string, prNumber: number): Promise<PrFeedback> {
  const [checksR, reviewR] = await Promise.all([
    execText('gh', ['pr', 'checks', String(prNumber), '--json', CHECK_FIELDS], {
      cwd: repoRoot,
      timeoutMs: 20_000
    }),
    // {owner}/{repo} are gh's own placeholders: it resolves the repository from
    // the checkout exactly as `gh pr list` does, so both calls read the same repo
    execText(
      'gh',
      ['api', 'graphql', '-F', 'owner={owner}', '-F', 'name={repo}', '-F', `number=${prNumber}`, '-f', `query=${FEEDBACK_QUERY}`],
      { cwd: repoRoot, timeoutMs: 20_000 }
    )
  ])
  const core = parseFeedbackResponse(reviewR.stdout)
  if (!core) {
    const why = graphqlError(reviewR.stdout) ?? ghFailure(reviewR)
    throw new Error(`Couldn't read PR #${prNumber} from GitHub — ${why}`)
  }
  const warnings: string[] = []
  let checks = parseChecks(checksR.stdout)
  if (checks === null) {
    if (!NO_CHECKS_RE.test(checksR.stderr)) warnings.push(`Checks unavailable — ${ghFailure(checksR)}`)
    checks = []
  }
  return { ...core, checks, warnings }
}

async function jobExcerpt(repoRoot: string, jobId: string): Promise<string | null> {
  const hit = excerpts.get(jobId)
  if (hit !== undefined) return hit
  const r = await execText('gh', ['run', 'view', '--job', jobId, '--log-failed'], {
    cwd: repoRoot,
    timeoutMs: 30_000,
    maxBuffer: LOG_MAX_BYTES
  })
  if (!r.ok || !r.stdout.trim()) return null // expired, still running, or no access: not cached
  const text = failedExcerpt(r.stdout)
  if (excerpts.size >= EXCERPT_CACHE_MAX) excerpts.delete(excerpts.keys().next().value as string)
  excerpts.set(jobId, text)
  return text
}

/**
 * The fix prompt: fresh feedback, plus the failed step of each failing Actions
 * job (external CI has no log gh can read — the prompt links to it instead).
 */
export async function getPrFixBriefing(repoRoot: string, prNumber: number): Promise<PrFixBriefing> {
  const fb = await getPrFeedback(repoRoot, prNumber)
  const withLog = fb.checks
    .filter((c) => c.bucket === 'fail' && jobIdFromLink(c.link) !== null)
    .slice(0, LOG_JOBS_MAX)
  const logs = new Map<string, string | null>()
  await Promise.all(
    withLog.map(async (c) => {
      const link = c.link as string
      logs.set(link, await jobExcerpt(repoRoot, jobIdFromLink(link) as string))
    })
  )
  const unread = withLog.filter((c) => logs.get(c.link as string) === null).map((c) => c.name)
  return {
    briefing: buildFixBriefing(fb, logs),
    warnings: [
      ...fb.warnings,
      ...(unread.length > 0
        ? [`Couldn't read the failed-step log for ${unread.join(', ')} — the prompt links to it instead.`]
        : [])
    ]
  }
}
