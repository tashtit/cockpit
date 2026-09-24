/**
 * `npm run stats` — how many people use Cockpit and how many talk back, from what GitHub
 * already records (there is no telemetry, and there must be none). Every call is a
 * read-only `gh api` GET, plus one GraphQL query for discussions; nothing is ever written
 * to GitHub. Needs a `gh` signed in to github.com; traffic needs push access and is
 * reported as unavailable without it.
 *
 * GitHub forgets traffic after 14 days, so each run folds what it read into a local
 * history — traffic merged per day, one snapshot of the counters per UTC day — and later
 * runs take their trends from it. Re-running is safe: the same day merges, never repeats.
 *
 *   npm run stats                      # the report
 *   npm run stats -- --json            # the same, machine-readable
 *   npm run stats -- --history <file>  # default ~/.local/share/cockpit-stats/history.json
 *
 * Parsing, merging, the estimates and the report are in stats-core.mts.
 */
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  buildReport,
  codeownersHandles,
  emptyHistory,
  formatReport,
  ghFailure,
  maintainersFromCollaborators,
  mergeHistory,
  parseDiscussionPage,
  parseHistory,
  parseIssueComments,
  parseIssues,
  parsePopular,
  parseReleases,
  parseRepo,
  parseTrafficSeries,
  pullNumbers,
  REPO,
  summarizeFeedback,
  takeSnapshot,
  type Contribution,
  type FeedbackSummary,
  type History,
  type Traffic
} from './stats-core.mts'

const PER_PAGE = 100
/** a ceiling on any one listing, so a runaway pagination cannot loop forever */
const MAX_PAGES = 50

type Got = { readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly status: number | null; readonly message: string }

function gh(args: readonly string[]): Promise<Got> {
  return new Promise((done) => {
    execFile(
      'gh',
      ['api', '--hostname', 'github.com', ...args],
      { maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } },
      (err, stdout, stderr) => {
        if (err) return done({ ok: false, ...ghFailure(stderr || err.message) })
        try {
          done({ ok: true, data: JSON.parse(stdout) as unknown })
        } catch {
          done({ ok: false, status: null, message: `gh api ${args.join(' ')} returned something other than JSON` })
        }
      }
    )
  })
}

/** GET one REST path; throws, for the calls the report cannot do without. */
async function need(path: string): Promise<unknown> {
  const got = await gh([path])
  if (!got.ok) throw new Error(`gh api ${path}: ${got.message}`)
  return got.data
}

type Pages = { readonly ok: true; readonly rows: readonly unknown[] } | { readonly ok: false; readonly message: string }

/** Every page of a REST listing. */
async function pages(path: string): Promise<Pages> {
  const rows: unknown[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const got = await gh([`${path}${path.includes('?') ? '&' : '?'}per_page=${PER_PAGE}&page=${page}`])
    if (!got.ok) return { ok: false, message: got.message }
    const batch = Array.isArray(got.data) ? got.data : []
    rows.push(...batch)
    if (batch.length < PER_PAGE) break
  }
  return { ok: true, rows }
}

async function allRows(path: string): Promise<readonly unknown[]> {
  const got = await pages(path)
  if (!got.ok) throw new Error(`gh api ${path}: ${got.message}`)
  return got.rows
}

async function traffic(): Promise<Traffic> {
  const got = await Promise.all(
    ['views', 'clones', 'popular/referrers', 'popular/paths'].map((p) => gh([`repos/${REPO}/traffic/${p}`]))
  )
  for (const g of got) {
    if (g.ok) continue
    const hint = g.status === 403 ? ' — traffic needs push access to the repo' : ''
    return { ok: false, reason: `${g.message}${hint}` }
  }
  const [views, clones, referrers, paths] = got.map((g) => (g.ok ? g.data : null))
  return {
    ok: true,
    views: parseTrafficSeries(views, 'views'),
    clones: parseTrafficSeries(clones, 'clones'),
    referrers: parsePopular(referrers, 'referrer'),
    paths: parsePopular(paths, 'path')
  }
}

