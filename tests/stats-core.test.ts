import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  activeInstalls,
  baselineSnapshot,
  buildReport,
  CHECKS_PER_DAY,
  codeownersHandles,
  emptyHistory,
  formatReport,
  ghFailure,
  latestWindows,
  maintainersFromCollaborators,
  mergeDays,
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
  recentDownloads,
  REPO,
  spread,
  summarizeFeedback,
  takeSnapshot,
  UPDATE_CHECK,
  weekly,
  type FeedbackSummary,
  type History,
  type Release,
  type Snapshot,
  type Traffic
} from '../scripts/stats-core.mts'

const DAY = 86_400_000
const NOW = Date.parse('2026-09-24T12:00:00Z')

function asset(name: string, download_count: number): object {
  return { name, download_count }
}

function release(tag: string, published_at: string, counts: { dmg?: number; zip?: number; feed?: number } = {}): object {
  return {
    tag_name: tag,
    published_at,
    draft: false,
    prerelease: false,
    assets: [
      asset(`Cockpit-${tag.slice(1)}-arm64.dmg`, counts.dmg ?? 0),
      asset(`Cockpit-${tag.slice(1)}-arm64.zip`, counts.zip ?? 0),
      asset('latest-mac.yml', counts.feed ?? 0)
    ]
  }
}

const noTraffic: Traffic = { ok: false, reason: 'HTTP 403' }

function snapshot(at: string, releases: Snapshot['releases'], stars = 0): Snapshot {
  return { at, stars, forks: 0, watchers: 0, releases, referrers: [] }
}

describe('the updater schedule the estimate rests on', () => {
  it('matches src/main/updates.ts', () => {
    const source = readFileSync(new URL('../src/main/updates.ts', import.meta.url), 'utf8')
    const product = (name: string): number => {
      const expr = new RegExp(`const ${name} = ([\\d_ *]+)\\n`).exec(source)?.[1]
      expect(expr, `${name} in updates.ts`).toBeDefined()
      return expr!.split('*').reduce((n, f) => n * Number(f.trim().replace(/_/g, '')), 1)
    }
    expect(product('CHECK_INTERVAL_MS')).toBe(UPDATE_CHECK.intervalHours * 3_600_000)
    expect(product('FIRST_CHECK_DELAY_MS')).toBe(UPDATE_CHECK.firstDelaySeconds * 1000)
  })

  it('counts 6 checks a day for a copy never quit and 2 for one 8h session', () => {
    expect(CHECKS_PER_DAY).toEqual({ neverQuit: 6, oneSession: 2 })
    expect(activeInstalls(12)).toEqual({ low: 2, high: 6 })
  })
})

