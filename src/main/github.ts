/**
 * What GitHub says about a repository, through the person's own `gh` CLI: its pull
 * requests with their checks, review decision and open threads (the badges on rows and
 * the PR strip), and its default branch. Everything fails soft — no `gh`, no sign-in, no
 * GitHub remote or no network just means no badges. The parsing is `github-core.ts`.
 */
import type { PrStatus } from '../shared/types'
import { throttledBy } from './cache'
import { execText } from './env'
import {
  OPEN_THREADS_QUERY,
  PR_LIST_FIELDS,
  parsePrList,
  parseUnresolvedThreads,
  withUnresolvedThreads
} from './github-core'

const TTL_MS = 60_000

/**
 * PRs for a repo via the `gh` CLI, cached per repo root — the list and its thread counts
 * share one TTL_MS entry. Fails soft to [] —
 * no gh installed / not a GitHub repo / offline just means no badges.
 */
export function getPrs(repoRoot: string): Promise<PrStatus[]> {
  return prsByRoot(repoRoot)
}

async function fetchPrs(repoRoot: string): Promise<PrStatus[]> {
  // fails soft: no gh, no auth, or not a GitHub remote just means no PR chips.
  // The rollup and review decision ride the same query, so a checks badge costs
  // no extra round trip — github-core folds them into one word each.
  const r = await execText(
    'gh',
    ['pr', 'list', '--state', 'all', '--limit', '100', '--json', PR_LIST_FIELDS],
    { cwd: repoRoot }
  )
  if (!r.ok) return []
  const prs = parsePrList(r.stdout)
  // unresolved review threads aren't a `gh pr list` field: one GraphQL call beside it,
  // skipped when nothing is open (and when the list failed — gh wouldn't answer this
  // either). {owner}/{repo} are gh's placeholders, resolved from the checkout exactly
  // as `gh pr list` resolves it. Fails soft: without it every count reads 0.
  if (!prs.some((p) => p.state === 'OPEN')) return prs
  const t = await execText(
    'gh',
    ['api', 'graphql', '-F', 'owner={owner}', '-F', 'name={repo}', '-f', `query=${OPEN_THREADS_QUERY}`],
    { cwd: repoRoot, timeoutMs: 20_000 }
  )
  return withUnresolvedThreads(prs, parseUnresolvedThreads(t.stdout))
}

const prsByRoot = throttledBy(TTL_MS, fetchPrs)

/** repoRoot → default branch (or null when git can't say). Per-process: it changes
 *  about as often as a repository is renamed. */
const defaultBranches = new Map<string, string | null>()

/**
 * The branch a PR would target — `origin/HEAD` when the clone recorded it, else the
 * first of the conventional names that actually exists on the remote, else what
 * GitHub says (a repo made locally and pushed has no `origin/HEAD`, and its default
 * need not be main or master). Null when nothing answers: an unknown default must
 * never hide a working affordance. Only an answer is remembered — a timeout or an
 * offline moment is asked again next time, not believed for the rest of the run.
 */
export async function getDefaultBranch(repoRoot: string): Promise<string | null> {
  const cached = defaultBranches.get(repoRoot)
  if (cached !== undefined) return cached
  const head = await execText('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], {
    cwd: repoRoot,
    timeoutMs: 5_000
  })
  let name: string | null = head.ok ? head.stdout.trim().replace(/^origin\//, '') || null : null
  if (!name) {
    for (const candidate of ['main', 'master']) {
      const ref = await execText(
        'git',
        ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${candidate}`],
        { cwd: repoRoot, timeoutMs: 5_000 }
      )
      if (ref.ok) {
        name = candidate
        break
      }
    }
  }
  if (!name) {
    const gh = await execText('gh', ['repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'], {
      cwd: repoRoot,
      timeoutMs: 15_000
    })
    name = (gh.ok && gh.stdout.trim()) || null
  }
  if (name) defaultBranches.set(repoRoot, name)
  return name
}
