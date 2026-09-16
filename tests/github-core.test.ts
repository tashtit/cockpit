import { describe, it, expect } from 'vitest'
import {
  OPEN_THREADS_QUERY,
  PR_LIST_FIELDS,
  mapReviewDecision,
  parsePrList,
  parseUnresolvedThreads,
  summarizeChecks,
  toPrStatus,
  withUnresolvedThreads
} from '../src/main/github-core'

/** A Checks-API run as gh prints it (Actions jobs, CodeQL, …). */
const run = (conclusion: string | null, status = 'COMPLETED') => ({
  __typename: 'CheckRun',
  name: 'ci',
  status,
  conclusion
})
/** A legacy commit status (external CI posting to the statuses API). */
const ctx = (state: string) => ({ __typename: 'StatusContext', context: 'ci/legacy', state })

describe('summarizeChecks', () => {
  it('reads a missing, empty or unreadable rollup as no checks at all', () => {
    expect(summarizeChecks(undefined)).toBe('none')
    expect(summarizeChecks(null)).toBe('none')
    expect(summarizeChecks([])).toBe('none')
    expect(summarizeChecks('SUCCESS')).toBe('none')
    expect(summarizeChecks([null, 'SUCCESS', 7])).toBe('none')
  })

  it('passes when every run succeeded, was skipped, or came back neutral', () => {
    expect(summarizeChecks([run('SUCCESS')])).toBe('passing')
    expect(summarizeChecks([run('SUCCESS'), run('SKIPPED'), run('NEUTRAL')])).toBe('passing')
    // the real shape of a green cockpit PR: CI + package + a skipped release job
    expect(summarizeChecks([run('SUCCESS'), run('SUCCESS'), run('SKIPPED')])).toBe('passing')
  })

  it('fails when any run failed, whatever the others did', () => {
    for (const bad of ['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'CANCELLED']) {
      expect(summarizeChecks([run('SUCCESS'), run(bad), run(null, 'IN_PROGRESS')]), bad).toBe(
        'failing'
      )
    }
  })

  it('is pending while a run has not completed and nothing has failed yet', () => {
    expect(summarizeChecks([run(null, 'QUEUED')])).toBe('pending')
    expect(summarizeChecks([run('SUCCESS'), run(null, 'IN_PROGRESS')])).toBe('pending')
    // a stale conclusion on a run still marked in progress is not a verdict
    expect(summarizeChecks([run('SUCCESS', 'IN_PROGRESS')])).toBe('pending')
  })

  it('reads legacy commit statuses with the same rules', () => {
    expect(summarizeChecks([ctx('SUCCESS')])).toBe('passing')
    expect(summarizeChecks([ctx('SUCCESS'), ctx('PENDING')])).toBe('pending')
    expect(summarizeChecks([ctx('SUCCESS'), ctx('EXPECTED')])).toBe('pending')
    expect(summarizeChecks([ctx('SUCCESS'), ctx('FAILURE')])).toBe('failing')
    expect(summarizeChecks([ctx('ERROR'), run('SUCCESS')])).toBe('failing')
    expect(summarizeChecks([ctx('SUCCESS'), run('SUCCESS')])).toBe('passing')
  })

  it('treats a conclusion it does not know as pending, never as passing', () => {
    expect(summarizeChecks([run('SUCCESS'), run('STALE')])).toBe('pending')
    expect(summarizeChecks([run('SUCCESS'), run('SOMETHING_NEW')])).toBe('pending')
    // …but a known failure still outranks it
    expect(summarizeChecks([run('SOMETHING_NEW'), run('FAILURE')])).toBe('failing')
  })

  it('skips malformed entries without losing the readable ones', () => {
    expect(summarizeChecks([null, run('SUCCESS'), 'junk'])).toBe('passing')
    expect(summarizeChecks([{}, run('SUCCESS')])).toBe('pending')
  })
})

describe('mapReviewDecision', () => {
  it('maps the three GitHub decisions', () => {
    expect(mapReviewDecision('APPROVED')).toBe('approved')
    expect(mapReviewDecision('CHANGES_REQUESTED')).toBe('changes_requested')
    expect(mapReviewDecision('REVIEW_REQUIRED')).toBe('review_required')
  })

  it('reads anything else as none — gh prints "" when no review is required', () => {
    expect(mapReviewDecision('')).toBe('none')
    expect(mapReviewDecision(null)).toBe('none')
    expect(mapReviewDecision(undefined)).toBe('none')
    expect(mapReviewDecision('DISMISSED')).toBe('none')
    expect(mapReviewDecision(42)).toBe('none')
  })
})

describe('toPrStatus', () => {
  const row = {
    number: 42,
    title: 'Fix the login flake',
    state: 'OPEN',
    isDraft: false,
    headRefName: 'cockpit/login-flake',
    url: 'https://github.com/acme/rocket/pull/42',
    statusCheckRollup: [run('SUCCESS'), run('FAILURE')],
    reviewDecision: 'CHANGES_REQUESTED'
  }

  it('shapes a gh row into a PrStatus with the summaries folded in', () => {
    expect(toPrStatus(row)).toEqual({
      number: 42,
      title: 'Fix the login flake',
      state: 'OPEN',
      isDraft: false,
      headRefName: 'cockpit/login-flake',
      url: 'https://github.com/acme/rocket/pull/42',
      checks: 'failing',
      review: 'changes_requested',
      unresolvedThreads: 0
    })
  })

  it('keeps the old shape meaningful when the new fields are missing', () => {
    const { statusCheckRollup: _r, reviewDecision: _d, ...bare } = row
    expect(toPrStatus(bare)).toMatchObject({ number: 42, checks: 'none', review: 'none' })
  })

  it('drops rows without a number or a known state', () => {
    expect(toPrStatus({ ...row, number: '42' })).toBeNull()
    expect(toPrStatus({ ...row, state: 'WEIRD' })).toBeNull()
    expect(toPrStatus(null)).toBeNull()
    expect(toPrStatus('pr')).toBeNull()
  })

  it('defaults the string fields rather than propagating junk', () => {
    expect(toPrStatus({ number: 1, state: 'MERGED', title: 7, isDraft: 'yes' })).toEqual({
      number: 1,
      title: '',
      state: 'MERGED',
      isDraft: false,
      headRefName: '',
      url: '',
      checks: 'none',
      review: 'none',
      unresolvedThreads: 0
    })
  })
})

describe('parsePrList', () => {
  it('parses a gh array and drops unusable rows', () => {
    const out = parsePrList(
      JSON.stringify([
        { number: 1, state: 'OPEN', statusCheckRollup: [run(null, 'QUEUED')] },
        { number: 'x', state: 'OPEN' },
        { number: 2, state: 'CLOSED', reviewDecision: 'APPROVED' }
      ])
    )
    expect(out.map((p) => [p.number, p.checks, p.review])).toEqual([
      [1, 'pending', 'none'],
      [2, 'none', 'approved']
    ])
  })

  it('fails soft on anything that is not a JSON array', () => {
    expect(parsePrList('')).toEqual([])
    expect(parsePrList('gh: To get started with GitHub CLI, please run: gh auth login')).toEqual([])
    expect(parsePrList('{"number":1}')).toEqual([])
  })

  it('asks gh for the two fields the summaries read', () => {
    const fields = PR_LIST_FIELDS.split(',')
    expect(fields).toContain('statusCheckRollup')
    expect(fields).toContain('reviewDecision')
    expect(new Set(fields).size).toBe(fields.length)
  })
})

/** A review thread as the counts query asks for it: nothing but whether it was resolved. */
const thread = (isResolved: unknown) => ({ isResolved })
/** `gh api graphql` stdout for OPEN_THREADS_QUERY, in the shape GitHub returns it. */
const threadsResponse = (prs: unknown[]) =>
  JSON.stringify({ data: { repository: { pullRequests: { nodes: prs } } } })

describe('parseUnresolvedThreads', () => {
  it('counts the unresolved threads of each open PR', () => {
    const counts = parseUnresolvedThreads(
      threadsResponse([
        { number: 57, reviewThreads: { nodes: [thread(false), thread(true), thread(false)] } },
        { number: 58, reviewThreads: { nodes: [thread(false)] } }
      ])
    )
    expect([...counts]).toEqual([
      [57, 2],
      [58, 1]
    ])
  })

  it('leaves out PRs with nothing waiting — every thread resolved, or none at all', () => {
    // captured from a repository whose open PRs carry no review threads
    const counts = parseUnresolvedThreads(
      threadsResponse([
        { number: 104, reviewThreads: { nodes: [] } },
        { number: 102, reviewThreads: { nodes: [thread(true), thread(true)] } }
      ])
    )
    expect(counts.size).toBe(0)
    expect(parseUnresolvedThreads('{"data":{"repository":{"pullRequests":{"nodes":[]}}}}').size).toBe(0)
  })

  it('counts only an explicit isResolved: false — an unreadable thread is not a waiting reviewer', () => {
    const counts = parseUnresolvedThreads(
      threadsResponse([
        {
          number: 7,
          reviewThreads: { nodes: [thread(false), thread(null), thread('false'), {}, null, 'junk', thread(false)] }
        }
      ])
    )
    expect(counts.get(7)).toBe(2)
  })

  it('skips PR nodes it cannot read without losing the readable ones', () => {
    const counts = parseUnresolvedThreads(
      threadsResponse([
        null,
        { number: '9', reviewThreads: { nodes: [thread(false)] } },
        { reviewThreads: { nodes: [thread(false)] } },
        { number: 10, reviewThreads: null },
        { number: 11, reviewThreads: { nodes: 'nope' } },
        { number: 12, reviewThreads: { nodes: [thread(false)] } }
      ])
    )
    expect([...counts]).toEqual([[12, 1]])
  })

  it('fails soft to no counts on anything that is not a readable response', () => {
    expect(parseUnresolvedThreads('').size).toBe(0)
    expect(parseUnresolvedThreads('gh: To get started with GitHub CLI, please run: gh auth login').size).toBe(0)
    expect(parseUnresolvedThreads('[]').size).toBe(0)
    expect(parseUnresolvedThreads('{"data":null}').size).toBe(0)
    // what gh prints when the checkout's remote isn't a repository it can see
    const notFound = JSON.stringify({
      data: { repository: null },
      errors: [{ type: 'NOT_FOUND', path: ['repository'], message: "Could not resolve to a Repository with the name 'acme/gone'." }]
    })
    expect(parseUnresolvedThreads(notFound).size).toBe(0)
  })
})

describe('withUnresolvedThreads', () => {
  const pr = (number: number, state: string) =>
    toPrStatus({ number, state, title: `PR ${number}` }) as NonNullable<ReturnType<typeof toPrStatus>>

  it('puts each count on its open PR and zero on the rest', () => {
    const prs = [pr(1, 'OPEN'), pr(2, 'OPEN'), pr(3, 'OPEN')]
    const out = withUnresolvedThreads(prs, new Map([[1, 3], [3, 1]]))
    expect(out.map((p) => [p.number, p.unresolvedThreads])).toEqual([
      [1, 3],
      [2, 0],
      [3, 1]
    ])
    // untouched rows are passed through, not copied
    expect(out[1]).toBe(prs[1])
  })

  it('never counts on a merged or closed PR, whatever the map says', () => {
    const out = withUnresolvedThreads([pr(4, 'MERGED'), pr(5, 'CLOSED')], new Map([[4, 2], [5, 6]]))
    expect(out.map((p) => p.unresolvedThreads)).toEqual([0, 0])
  })

  it('leaves the list as it was when the counts call failed', () => {
    const prs = parsePrList(
      JSON.stringify([
        { number: 1, state: 'OPEN', statusCheckRollup: [run('FAILURE')], reviewDecision: 'CHANGES_REQUESTED' },
        { number: 2, state: 'MERGED' }
      ])
    )
    const out = withUnresolvedThreads(prs, parseUnresolvedThreads(''))
    expect(out).toEqual(prs)
    // the badge still has everything else it shows
    expect(out[0]).toMatchObject({ checks: 'failing', review: 'changes_requested', unresolvedThreads: 0 })
  })
})

describe('OPEN_THREADS_QUERY', () => {
  it('asks for open PRs newest first, as gh pr list orders them, with each thread\'s resolution', () => {
    const q = OPEN_THREADS_QUERY.replace(/\s+/g, ' ')
    expect(q).toContain('pullRequests(states: OPEN')
    expect(q).toContain('orderBy: { field: CREATED_AT, direction: DESC }')
    expect(q).toMatch(/reviewThreads\(first: \d+\) \{ nodes \{ isResolved \} \}/)
    // gh fills these from the checkout: -F owner={owner} -F name={repo}
    expect(q).toContain('$owner: String!')
    expect(q).toContain('$name: String!')
  })
})