describe('parsing what gh returns', () => {
  it('reads traffic days and drops rows it cannot date', () => {
    const raw = {
      count: 5,
      uniques: 2,
      views: [
        { timestamp: '2026-09-22T00:00:00Z', count: 3, uniques: 1 },
        { timestamp: 'yesterday', count: 9, uniques: 9 },
        { timestamp: '2026-09-23T00:00:00Z', count: -1, uniques: 'x' }
      ]
    }
    expect(parseTrafficSeries(raw, 'views')).toEqual({
      count: 5,
      uniques: 2,
      days: [
        { date: '2026-09-22', count: 3, uniques: 1 },
        { date: '2026-09-23', count: 0, uniques: 0 }
      ]
    })
    expect(parseTrafficSeries(null, 'clones')).toEqual({ count: 0, uniques: 0, days: [] })
  })

  it('reads referrers and paths', () => {
    expect(parsePopular([{ referrer: 'github.com', count: 8, uniques: 3 }, { count: 1 }], 'referrer')).toEqual([
      { name: 'github.com', count: 8, uniques: 3 }
    ])
    expect(parsePopular({ message: 'nope' }, 'path')).toEqual([])
  })

  it('reads the status and message of a refused call', () => {
    expect(ghFailure('gh: Must have push access to repository (HTTP 403)\n')).toEqual({
      status: 403,
      message: 'Must have push access to repository (HTTP 403)'
    })
    expect(ghFailure('')).toEqual({ status: null, message: 'gh api failed' })
  })

  it('takes watchers from subscribers, not the legacy alias of stars', () => {
    expect(parseRepo({ stargazers_count: 7, watchers_count: 7, subscribers_count: 2, forks_count: 1 })).toEqual({
      stars: 7,
      forks: 1,
      watchers: 2
    })
  })

  it('splits release downloads by what each asset is for, newest release first, drafts out', () => {
    const rows = [
      release('v0.1.0', '2026-09-15T10:00:00Z', { dmg: 2, zip: 1, feed: 4 }),
      {
        tag_name: 'v0.2.0',
        published_at: '2026-09-16T10:00:00Z',
        assets: [
          asset('Cockpit-0.2.0-arm64.dmg', 1),
          asset('Cockpit-0.2.0-x64.dmg', 2),
          asset('Cockpit-0.2.0-x64.zip', 3),
          asset('Cockpit-0.2.0-x64.zip.blockmap', 5),
          asset('latest-mac.yml', 6)
        ]
      },
      { ...release('v0.3.0', '2026-09-17T10:00:00Z'), draft: true },
      { tag_name: 'v0.4.0', published_at: null, assets: [] },
      'garbage'
    ]
    expect(parseReleases(rows)).toEqual([
      { tag: 'v0.2.0', publishedAt: '2026-09-16T10:00:00Z', prerelease: false, dmg: 3, zip: 3, feed: 6, other: 5 },
      { tag: 'v0.1.0', publishedAt: '2026-09-15T10:00:00Z', prerelease: false, dmg: 2, zip: 1, feed: 4, other: 0 }
    ])
  })

  it('tells pull requests and their comments from issues and theirs', () => {
    const issues = parseIssues([
      { number: 1, user: { login: 'someone', type: 'User' }, created_at: '2026-09-20T00:00:00Z', html_url: 'https://github.com/tashtit/cockpit/issues/1', title: 'Crash' },
      { number: 2, user: { login: 'dependabot[bot]', type: 'Bot' }, created_at: '2026-09-20T00:00:00Z', html_url: 'https://github.com/tashtit/cockpit/pull/2', pull_request: {} },
      { number: 3, user: null, created_at: '2026-09-20T00:00:00Z' }
    ])
    expect(issues.map((i) => [i.kind, i.author, i.bot])).toEqual([
      ['issue', 'someone', false],
      ['pr', 'dependabot[bot]', true]
    ])
    const comments = parseIssueComments(
      [
        { user: { login: 'a', type: 'User' }, created_at: '2026-09-21T00:00:00Z', html_url: 'https://github.com/tashtit/cockpit/issues/1#issuecomment-1', issue_url: 'https://api.github.com/repos/tashtit/cockpit/issues/1' },
        { user: { login: 'b', type: 'User' }, created_at: '2026-09-21T00:00:00Z', html_url: 'https://github.com/tashtit/cockpit/pull/2#issuecomment-2' },
        { user: { login: 'c', type: 'User' }, created_at: '2026-09-21T00:00:00Z', html_url: '', issue_url: 'https://api.github.com/repos/tashtit/cockpit/issues/2' }
      ],
      pullNumbers(issues)
    )
    expect(comments.map((c) => c.kind)).toEqual(['issue-comment', 'pr-comment', 'pr-comment'])
  })

  it('reads discussions, their comments and replies, and says when a thread was cut short', () => {
    const page = parseDiscussionPage({
      data: {
        repository: {
          discussions: {
            pageInfo: { hasNextPage: true, endCursor: 'abc' },
            nodes: [
              {
                title: 'Idea',
                url: 'https://github.com/tashtit/cockpit/discussions/1',
                createdAt: '2026-09-20T00:00:00Z',
                author: { __typename: 'User', login: 'fan' },
                comments: {
                  totalCount: 3,
                  nodes: [
                    {
                      url: 'u1',
                      createdAt: '2026-09-21T00:00:00Z',
                      author: null,
                      replies: { totalCount: 1, nodes: [{ url: 'u2', createdAt: '2026-09-22T00:00:00Z', author: { __typename: 'Bot', login: 'helper' } }] }
                    }
                  ]
                }
              }
            ]
          }
        }
      }
    })
    expect(page.items.map((i) => [i.kind, i.author, i.bot])).toEqual([
      ['discussion', 'fan', false],
      ['discussion-comment', 'ghost', false],
      ['discussion-comment', 'helper', true]
    ])
    expect(page.truncated).toBe(true)
    expect(page.next).toBe('abc')
    expect(parseDiscussionPage({ errors: [{}] })).toEqual({ items: [], truncated: false, next: null })
  })

  it('takes the team from collaborators who can push, or from CODEOWNERS', () => {
    expect(
      maintainersFromCollaborators([
        { login: 'a', permissions: { push: true } },
        { login: 'b', permissions: { push: false, pull: true } },
        { login: 'c' }
      ])
    ).toEqual(['a'])
    expect(codeownersHandles('# owners\n* @titan-ron\n/docs/ @someone @org/team @titan-ron # trailing\n')).toEqual([
      'titan-ron',
      'someone'
    ])
  })
})

