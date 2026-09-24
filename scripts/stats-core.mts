/**
 * IO-free half of scripts/stats.mts (`npm run stats`): how many people use Cockpit and how
 * many of them talk back, from nothing but what GitHub already records — there is no
 * telemetry and there must be none. The script makes the read-only `gh api` calls and
 * owns the history file; this parses what came back (defensively: it is remote input),
 * merges it into the history, derives the estimates and formats the report.
 * tests/stats-core.test.ts targets it.
 *
 * GitHub keeps traffic for 14 days and asset downloads only as a lifetime count per
 * file, which is why a local history exists at all: traffic is merged day by day, and one
 * snapshot per UTC day of every release's counts lets later runs take exact deltas.
 */

export const REPO = 'tashtit/cockpit'

const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
/** the span the headline numbers cover, and the age a history baseline aims for */
const RECENT_DAYS = 7
/** feedback counted as recent */
const FEEDBACK_RECENT_DAYS = 30

/**
 * The updater's schedule, as src/main/updates.ts sets it: one check FIRST_CHECK_DELAY_MS
 * after launch, then one every CHECK_INTERVAL_MS while the app runs. Each check fetches
 * `latest-mac.yml` off the latest release. tests/stats-core.test.ts reads updates.ts and
 * fails when these drift from it.
 */
export const UPDATE_CHECK = { firstDelaySeconds: 20, intervalHours: 4 } as const
/** a copy used in one working session a day */
const SESSION_HOURS = 8

/**
 * Checks one installed copy makes per day: a copy never quit checks every interval; one
 * launched for a single session checks at launch and at each interval that session outlives.
 */
export const CHECKS_PER_DAY = {
  neverQuit: 24 / UPDATE_CHECK.intervalHours,
  oneSession:
    1 + Math.floor((SESSION_HOURS * 3600 - UPDATE_CHECK.firstDelaySeconds) / (UPDATE_CHECK.intervalHours * 3600))
} as const

/* ---------- remote shapes ---------- */

type Json = Readonly<Record<string, unknown>>

function obj(v: unknown): Json | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null
}

function arr(v: unknown): readonly unknown[] {
  return Array.isArray(v) ? v : []
}

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

function isDate(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(v)
}

function isTime(v: string | null): v is string {
  return v !== null && Number.isFinite(Date.parse(v))
}

/** One day of GitHub traffic. */
export type DayCount = { readonly date: string; readonly count: number; readonly uniques: number }

/** A 14-day traffic series as GitHub returns it: its own totals plus a row per day. */
export type TrafficSeries = {
  readonly count: number
  readonly uniques: number
  readonly days: readonly DayCount[]
}

/** A referrer or a path, over GitHub's 14-day window. */
export type Popular = { readonly name: string; readonly count: number; readonly uniques: number }

export type Traffic =
  | {
      readonly ok: true
      readonly views: TrafficSeries
      readonly clones: TrafficSeries
      readonly referrers: readonly Popular[]
      readonly paths: readonly Popular[]
    }
  | { readonly ok: false; readonly reason: string }

/** `repos/{repo}/traffic/views` or `/clones`; `key` is the array field it carries. */
export function parseTrafficSeries(raw: unknown, key: 'views' | 'clones'): TrafficSeries {
  const o = obj(raw)
  const days = arr(o?.[key]).flatMap((row): DayCount[] => {
    const r = obj(row)
    const date = str(r?.['timestamp'])?.slice(0, 10) ?? ''
    return isDate(date) ? [{ date, count: count(r?.['count']), uniques: count(r?.['uniques']) }] : []
  })
  return { count: count(o?.['count']), uniques: count(o?.['uniques']), days }
}

/** `traffic/popular/referrers` (`referrer`) or `traffic/popular/paths` (`path`). */
export function parsePopular(raw: unknown, key: 'referrer' | 'path'): readonly Popular[] {
  return arr(raw).flatMap((row): Popular[] => {
    const r = obj(row)
    const name = str(r?.[key])
    return name ? [{ name, count: count(r?.['count']), uniques: count(r?.['uniques']) }] : []
  })
}

/**
 * Why a `gh api` call failed, from its stderr — `gh: Must have push access to repository
 * (HTTP 403)` — so the report can say it instead of stopping.
 */
export function ghFailure(stderr: string): { readonly status: number | null; readonly message: string } {
  const line = stderr.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? 'gh api failed'
  const status = /\(HTTP (\d{3})\)/.exec(stderr)
  return { status: status ? Number(status[1]) : null, message: line.replace(/^gh: /, '') }
}

export type RepoCounters = { readonly stars: number; readonly forks: number; readonly watchers: number }

