import { describe, it, expect } from 'vitest'
import {
  PR_LIST_FIELDS,
  mapReviewDecision,
  parsePrList,
  summarizeChecks,
  toPrStatus
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
      review: 'changes_requested'
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
      review: 'none'
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