describe('summarizeFeedback', () => {
  it('counts only people outside the team and never bots', () => {
    const at = (days: number): string => new Date(NOW - days * DAY).toISOString()
    const f = summarizeFeedback(
      {
        contributions: [
          { kind: 'issue', author: 'Outsider', bot: false, createdAt: at(40), url: 'i1', title: 'Old' },
          { kind: 'issue-comment', author: 'outsider', bot: false, createdAt: at(2), url: 'c1', title: null },
          { kind: 'discussion', author: 'fan', bot: false, createdAt: at(1), url: 'd1', title: 'Idea' },
          { kind: 'pr', author: 'fan', bot: false, createdAt: at(1), url: 'p1', title: 'Fix' },
          { kind: 'issue', author: 'Titan-Ron', bot: false, createdAt: at(1), url: 'i2', title: 'Ours' },
          { kind: 'issue-comment', author: 'github-code-quality[bot]', bot: true, createdAt: at(1), url: 'c2', title: null }
        ],
        maintainers: ['titan-ron'],
        maintainersFrom: 'collaborators',
        discussionsUnavailable: null,
        truncated: false
      },
      NOW
    )
    expect(f.total).toBe(3)
    expect(f.recent).toBe(2)
    expect(f.counts).toEqual({ issue: 1, 'issue-comment': 1, discussion: 1, 'discussion-comment': 0, pr: 1, 'pr-comment': 0 })
    expect(f.newest.map((n) => n.url)).toEqual(['d1', 'c1', 'i1'])
  })
})