/** `repos/{repo}`. `watchers_count` is a legacy alias of stars; people watching are `subscribers_count`. */
export function parseRepo(raw: unknown): RepoCounters {
  const o = obj(raw)
  return { stars: count(o?.['stargazers_count']), forks: count(o?.['forks_count']), watchers: count(o?.['subscribers_count']) }
}

/**
 * One published release and its lifetime downloads by what they mean. The feed file is
 * fetched by every installed copy's update check; the zip is what the app downloads to
 * update itself (update-install-core.ts `pickZip`); the disk image is the README's install
 * path. `other` is everything else — blockmaps, which nothing in the app fetches.
 */
export type Release = {
  readonly tag: string
  readonly publishedAt: string
  readonly prerelease: boolean
  readonly dmg: number
  readonly zip: number
  readonly feed: number
  readonly other: number
}

/** The update feed electron-updater reads off the latest release (src/main/updates.ts). */
export const FEED_ASSET = 'latest-mac.yml'

/** `repos/{repo}/releases`, every page flattened. Drafts are not public and are left out. */
export function parseReleases(rows: readonly unknown[]): readonly Release[] {
  return rows
    .flatMap((row): Release[] => {
      const r = obj(row)
      const tag = str(r?.['tag_name'])
      const publishedAt = str(r?.['published_at'])
      if (!tag || !isTime(publishedAt) || r?.['draft'] === true) return []
      const totals = { dmg: 0, zip: 0, feed: 0, other: 0 }
      for (const asset of arr(r?.['assets'])) {
        const a = obj(asset)
        const name = str(a?.['name']) ?? ''
        const n = count(a?.['download_count'])
        if (name === FEED_ASSET) totals.feed += n
        else if (name.endsWith('.dmg')) totals.dmg += n
        else if (name.endsWith('.zip')) totals.zip += n
        else totals.other += n
      }
      return [{ tag, publishedAt, prerelease: r?.['prerelease'] === true, ...totals }]
    })
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt))
}

/* ---------- feedback ---------- */

export type FeedbackKind = 'issue' | 'issue-comment' | 'discussion' | 'discussion-comment' | 'pr' | 'pr-comment'

/** The kinds the headline counts; pull requests are listed beside them, not in them. */
const FEEDBACK_KINDS: readonly FeedbackKind[] = ['issue', 'issue-comment', 'discussion', 'discussion-comment']

/** Anything someone wrote on the repo. */
export type Contribution = {
  readonly kind: FeedbackKind
  readonly author: string
  readonly bot: boolean
  readonly createdAt: string
  readonly url: string
  readonly title: string | null
}

function restAuthor(user: Json | null): { readonly author: string; readonly bot: boolean } | null {
  const login = str(user?.['login'])
  if (!login) return null
  return { author: login, bot: user?.['type'] === 'Bot' || login.endsWith('[bot]') }
}

/** `repos/{repo}/issues?state=all` — issues and pull requests in one list, told apart by `pull_request`. */
export function parseIssues(rows: readonly unknown[]): readonly Contribution[] {
  return rows.flatMap((row): Contribution[] => {
    const r = obj(row)
    const who = restAuthor(obj(r?.['user']))
    const createdAt = str(r?.['created_at'])
    if (!who || !isTime(createdAt)) return []
    const kind = r?.['pull_request'] ? 'pr' : 'issue'
    return [{ kind, ...who, createdAt, url: str(r?.['html_url']) ?? '', title: str(r?.['title']) }]
  })
}

/** Numbers of the pull requests in a `parseIssues` result, to tell PR comments from issue comments. */
export function pullNumbers(issues: readonly Contribution[]): ReadonlySet<number> {
  return new Set(issues.filter((i) => i.kind === 'pr').map((i) => numberOf(i.url)).filter((n) => n > 0))
}

function numberOf(url: string): number {
  const m = /\/(?:issues|pull)\/(\d+)/.exec(url)
  return m ? Number(m[1]) : 0
}

/** `repos/{repo}/issues/comments` — comments on issues and on pull requests alike. */
export function parseIssueComments(rows: readonly unknown[], pulls: ReadonlySet<number>): readonly Contribution[] {
  return rows.flatMap((row): Contribution[] => {
    const r = obj(row)
    const who = restAuthor(obj(r?.['user']))
    const createdAt = str(r?.['created_at'])
    if (!who || !isTime(createdAt)) return []
    const url = str(r?.['html_url']) ?? ''
    const onPull = url.includes('/pull/') || pulls.has(numberOf(str(r?.['issue_url']) ?? ''))
    return [{ kind: onPull ? 'pr-comment' : 'issue-comment', ...who, createdAt, url, title: null }]
  })
}

