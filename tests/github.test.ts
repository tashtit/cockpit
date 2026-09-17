import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPrs } from '../src/main/github'

/**
 * The IO half against a stand-in `gh`: a shell script first on PATH that logs
 * its argv and answers from fixture files. The real module builds the argv,
 * runs the process and merges the two answers — only the network is replaced.
 * getPrs caches per repo root for 60s, so every test asks from a root of its own.
 */

const root = mkdtempSync(join(realpathSync(tmpdir()), 'cockpit-github-fixtures-'))
const bin = join(root, 'bin')
const data = join(root, 'data')
const calls = join(data, 'calls.log')
const savedPath = process.env.PATH

const FAKE_GH = `#!/bin/sh
printf '%s\\n' "$*" >> "${calls}"
case "$1 $2" in
  "pr list")
    [ -f "${data}/list.json" ] && cat "${data}/list.json"
    exit "$(cat "${data}/list.exit" 2>/dev/null || echo 0)" ;;
  "api graphql")
    [ -f "${data}/threads.json" ] && cat "${data}/threads.json"
    exit "$(cat "${data}/threads.exit" 2>/dev/null || echo 0)" ;;
esac
exit 1
`

const LIST = [
  { number: 57, title: 'Fix login retry flake', state: 'OPEN', isDraft: false, headRefName: 'cockpit/login-retry-flake', url: 'https://github.com/acme/rocket/pull/57', reviewDecision: 'CHANGES_REQUESTED', statusCheckRollup: [] },
  { number: 58, title: 'WIP dark mode tokens', state: 'OPEN', isDraft: true, headRefName: 'cockpit/dark-mode-tokens', url: 'https://github.com/acme/rocket/pull/58', reviewDecision: '', statusCheckRollup: [] },
  { number: 55, title: 'Paginate the sessions list', state: 'MERGED', isDraft: false, headRefName: 'cockpit/paginate-sessions-list', url: 'https://github.com/acme/rocket/pull/55', reviewDecision: 'APPROVED', statusCheckRollup: [] }
]

const THREADS = {
  data: {
    repository: {
      pullRequests: {
        nodes: [
          { number: 58, reviewThreads: { nodes: [] } },
          { number: 57, reviewThreads: { nodes: [{ isResolved: false }, { isResolved: true }, { isResolved: false }] } }
        ]
      }
    }
  }
}

function fixture(name: string, body: string): void {
  writeFileSync(join(data, name), body)
}

/** Each call's first argv line — the GraphQL query itself spans several. */
function ghCalls(): string[] {
  return existsSync(calls)
    ? readFileSync(calls, 'utf8')
        .split('\n')
        .filter((l) => /^(pr|api) /.test(l))
    : []
}

let n = 0
/** A fresh repo root, so the 60s cache never answers for a previous test. */
function repo(): string {
  const dir = join(root, `repo-${++n}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

beforeAll(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'gh'), FAKE_GH)
  chmodSync(join(bin, 'gh'), 0o755)
  process.env.PATH = `${bin}:${savedPath}`
})

afterAll(() => {
  process.env.PATH = savedPath
  rmSync(root, { recursive: true, force: true })
})

beforeEach(() => {
  rmSync(data, { recursive: true, force: true })
  mkdirSync(data, { recursive: true })
  fixture('list.json', JSON.stringify(LIST))
  fixture('threads.json', JSON.stringify(THREADS))
})

describe('getPrs', () => {
  it('folds the unresolved-thread counts into the open PRs', async () => {
    const prs = await getPrs(repo())
    expect(prs.map((p) => [p.number, p.state, p.unresolvedThreads])).toEqual([
      [57, 'OPEN', 2],
      [58, 'OPEN', 0],
      [55, 'MERGED', 0]
    ])
    expect(prs[0]).toMatchObject({ review: 'changes_requested', isDraft: false })
    const argv = ghCalls()
    expect(argv[0]).toMatch(/^pr list --state all --limit 100 --json /)
    // gh resolves the placeholders from the checkout — Cockpit never guesses owner/repo
    expect(argv[1]).toMatch(/^api graphql -F owner=\{owner\} -F name=\{repo\} -f query=query\(/)
    expect(argv).toHaveLength(2)
  })

  it('keeps every badge, at a count of 0, when the GraphQL call fails', async () => {
    fixture('threads.json', 'gh: HTTP 502: Bad Gateway')
    fixture('threads.exit', '1')
    const prs = await getPrs(repo())
    expect(prs.map((p) => [p.number, p.review, p.unresolvedThreads])).toEqual([
      [57, 'changes_requested', 0],
      [58, 'none', 0],
      [55, 'approved', 0]
    ])
  })

  it('still uses the counts GitHub returned beside a partial error', async () => {
    // gh exits non-zero whenever the payload carries errors, even with data in it
    fixture('threads.json', JSON.stringify({ ...THREADS, errors: [{ message: 'something was rate limited' }] }))
    fixture('threads.exit', '1')
    expect((await getPrs(repo()))[0].unresolvedThreads).toBe(2)
  })

  it('does not ask GitHub about threads when no PR is open', async () => {
    fixture('list.json', JSON.stringify(LIST.filter((p) => p.state !== 'OPEN')))
    const prs = await getPrs(repo())
    expect(prs.map((p) => p.number)).toEqual([55])
    expect(ghCalls().filter((a) => a.startsWith('api graphql'))).toEqual([])
  })

  it('fails soft to no PRs, and no second call, when the list itself fails', async () => {
    rmSync(join(data, 'list.json'))
    fixture('list.exit', '4')
    expect(await getPrs(repo())).toEqual([])
    expect(ghCalls()).toHaveLength(1)
  })

  it('serves both answers from one cache entry for a minute', async () => {
    const dir = repo()
    await getPrs(dir)
    expect((await getPrs(dir))[0].unresolvedThreads).toBe(2)
    expect(ghCalls()).toHaveLength(2)
  })
})