describe('history', () => {
  it('refuses a file it cannot own and drops rows it cannot read', () => {
    expect(() => parseHistory([])).toThrow(/not a JSON object/)
    expect(() => parseHistory({ ...emptyHistory(), version: 2 })).toThrow(/version 2/)
    expect(() => parseHistory({ ...emptyHistory(), repo: 'someone/else' })).toThrow(/someone\/else/)
    const h = parseHistory({
      version: 1,
      repo: REPO,
      views: [{ date: '2026-09-20', count: 3, uniques: 1 }, { date: 'bad' }],
      clones: 'nope',
      snapshots: [{ at: '2026-09-20T00:00:00Z', stars: 1, releases: { 'v0.1.0': [1, 2, 3] } }, { at: 'never' }]
    })
    expect(h.views).toEqual([{ date: '2026-09-20', count: 3, uniques: 1 }])
    expect(h.clones).toEqual([])
    expect(h.snapshots).toEqual([snapshot('2026-09-20T00:00:00Z', { 'v0.1.0': [1, 2, 3] }, 1)])
  })

  it('merges traffic per day, keeping the most seen for each field', () => {
    expect(
      mergeDays(
        [
          { date: '2026-09-02', count: 5, uniques: 1 },
          { date: '2026-09-01', count: 2, uniques: 2 }
        ],
        [
          { date: '2026-09-02', count: 3, uniques: 4 },
          { date: '2026-09-03', count: 1, uniques: 1 }
        ]
      )
    ).toEqual([
      { date: '2026-09-01', count: 2, uniques: 2 },
      { date: '2026-09-02', count: 5, uniques: 4 },
      { date: '2026-09-03', count: 1, uniques: 1 }
    ])
  })

  it('keeps one snapshot per UTC day, so running twice merges instead of repeating', () => {
    const traffic: Traffic = {
      ok: true,
      views: { count: 3, uniques: 1, days: [{ date: '2026-09-23', count: 3, uniques: 1 }] },
      clones: { count: 0, uniques: 0, days: [] },
      referrers: [{ name: 'github.com', count: 1, uniques: 1 }],
      paths: []
    }
    const releases = parseReleases([release('v0.1.0', '2026-09-15T10:00:00Z', { feed: 1 })])
    const repo = { stars: 1, forks: 0, watchers: 0 }
    const yesterday = mergeHistory(emptyHistory(), takeSnapshot({ at: '2026-09-23T09:00:00Z', repo, releases, traffic }), traffic)
    const first = mergeHistory(yesterday, takeSnapshot({ at: '2026-09-24T09:00:00Z', repo, releases, traffic }), traffic)
    const second = mergeHistory(first, takeSnapshot({ at: '2026-09-24T10:00:00Z', repo, releases, traffic }), traffic)
    expect(second.snapshots.map((s) => s.at)).toEqual(['2026-09-23T09:00:00Z', '2026-09-24T10:00:00Z'])
    expect(second.views).toEqual(first.views)
    expect(second.snapshots[1]!.referrers).toEqual(traffic.referrers)
    // a run without traffic leaves the merged days alone
    expect(mergeHistory(second, second.snapshots[1]!, noTraffic).views).toEqual(second.views)
  })

  it('takes deltas from a snapshot at least a day old, as close to a week old as there is', () => {
    const at = (days: number): string => new Date(NOW - days * DAY).toISOString()
    const snaps = [snapshot(at(12), {}), snapshot(at(8), {}), snapshot(at(5), {}), snapshot(at(0.5), {})]
    expect(baselineSnapshot(snaps, NOW)?.at).toBe(at(8))
    expect(baselineSnapshot([snapshot(at(0.5), {})], NOW)).toBeNull()
  })
})