/** One page of the discussions GraphQL query in scripts/stats.mts. */
export type DiscussionPage = {
  readonly items: readonly Contribution[]
  /** a discussion held more comments or replies than one query returns */
  readonly truncated: boolean
  readonly next: string | null
}

function graphContribution(node: Json | null, kind: FeedbackKind): Contribution | null {
  const author = obj(node?.['author'])
  // a deleted account reads as null; GitHub shows it as "ghost"
  const login = str(author?.['login']) ?? 'ghost'
  const createdAt = str(node?.['createdAt'])
  if (!isTime(createdAt)) return null
  const bot = author?.['__typename'] === 'Bot' || login.endsWith('[bot]')
  return { kind, author: login, bot, createdAt, url: str(node?.['url']) ?? '', title: str(node?.['title']) }
}

export function parseDiscussionPage(raw: unknown): DiscussionPage {
  const discussions = obj(obj(obj(obj(raw)?.['data'])?.['repository'])?.['discussions'])
  const items: Contribution[] = []
  let truncated = false
  const connection = (v: unknown): readonly Json[] => {
    const c = obj(v)
    const nodes = arr(c?.['nodes']).flatMap((n) => (obj(n) ? [obj(n)!] : []))
    if (count(c?.['totalCount']) > nodes.length) truncated = true
    return nodes
  }
  for (const d of arr(discussions?.['nodes'])) {
    const node = obj(d)
    const item = graphContribution(node, 'discussion')
    if (item) items.push(item)
    for (const c of connection(node?.['comments'])) {
      const comment = graphContribution(c, 'discussion-comment')
      if (comment) items.push(comment)
      for (const reply of connection(c['replies'])) {
        const r = graphContribution(reply, 'discussion-comment')
        if (r) items.push(r)
      }
    }
  }
  const page = obj(discussions?.['pageInfo'])
  return { items, truncated, next: page?.['hasNextPage'] === true ? str(page['endCursor']) : null }
}

/** Collaborators who can push — the team. */
export function maintainersFromCollaborators(rows: readonly unknown[]): readonly string[] {
  return rows.flatMap((row) => {
    const r = obj(row)
    const login = str(r?.['login'])
    return login && obj(r?.['permissions'])?.['push'] === true ? [login] : []
  })
}