/** Kept under GitHub's node limit: 25 discussions × 50 comments × 50 replies. */
const DISCUSSIONS_QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    discussions(first: 25, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes {
        title url createdAt author { __typename login }
        comments(first: 50) {
          totalCount
          nodes {
            url createdAt author { __typename login }
            replies(first: 50) { totalCount nodes { url createdAt author { __typename login } } }
          }
        }
      }
    }
  }
}`

type Discussions = {
  readonly items: readonly Contribution[]
  readonly truncated: boolean
  readonly unavailable: string | null
}

async function discussions(): Promise<Discussions> {
  const [owner, name] = REPO.split('/') as [string, string]
  const items: Contribution[] = []
  let truncated = false
  let after: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    // a query, never a mutation: gh sends GraphQL as a POST, but it reads only
    const args = ['graphql', '-f', `query=${DISCUSSIONS_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`]
    if (after) args.push('-f', `after=${after}`)
    const got = await gh(args)
    if (!got.ok) return { items, truncated, unavailable: got.message }
    const parsed = parseDiscussionPage(got.data)
    items.push(...parsed.items)
    truncated ||= parsed.truncated
    if (!parsed.next) break
    after = parsed.next
  }
  return { items, truncated, unavailable: null }
}

/** The team: collaborators who can push, or — when that listing is refused — CODEOWNERS. */
async function maintainers(): Promise<Pick<FeedbackSummary, 'maintainers' | 'maintainersFrom'>> {
  const got = await pages(`repos/${REPO}/collaborators`)
  if (got.ok) return { maintainers: maintainersFromCollaborators(got.rows), maintainersFrom: 'collaborators' }
  const codeowners = readFileSync(new URL('../.github/CODEOWNERS', import.meta.url), 'utf8')
  return { maintainers: codeownersHandles(codeowners), maintainersFrom: 'CODEOWNERS' }
}

function readHistory(path: string): History {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyHistory()
    throw err
  }
  try {
    return parseHistory(JSON.parse(text) as unknown)
  } catch (err) {
    // never overwrite a history this run cannot read: it holds what GitHub has forgotten
    throw new Error(`${path}: ${err instanceof Error ? err.message : String(err)} — move it aside to start a new one`)
  }
}

/** Written beside the target and renamed over it, so a crash never leaves half a file. */
function writeHistory(path: string, history: History): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(history, null, 1)}\n`)
    renameSync(tmp, path)
  } finally {
    rmSync(tmp, { force: true })
  }
}

function tilde(path: string): string {
  const home = homedir()
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

const USAGE = 'usage: npm run stats -- [--json] [--history <file>]'

function args(): { readonly history?: string; readonly json: boolean; readonly help: boolean } {
  try {
    return parseArgs({
      options: {
        history: { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false }
      }
    }).values
  } catch (err) {
    console.error(`stats: ${err instanceof Error ? err.message : String(err)}\n${USAGE}`)
    process.exit(2)
  }
}

const values = args()
if (values.help) {
  console.log(USAGE)
  process.exit(0)
}

try {
  const historyPath = resolve(values.history ?? join(homedir(), '.local', 'share', 'cockpit-stats', 'history.json'))
  const history = readHistory(historyPath)

  const [repoRaw, releaseRows, trafficNow, team, issueRows, commentRows, discussed] = await Promise.all([
    need(`repos/${REPO}`),
    allRows(`repos/${REPO}/releases`),
    traffic(),
    maintainers(),
    allRows(`repos/${REPO}/issues?state=all`),
    allRows(`repos/${REPO}/issues/comments`),
    discussions()
  ])

  const now = Date.now()
  const repo = parseRepo(repoRaw)
  const releases = parseReleases(releaseRows)
  const issues = parseIssues(issueRows)
  const feedback = summarizeFeedback(
    {
      contributions: [...issues, ...parseIssueComments(commentRows, pullNumbers(issues)), ...discussed.items],
      ...team,
      discussionsUnavailable: discussed.unavailable,
      truncated: discussed.truncated
    },
    now
  )

  const snapshot = takeSnapshot({ at: new Date(now).toISOString(), repo, releases, traffic: trafficNow })
  const merged = mergeHistory(history, snapshot, trafficNow)
  writeHistory(historyPath, merged)

  const report = buildReport({ now, historyPath: tilde(historyPath), history: merged, repo, releases, traffic: trafficNow, feedback })
  process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report))
} catch (err) {
  console.error(`stats: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}