describe('estimates', () => {
  const releases: readonly Release[] = parseReleases([
    release('v0.1.0', '2026-09-14T12:00:00Z', { dmg: 4, zip: 0, feed: 20 }),
    release('v0.2.0', '2026-09-20T12:00:00Z', { dmg: 2, zip: 6, feed: 24 })
  ])

  it('says when each release was the latest one', () => {
    expect(latestWindows(releases, NOW).map((w) => [w.tag, (w.end - w.start) / DAY])).toEqual([
      ['v0.1.0', 6],
      ['v0.2.0', 4]
    ])
  })

  it('spreads lifetime counts over the part of each window a range covers', () => {
    const windows = latestWindows(releases, NOW)
    // half of v0.1.0's window and half of v0.2.0's
    expect(spread(windows, { from: Date.parse('2026-09-17T12:00:00Z'), to: Date.parse('2026-09-22T12:00:00Z') })).toEqual({
      dmg: 3,
      zip: 3,
      feed: 22
    })
  })

  it('without history, reads the last week off the release windows', () => {
    const recent = recentDownloads(releases, emptyHistory(), NOW)
    expect(recent?.source).toBe('release windows')
    expect(recent?.days).toBe(7)
    // 3 of v0.1.0's 6 days, all 4 of v0.2.0's
    expect(recent?.feed).toBe(10 + 24)
  })

  it('with history, takes exact deltas, counting a release the baseline never saw in full', () => {
    const history: History = {
      ...emptyHistory(),
      snapshots: [snapshot(new Date(NOW - 7 * DAY).toISOString(), { 'v0.1.0': [3, 0, 15] })]
    }
    expect(recentDownloads(releases, history, NOW)).toEqual({
      dmg: 1 + 2,
      zip: 6,
      feed: 5 + 24,
      days: 7,
      since: new Date(NOW - 7 * DAY).toISOString(),
      source: 'history'
    })
  })

  it('buckets weeks by Monday, marks traffic the history only partly holds, and leaves pre-release weeks empty', () => {
    const history: History = {
      ...emptyHistory(),
      // Thursday the 10th to Wednesday the 23rd: GitHub has no row for today yet
      views: Array.from({ length: 14 }, (_, i) => ({ date: new Date(Date.parse('2026-09-10T00:00:00Z') + i * DAY).toISOString().slice(0, 10), count: 1, uniques: 1 }))
    }
    const weeks = weekly(releases, history, { now: NOW, weeks: 8 })
    expect(weeks.map((w) => [w.start, w.views?.count, w.views?.partial])).toEqual([
      ['2026-09-07', 4, true],
      ['2026-09-14', 7, false],
      ['2026-09-21', 3, false]
    ])
    expect(weeks[0]!.downloads).toBeNull()
    expect(weeks[0]!.active).toBeNull()
    // all of v0.1.0's window, and the half day of v0.2.0's four that falls before Monday the 21st
    expect(weeks[1]!.downloads?.feed).toBeCloseTo(20 + (24 * 0.5) / 4)
  })
})

describe('the report', () => {
  const feedback: FeedbackSummary = summarizeFeedback(
    { contributions: [], maintainers: ['titan-ron'], maintainersFrom: 'CODEOWNERS', discussionsUnavailable: 'HTTP 502', truncated: false },
    NOW
  )

  it('says why traffic is missing and still reports the rest', () => {
    const releases = parseReleases([release('v0.1.0', '2026-09-20T12:00:00Z', { dmg: 2, zip: 1, feed: 24 })])
    const text = formatReport(
      buildReport({
        now: NOW,
        historyPath: '~/history.json',
        history: emptyHistory(),
        repo: { stars: 2, forks: 0, watchers: 1 },
        releases,
        traffic: { ok: false, reason: 'Must have push access to repository (HTTP 403) — traffic needs push access to the repo' },
        feedback
      })
    )
    expect(text).toContain('unavailable: Must have push access')
    expect(text).toContain('team (CODEOWNERS (collaborators refused)): titan-ron')
    expect(text).toContain('discussions could not be read: HTTP 502')
    // 24 checks over 4 days = 6 a day → 1 copy never quit, 3 used for one session a day
    expect(text).toMatch(/active installs\s+≈ 1–3\s+6 update checks a day/)
    expect(text).toMatch(/v0\.1\.0\s+2026-09-20 12:00\s+4d \(now\)/)
    expect(text).toContain('mostly CI checkouts')
    expect(text).toContain('scripts/install.sh')
  })

  it('shows the change in stars against the history baseline', () => {
    const history: History = { ...emptyHistory(), snapshots: [snapshot(new Date(NOW - 7 * DAY).toISOString(), {}, 1)] }
    const report = buildReport({
      now: NOW,
      historyPath: 'h.json',
      history,
      repo: { stars: 3, forks: 0, watchers: 0 },
      releases: [],
      traffic: noTraffic,
      feedback
    })
    expect(formatReport(report)).toContain('stars 3 · forks 0 · watchers 0   since 2026-09-17: +2 · +0 · +0')
    expect(report.usage.active).toBeNull()
  })
})
