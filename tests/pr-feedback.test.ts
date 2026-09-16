import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asPrNumber, clearPrFeedbackCache, getPrFeedback, getPrFixBriefing } from '../src/main/pr-feedback'

/**
 * The IO half against a stand-in `gh`: a shell script first on PATH that logs
 * its argv and answers from fixture files. The real module builds the argv,
 * runs the process and reads its output — only the network is replaced.
 */

const root = mkdtempSync(join(realpathSync(tmpdir()), 'cockpit-pr-feedback-fixtures-'))
const bin = join(root, 'bin')
const data = join(root, 'data')
const repo = join(root, 'repo')
const calls = join(data, 'calls.log')
const savedPath = process.env.PATH

const FAKE_GH = `#!/bin/sh
printf '%s\\n' "$*" >> "${calls}"
case "$1 $2" in
  "pr checks")
    [ -f "${data}/checks.err" ] && cat "${data}/checks.err" >&2
    [ -f "${data}/checks.json" ] && cat "${data}/checks.json"
    exit "$(cat "${data}/checks.exit" 2>/dev/null || echo 0)" ;;
  "api graphql")
    cat "${data}/review.json"
    exit "$(cat "${data}/review.exit" 2>/dev/null || echo 0)" ;;
  "run view")
    f="${data}/job-$4.log"
    if [ -f "$f" ]; then cat "$f"; else echo "log not found" >&2; exit 1; fi ;;
esac
`

const REVIEW = {
  data: {
    repository: {
      pullRequest: {
        number: 42,
        title: 'Fix the login flake',
        url: 'https://github.com/acme/rocket/pull/42',
        headRefName: 'cockpit/login-flake',
        baseRefName: 'main',
        mergeable: 'MERGEABLE',
        latestReviews: { nodes: [] },
        reviewThreads: {
          nodes: [
            {
              isResolved: false,
              isOutdated: false,
              path: 'src/login.ts',
              line: 3,
              diffSide: 'RIGHT',
              comments: { totalCount: 1, nodes: [{ body: 'cap the retries', url: 'https://github.com/acme/rocket/pull/42#c1', author: { login: 'mona' } }] }
            }
          ]
        }
      }
    }
  }
}

const job = (id: number): string => `https://github.com/acme/rocket/actions/runs/9/job/${id}`
const CHECKS = [
  { name: 'lint', bucket: 'fail', state: 'FAILURE', link: job(1), workflow: 'CI' },
  { name: 'unit', bucket: 'fail', state: 'FAILURE', link: job(2), workflow: 'CI' },
  { name: 'external', bucket: 'fail', state: 'FAILURE', link: 'https://ci.example.com/build/7', workflow: '' },
  { name: 'docs', bucket: 'cancel', state: 'CANCELLED', link: job(3), workflow: 'CI' },
  { name: 'build', bucket: 'pass', state: 'SUCCESS', link: job(4), workflow: 'CI' }
]

function fixture(name: string, body: string): void {
  writeFileSync(join(data, name), body)
}

function ghCalls(): string[] {
  return existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) : []
}

beforeAll(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(bin, { recursive: true })
  mkdirSync(repo, { recursive: true })
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
  fixture('review.json', JSON.stringify(REVIEW))
  fixture('checks.json', JSON.stringify(CHECKS))
  clearPrFeedbackCache()
})