/** Every `@user` a CODEOWNERS file names. Teams (`@org/team`) cannot be expanded offline and are skipped. */
export function codeownersHandles(text: string): readonly string[] {
  const handles = text
    .split('\n')
    .map((line) => line.replace(/#.*/, '').trim())
    .flatMap((line) => line.split(/\s+/).slice(1))
    .filter((h) => /^@[\w-]+$/.test(h))
    .map((h) => h.slice(1))
  return [...new Set(handles)]
}

export type FeedbackSummary = {
  readonly maintainers: readonly string[]
  readonly maintainersFrom: 'collaborators' | 'CODEOWNERS'
  readonly counts: Readonly<Record<FeedbackKind, number>>
  /** issues, issue comments, discussions and discussion comments from outside the team */
  readonly total: number
  readonly recent: number
  readonly recentDays: number
  /** newest first, headline kinds only */
  readonly newest: readonly Contribution[]
  /** why discussions could not be read; null when they were */
  readonly discussionsUnavailable: string | null
  readonly truncated: boolean
}

export type FeedbackInput = {
  readonly contributions: readonly Contribution[]
  readonly maintainers: readonly string[]
  readonly maintainersFrom: FeedbackSummary['maintainersFrom']
  readonly discussionsUnavailable: string | null
  readonly truncated: boolean
}

/** What people outside the team wrote: every author that is neither a maintainer nor a bot. */
export function summarizeFeedback(input: FeedbackInput, now: number): FeedbackSummary {
  const team = new Set(input.maintainers.map((m) => m.toLowerCase()))
  const outside = input.contributions.filter((c) => !c.bot && !team.has(c.author.toLowerCase()))
  const counts = { issue: 0, 'issue-comment': 0, discussion: 0, 'discussion-comment': 0, pr: 0, 'pr-comment': 0 }
  for (const c of outside) counts[c.kind] += 1
  const headline = outside
    .filter((c) => FEEDBACK_KINDS.includes(c.kind))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  const since = now - FEEDBACK_RECENT_DAYS * DAY_MS
  return {
    maintainers: [...input.maintainers].sort((a, b) => a.localeCompare(b)),
    maintainersFrom: input.maintainersFrom,
    counts,
    total: headline.length,
    recent: headline.filter((c) => Date.parse(c.createdAt) >= since).length,
    recentDays: FEEDBACK_RECENT_DAYS,
    newest: headline.slice(0, 5),
    discussionsUnavailable: input.discussionsUnavailable,
    truncated: input.truncated
  }
}

/* ---------- history ---------- */

/** One day's counts; a same-day re-run replaces it. */
export type Snapshot = {
  readonly at: string
  readonly stars: number
  readonly forks: number
  readonly watchers: number
  /** tag → lifetime downloads at `at`: [disk image, zip, update feed] */
  readonly releases: Readonly<Record<string, readonly [number, number, number]>>
  /** GitHub's 14-day referrers at `at` — kept because GitHub forgets them */
  readonly referrers: readonly Popular[]
}

export type History = {
  readonly version: 1
  readonly repo: string
  readonly views: readonly DayCount[]
  readonly clones: readonly DayCount[]
  readonly snapshots: readonly Snapshot[]
}

export function emptyHistory(): History {
  return { version: 1, repo: REPO, views: [], clones: [], snapshots: [] }
}

function parseDays(v: unknown): readonly DayCount[] {
  return arr(v).flatMap((row): DayCount[] => {
    const r = obj(row)
    const date = str(r?.['date'])
    return date && isDate(date) ? [{ date, count: count(r?.['count']), uniques: count(r?.['uniques']) }] : []
  })
}

function parseSnapshot(v: unknown): Snapshot | null {
  const s = obj(v)
  const at = str(s?.['at'])
  if (!isTime(at)) return null
  const releases: Record<string, readonly [number, number, number]> = {}
  for (const [tag, counts] of Object.entries(obj(s?.['releases']) ?? {})) {
    const c = arr(counts)
    releases[tag] = [count(c[0]), count(c[1]), count(c[2])]
  }
  const referrers = arr(s?.['referrers']).flatMap((row): Popular[] => {
    const r = obj(row)
    const name = str(r?.['name'])
    return name ? [{ name, count: count(r?.['count']), uniques: count(r?.['uniques']) }] : []
  })
  return { at, stars: count(s?.['stars']), forks: count(s?.['forks']), watchers: count(s?.['watchers']), releases, referrers }
}

/**
 * A history file read back. Rows that do not parse are dropped, but a file this version
 * cannot own — a newer format, another repo — throws, so it is never overwritten.
 */
export function parseHistory(raw: unknown): History {
  const h = obj(raw)
  if (!h) throw new Error('the history file is not a JSON object')
  if (h['version'] !== 1) throw new Error(`the history file is version ${String(h['version'])}; this script writes version 1`)
  if (h['repo'] !== REPO) throw new Error(`the history file is for ${String(h['repo'])}, not ${REPO}`)
  return {
    version: 1,
    repo: REPO,
    views: parseDays(h['views']),
    clones: parseDays(h['clones']),
    snapshots: arr(h['snapshots']).flatMap((s) => parseSnapshot(s) ?? [])
  }
}

/**
 * Two runs' days folded into one row per date, keeping the most seen for each field:
 * today's row grows through the day, and a day that has left GitHub's window stays as
 * it was last seen.
 */
export function mergeDays(a: readonly DayCount[], b: readonly DayCount[]): readonly DayCount[] {
  const byDate = new Map<string, DayCount>()
  for (const d of [...a, ...b]) {
    const seen = byDate.get(d.date)
    byDate.set(d.date, seen ? { date: d.date, count: Math.max(seen.count, d.count), uniques: Math.max(seen.uniques, d.uniques) } : d)
  }
  return [...byDate.values()].sort((x, y) => x.date.localeCompare(y.date))
}

export type SnapshotInput = {
  readonly at: string
  readonly repo: RepoCounters
  readonly releases: readonly Release[]
  readonly traffic: Traffic
}

export function takeSnapshot(input: SnapshotInput): Snapshot {
  const releases: Record<string, readonly [number, number, number]> = {}
  for (const r of input.releases) releases[r.tag] = [r.dmg, r.zip, r.feed]
  return { at: input.at, ...input.repo, releases, referrers: input.traffic.ok ? input.traffic.referrers : [] }
}

/** The run folded in: traffic merged per day, the snapshot replacing any other from its UTC day. */
export function mergeHistory(history: History, snapshot: Snapshot, traffic: Traffic): History {
  const day = snapshot.at.slice(0, 10)
  return {
    ...history,
    views: traffic.ok ? mergeDays(history.views, traffic.views.days) : history.views,
    clones: traffic.ok ? mergeDays(history.clones, traffic.clones.days) : history.clones,
    snapshots: [...history.snapshots.filter((s) => s.at.slice(0, 10) !== day), snapshot].sort(
      (a, b) => Date.parse(a.at) - Date.parse(b.at)
    )
  }
}

/* ---------- estimates ---------- */

/**
 * The snapshot to take deltas from: at least a day old — anything younger measures the
 * time of day more than use — and otherwise as close to a week old as the history has.
 */
export function baselineSnapshot(snapshots: readonly Snapshot[], now: number): Snapshot | null {
  let best: Snapshot | null = null
  for (const s of snapshots) {
    const age = now - Date.parse(s.at)
    if (age < DAY_MS) continue
    if (!best || Math.abs(age - RECENT_DAYS * DAY_MS) < Math.abs(now - Date.parse(best.at) - RECENT_DAYS * DAY_MS)) best = s
  }
  return best
}

/**
 * When a release was the latest one: from its publication until the next one's (or now).
 * Only the latest release is offered to updaters (`releases/latest` → its feed file, then
 * its zip) and linked from the README, so that is when its downloads happen.
 */
export type LatestWindow = {
  readonly tag: string
  readonly start: number
  readonly end: number
  readonly dmg: number
  readonly zip: number
  readonly feed: number
}

export function latestWindows(releases: readonly Release[], now: number): readonly LatestWindow[] {
  const stable = releases
    .filter((r) => !r.prerelease)
    .map((r) => ({ r, start: Date.parse(r.publishedAt) }))
    .sort((a, b) => a.start - b.start)
  return stable.map(({ r, start }, i) => ({
    tag: r.tag,
    start,
    end: Math.max(start, stable[i + 1]?.start ?? now),
    dmg: r.dmg,
    zip: r.zip,
    feed: r.feed
  }))
}

export type Downloads = { readonly dmg: number; readonly zip: number; readonly feed: number }

/** Lifetime counts spread over [from, to) in proportion to how much of each window falls in it. */
export function spread(windows: readonly LatestWindow[], range: { readonly from: number; readonly to: number }): Downloads {
  let dmg = 0
  let zip = 0
  let feed = 0
  for (const w of windows) {
    const length = w.end - w.start
    const share =
      length > 0
        ? Math.max(0, Math.min(w.end, range.to) - Math.max(w.start, range.from)) / length
        : w.start >= range.from && w.start < range.to
          ? 1
          : 0
    dmg += w.dmg * share
    zip += w.zip * share
    feed += w.feed * share
  }
  return { dmg, zip, feed }
}

/** Downloads over the recent past, and where the figure came from. */
export type Recent = Downloads & {
  readonly days: number
  readonly since: string
  readonly source: 'history' | 'release windows'
}

/**
 * The last week or so: exact deltas against a history baseline when one exists, otherwise
 * the releases' lifetime counts spread over when each was latest.
 */
export function recentDownloads(releases: readonly Release[], history: History, now: number): Recent | null {
  if (releases.length === 0) return null
  const base = baselineSnapshot(history.snapshots, now)
  if (base) {
    const d = { dmg: 0, zip: 0, feed: 0 }
    for (const r of releases) {
      const [dmg, zip, feed] = base.releases[r.tag] ?? [0, 0, 0]
      d.dmg += Math.max(0, r.dmg - dmg)
      d.zip += Math.max(0, r.zip - zip)
      d.feed += Math.max(0, r.feed - feed)
    }
    return { ...d, days: (now - Date.parse(base.at)) / DAY_MS, since: base.at, source: 'history' }
  }
  const windows = latestWindows(releases, now)
  const first = windows[0]
  if (!first) return null
  const from = Math.max(now - RECENT_DAYS * DAY_MS, first.start)
  if (now - from < HOUR_MS) return null
  return { ...spread(windows, { from, to: now }), days: (now - from) / DAY_MS, since: new Date(from).toISOString(), source: 'release windows' }
}

export type Range = { readonly low: number; readonly high: number }

/** Installed copies behind a rate of update checks per day. */
export function activeInstalls(checksPerDay: number): Range {
  return { low: checksPerDay / CHECKS_PER_DAY.neverQuit, high: checksPerDay / CHECKS_PER_DAY.oneSession }
}

export type WeekTraffic = {
  readonly count: number
  /** the sum of daily uniques — one person on three days counts three times */
  readonly uniques: number
  /** the history holds only some of this week's days */
  readonly partial: boolean
}

export type Week = {
  /** Monday, UTC */
  readonly start: string
  readonly views: WeekTraffic | null
  readonly clones: WeekTraffic | null
  /** null for a week before the first release */
  readonly downloads: Downloads | null
  readonly active: Range | null
}

function monday(ms: number): number {
  const d = new Date(ms)
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
  return midnight - ((d.getUTCDay() + 6) % 7) * DAY_MS
}

function dateMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`)
}

/**
 * One week of a merged traffic series. It is partial when the series misses a day of the
 * week up to the newest day it holds — GitHub has no row for today until the day ends,
 * so the current week is judged only up to there.
 */
function weekTraffic(days: readonly DayCount[], start: number): WeekTraffic | null {
  const end = start + 7 * DAY_MS
  const inWeek = days.filter((d) => dateMs(d.date) >= start && dateMs(d.date) < end)
  const last = days.at(-1)
  if (inWeek.length === 0 || !last) return null
  const expected = Math.round((Math.min(end - DAY_MS, dateMs(last.date)) - start) / DAY_MS) + 1
  return {
    count: inWeek.reduce((n, d) => n + d.count, 0),
    uniques: inWeek.reduce((n, d) => n + d.uniques, 0),
    partial: inWeek.length < expected
  }
}

/** Calendar weeks (Monday, UTC) from the first release or traffic day up to now, newest last. */
export function weekly(releases: readonly Release[], history: History, opts: { readonly now: number; readonly weeks: number }): readonly Week[] {
  const { now } = opts
  const windows = latestWindows(releases, now)
  const firstRelease = windows[0]?.start ?? Infinity
  const firstDay = [history.views[0]?.date, history.clones[0]?.date]
    .flatMap((d) => (d ? [dateMs(d)] : []))
    .reduce((a, b) => Math.min(a, b), Infinity)
  const earliest = Math.min(firstRelease, firstDay)
  if (!Number.isFinite(earliest)) return []
  const out: Week[] = []
  for (let start = monday(earliest); start <= now; start += 7 * DAY_MS) {
    // the part of this week any release was out for
    const from = Math.max(start, firstRelease)
    const to = Math.min(start + 7 * DAY_MS, now)
    const downloads = from < to ? spread(windows, { from, to }) : null
    const hours = (to - from) / HOUR_MS
    out.push({
      start: new Date(start).toISOString().slice(0, 10),
      views: weekTraffic(history.views, start),
      clones: weekTraffic(history.clones, start),
      downloads,
      active: downloads && hours >= 1 ? activeInstalls((downloads.feed / hours) * 24) : null
    })
  }
  return out.slice(-opts.weeks)
}

/* ---------- the report ---------- */

export type Report = {
  readonly repo: string
  readonly generatedAt: string
  readonly history: {
    readonly path: string
    readonly snapshots: number
    readonly since: string | null
    readonly trafficFrom: string | null
    readonly trafficTo: string | null
  }
  readonly counters: RepoCounters
  /** the counters at the history baseline, when there is one */
  readonly countersThen: (RepoCounters & { readonly at: string }) | null
  readonly feedback: FeedbackSummary
  readonly usage: {
    readonly recent: Recent | null
    readonly active: Range | null
    readonly totals: Downloads & { readonly other: number }
    readonly latest: Release | null
  }
  readonly weekly: readonly Week[]
  readonly traffic: Traffic
  readonly releases: readonly Release[]
}

export type ReportInput = {
  readonly now: number
  readonly historyPath: string
  /** already merged with this run */
  readonly history: History
  readonly repo: RepoCounters
  readonly releases: readonly Release[]
  readonly traffic: Traffic
  readonly feedback: FeedbackSummary
}

export function buildReport(input: ReportInput): Report {
  const { now, history, releases } = input
  const base = baselineSnapshot(history.snapshots, now)
  const recent = recentDownloads(releases, history, now)
  const totals = releases.reduce(
    (t, r) => ({ dmg: t.dmg + r.dmg, zip: t.zip + r.zip, feed: t.feed + r.feed, other: t.other + r.other }),
    { dmg: 0, zip: 0, feed: 0, other: 0 }
  )
  const days = [...history.views, ...history.clones].map((d) => d.date).sort()
  return {
    repo: REPO,
    generatedAt: new Date(now).toISOString(),
    history: {
      path: input.historyPath,
      snapshots: history.snapshots.length,
      since: history.snapshots[0]?.at ?? null,
      trafficFrom: days[0] ?? null,
      trafficTo: days.at(-1) ?? null
    },
    counters: input.repo,
    countersThen: base ? { at: base.at, stars: base.stars, forks: base.forks, watchers: base.watchers } : null,
    feedback: input.feedback,
    usage: {
      recent,
      active: recent && recent.days > 0 ? activeInstalls(recent.feed / recent.days) : null,
      totals,
      latest: releases.find((r) => !r.prerelease) ?? null
    },
    weekly: weekly(releases, history, { now, weeks: 8 }),
    traffic: input.traffic,
    releases
  }
}

/* ---------- formatting ---------- */

/** Columns padded to their widest cell; `align` is one of l/r per column. */
export function table(rows: readonly (readonly string[])[], align: string): readonly string[] {
  const widths: number[] = []
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)))
  return rows.map((row) =>
    row
      .map((cell, i) => (align[i] === 'r' ? cell.padStart(widths[i]!) : cell.padEnd(widths[i]!)))
      .join('  ')
      .trimEnd()
  )
}

/** A rate or an estimate: one decimal below 10, whole from there. */
export function approx(n: number): string {
  if (n === 0) return '0'
  if (n >= 10) return String(Math.round(n))
  return n.toFixed(1).replace(/\.0$/, '')
}

/** A download count, which spreading over windows can leave fractional. */
function whole(n: number | undefined): string {
  return n === undefined ? '-' : String(Math.round(n))
}

function range(r: Range | null): string {
  return r ? `${approx(r.low)}–${approx(r.high)}` : '-'
}

function day(iso: string): string {
  return iso.slice(0, 10)
}

function minute(iso: string): string {
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`
}

function duration(ms: number): string {
  if (ms < HOUR_MS) return `${Math.round(ms / 60_000)}m`
  if (ms < 2 * DAY_MS) return `${approx(ms / HOUR_MS)}h`
  return `${approx(ms / DAY_MS)}d`
}

function signed(n: number): string {
  return n >= 0 ? `+${n}` : String(n)
}

function trafficCell(t: WeekTraffic | null, pick: 'count' | 'uniques'): string {
  return t ? `${t[pick]}${t.partial ? '*' : ''}` : '-'
}

const KIND_LABEL: Readonly<Record<FeedbackKind, string>> = {
  issue: 'issue',
  'issue-comment': 'comment',
  discussion: 'discussion',
  'discussion-comment': 'reply',
  pr: 'PR',
  'pr-comment': 'PR comment'
}

function feedbackLines(f: FeedbackSummary): readonly string[] {
  const c = f.counts
  const from = f.maintainersFrom === 'collaborators' ? 'repo collaborators with push' : 'CODEOWNERS (collaborators refused)'
  const lines = [
    'Feedback from outside the team',
    `  ${f.total} in all, ${f.recent} in the last ${f.recentDays} days: issues ${c.issue} · issue comments ${c['issue-comment']} · ` +
      `discussions ${c.discussion} · discussion comments ${c['discussion-comment']}`,
    `  not counted above: ${c.pr} pull requests and ${c['pr-comment']} PR comments from outside`,
    `  team (${from}): ${f.maintainers.join(', ') || 'none found'}; bots excluded`
  ]
  if (f.discussionsUnavailable) lines.push(`  discussions could not be read: ${f.discussionsUnavailable}`)
  if (f.truncated) lines.push('  some discussion threads hold more comments than one query returns; those are undercounted')
  if (f.newest.length > 0) {
    lines.push('  newest:')
    lines.push(
      ...table(
        f.newest.map((n) => [day(n.createdAt), KIND_LABEL[n.kind], `@${n.author}`, n.title ?? '', n.url]),
        'lllll'
      ).map((l) => `    ${l}`)
    )
  }
  return lines
}

function usageLines(r: Report): readonly string[] {
  const { recent, active, totals, latest } = r.usage
  const over = recent
    ? `the last ${approx(recent.days)} days (${recent.source === 'history' ? `history since ${day(recent.since)}` : 'release windows'})`
    : ''
  const rows = [
    [
      'active installs',
      active ? `≈ ${range(active)}` : '-',
      recent ? `${approx(recent.feed / recent.days)} update checks a day over ${over}` : 'no release data yet'
    ],
    ['new installs', whole(recent?.dmg), `disk-image downloads over the same span · ${totals.dmg} all time`],
    [
      'updates',
      whole(recent?.zip),
      `zip downloads over the same span · ${totals.zip} all time${latest ? ` · ${latest.zip} to ${latest.tag} so far` : ''}`
    ]
  ]
  return ['Usage (estimates; see how they are made below)', ...table(rows, 'lrl').map((l) => `  ${l}`)]
}

function counterLines(r: Report): readonly string[] {
  const c = r.counters
  const t = r.countersThen
  const change = t
    ? `   since ${day(t.at)}: ${signed(c.stars - t.stars)} · ${signed(c.forks - t.forks)} · ${signed(c.watchers - t.watchers)}`
    : ''
  return ['Repo', `  stars ${c.stars} · forks ${c.forks} · watchers ${c.watchers}${change}`]
}

function weeklyLines(r: Report): readonly string[] {
  if (r.weekly.length === 0) return []
  const header = ['week of', 'views', 'visitor-days', 'clones', 'new (dmg)', 'updates (zip)', 'checks', '≈ active']
  const rows = r.weekly.map((w) => [
    w.start,
    trafficCell(w.views, 'count'),
    trafficCell(w.views, 'uniques'),
    trafficCell(w.clones, 'count'),
    whole(w.downloads?.dmg),
    whole(w.downloads?.zip),
    whole(w.downloads?.feed),
    range(w.active)
  ])
  const partial = r.weekly.some((w) => w.views?.partial || w.clones?.partial)
  const missing = rows.some((row) => row.includes('-'))
  return [
    'Weekly (weeks start Monday UTC; the last one is so far)',
    ...table([header, ...rows], 'lrrrrrrr').map((l) => `  ${l}`),
    ...(partial ? ['  * the history holds only part of that week'] : []),
    ...(missing ? ['  - nothing to count: traffic from before the history began, or no release out yet'] : [])
  ]
}

function trafficLines(t: Traffic): readonly string[] {
  if (!t.ok) return ['Traffic, last 14 days', `  unavailable: ${t.reason}`]
  const list = (items: readonly Popular[], strip: string): string =>
    items.slice(0, 5).map((p) => `${p.name.replace(strip, '') || '/'} ${p.count} (${p.uniques})`).join(' · ') || 'none'
  return [
    "Traffic, last 14 days (GitHub's own window; count (unique))",
    `  views ${t.views.count} (${t.views.uniques}) · clones ${t.clones.count} (${t.clones.uniques}), mostly CI checkouts`,
    `  referrers  ${list(t.referrers, '')}`,
    `  top paths  ${list(t.paths, `/${REPO}`)}`
  ]
}

function releaseLines(r: Report, now: number): readonly string[] {
  const shown = r.releases.slice(0, 8)
  if (shown.length === 0) return ['Releases', '  none published']
  const windows = new Map(latestWindows(r.releases, now).map((w) => [w.tag, w]))
  const rows = shown.map((rel) => {
    const w = windows.get(rel.tag)
    const latestFor = w ? `${duration(w.end - w.start)}${w.end === now ? ' (now)' : ''}` : 'prerelease'
    return [rel.tag, minute(rel.publishedAt), latestFor, String(rel.dmg), String(rel.zip), String(rel.feed)]
  })
  const t = r.usage.totals
  const lines = [
    `Releases (newest ${shown.length} of ${r.releases.length}; lifetime downloads)`,
    ...table(
      [
        ['release', 'published', 'latest for', 'dmg', 'zip', 'checks'],
        ...rows,
        [`all ${r.releases.length}`, '', '', String(t.dmg), String(t.zip), String(t.feed)]
      ],
      'lllrrr'
    ).map((l) => `  ${l}`),
    '  a release\'s zip count = installed copies that updated to it'
  ]
  if (t.other > 0) {
    lines.push(`  plus ${t.other} blockmap downloads: nothing in the app fetches those, so some client other than`)
    lines.push('  Cockpit or a person (a mirror, a scanner) downloads assets too, and may inflate the counts above')
  }
  return lines
}

const ASSUMPTIONS: readonly string[] = [
  'How the estimates are made',
  `  active installs  an installed copy fetches ${FEED_ASSET} ${UPDATE_CHECK.firstDelaySeconds}s after launch and every ` +
    `${UPDATE_CHECK.intervalHours}h while it runs`,
  `                   (src/main/updates.ts): ${CHECKS_PER_DAY.neverQuit} checks a day if never quit, ${CHECKS_PER_DAY.oneSession} ` +
    `for one ${SESSION_HOURS}h session, so`,
  `                   installs ≈ checks a day ÷ ${CHECKS_PER_DAY.neverQuit} … ÷ ${CHECKS_PER_DAY.oneSession}; the team's own copies count too`,
  '  new installs     one disk-image download = one fresh install (the README\'s install path); re-downloads count too',
  '  updates          one zip download = one installed copy updating to that release; once the curl installer',
  '                   (scripts/install.sh) ships, its fresh installs download the zip as well',
  '  weekly           GitHub keeps one lifetime count per asset, so each release\'s counts are spread over the time',
  '                   it was the latest release — the only one updaters check and the README links',
  '  clones           mostly CI checkouts: every workflow run clones the repo'
]

export function formatReport(r: Report): string {
  const now = Date.parse(r.generatedAt)
  const h = r.history
  const kept = h.trafficFrom && h.trafficTo ? ` · traffic ${h.trafficFrom} → ${h.trafficTo}` : ''
  const snapshots = `${h.snapshots} daily snapshot${h.snapshots === 1 ? '' : 's'}${h.since ? ` since ${day(h.since)}` : ''}`
  const sections: readonly (readonly string[])[] = [
    [`Cockpit adoption · ${r.repo} · ${minute(r.generatedAt)} UTC`, `history  ${h.path} · ${snapshots}${kept}`],
    feedbackLines(r.feedback),
    usageLines(r),
    counterLines(r),
    weeklyLines(r),
    trafficLines(r.traffic),
    releaseLines(r, now),
    ASSUMPTIONS
  ]
  return sections.filter((s) => s.length > 0).map((s) => s.join('\n')).join('\n\n') + '\n'
}