describe('getPrFeedback', () => {
  it('asks gh for the checks and the review state of that PR, in the repo', async () => {
    const fb = await getPrFeedback(repo, 42)
    expect(fb.number).toBe(42)
    expect(fb.checks.map((c) => c.name)).toEqual(['lint', 'unit', 'external', 'docs', 'build'])
    expect(fb.threads.map((t) => t.path)).toEqual(['src/login.ts'])
    expect(fb.warnings).toEqual([])
    const argv = ghCalls()
    expect(argv).toContain('pr checks 42 --json name,bucket,state,link,workflow')
    // gh resolves the placeholders from the checkout — Cockpit never guesses owner/repo
    expect(argv.find((a) => a.startsWith('api graphql'))).toMatch(
      /^api graphql -F owner=\{owner\} -F name=\{repo\} -F number=42 -f query=query\(/
    )
  })

  it('reads checks even when gh exits non-zero for pending or failing ones', async () => {
    fixture('checks.exit', '8')
    expect((await getPrFeedback(repo, 42)).checks).toHaveLength(5)
  })

  it('treats a branch with no checks as an empty list, and anything else as a warning', async () => {
    rmSync(join(data, 'checks.json'))
    fixture('checks.err', "no checks reported on the 'cockpit/login-flake' branch\n")
    fixture('checks.exit', '1')
    const quiet = await getPrFeedback(repo, 42)
    expect(quiet.checks).toEqual([])
    expect(quiet.warnings).toEqual([])

    fixture('checks.err', 'HTTP 502: Bad Gateway\n')
    const loud = await getPrFeedback(repo, 42)
    expect(loud.checks).toEqual([])
    expect(loud.warnings).toEqual(['Checks unavailable — HTTP 502: Bad Gateway'])
  })

  it('throws GitHub’s own words when the PR cannot be read', async () => {
    fixture(
      'review.json',
      JSON.stringify({ data: { repository: { pullRequest: null } }, errors: [{ message: 'Could not resolve to a PullRequest with the number of 42.' }] })
    )
    fixture('review.exit', '1')
    await expect(getPrFeedback(repo, 42)).rejects.toThrow(
      "Couldn't read PR #42 from GitHub — Could not resolve to a PullRequest with the number of 42."
    )
  })
})

describe('getPrFixBriefing', () => {
  const LOG = [
    'lint\tUNKNOWN STEP\t2026-09-09T13:54:09.1Z ##[endgroup]',
    'lint\tUNKNOWN STEP\t2026-09-09T13:54:09.2Z src/login.ts:3 Missing semicolon',
    'lint\tUNKNOWN STEP\t2026-09-09T13:54:09.3Z ##[error]Process completed with exit code 1.',
    'lint\tUNKNOWN STEP\t2026-09-09T13:54:09.4Z Cleaning up orphan processes'
  ].join('\n')

  it('quotes the failed step of each failing Actions job, and says which log it could not read', async () => {
    fixture('job-1.log', LOG)
    const { briefing, warnings } = await getPrFixBriefing(repo, 42)
    expect(briefing).toContain('### lint (CI) — failed')
    expect(briefing).toContain('src/login.ts:3 Missing semicolon\nError: Process completed with exit code 1.')
    expect(briefing).not.toContain('Cleaning up orphan processes')
    expect(briefing).toContain('1. src/login.ts line 3')
    expect(warnings).toEqual(["Couldn't read the failed-step log for unit — the prompt links to it instead."])
    // logs only for failing Actions jobs: not the external CI, not the cancelled or passing runs
    const views = ghCalls().filter((a) => a.startsWith('run view'))
    expect(views.sort()).toEqual(['run view --job 1 --log-failed', 'run view --job 2 --log-failed'])
  })

  it('keeps a read excerpt for the session and retries an unread one', async () => {
    fixture('job-1.log', LOG)
    await getPrFixBriefing(repo, 42)
    fixture('job-2.log', LOG)
    await getPrFixBriefing(repo, 42)
    const views = ghCalls().filter((a) => a.startsWith('run view'))
    expect(views.filter((a) => a.includes('--job 1 '))).toHaveLength(1)
    expect(views.filter((a) => a.includes('--job 2 '))).toHaveLength(2)
  })

  it('fetches logs for at most four jobs', async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ name: `job${i}`, bucket: 'fail', state: 'FAILURE', link: job(100 + i), workflow: 'CI' }))
    fixture('checks.json', JSON.stringify(many))
    await getPrFixBriefing(repo, 42)
    expect(ghCalls().filter((a) => a.startsWith('run view'))).toHaveLength(4)
  })
})

describe('asPrNumber', () => {
  it('accepts positive integers only — renderer input lands on gh’s argv', () => {
    expect(asPrNumber(42)).toBe(42)
    for (const bad of [0, -1, 1.5, '42', '42; rm -rf /', null, undefined, Number.NaN, 1e12]) {
      expect(() => asPrNumber(bad)).toThrow('invalid pull request number')
    }
  })
})
