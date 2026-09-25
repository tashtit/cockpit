import { describe, expect, it } from 'vitest'
import { followUpRepo } from '../src/renderer/src/follow-up'
import type { RepoGroup } from '../src/shared/types'

const repo = (key: string, root: string | null): RepoGroup => ({
  key,
  name: key,
  fullName: null,
  root,
  sessionCount: 1,
  archivedCount: 0,
  lastActivity: 0,
  providers: ['claude'],
  hidden: false
})
const repos = [repo('/r/cockpit', '/r/cockpit'), repo('/r/cachely', '/r/cachely'), repo('general', null)]

describe('followUpRepo: where a suggested follow-up starts', () => {
  it('in the project its directory names, however deep inside', () => {
    expect(followUpRepo(repos, { cwd: '/r/cachely' }, { repoRoot: '/r/cockpit' })?.key).toBe('/r/cachely')
    expect(followUpRepo(repos, { cwd: '/r/cachely/projects/ui' }, null)?.key).toBe('/r/cachely')
    // a sibling that only shares a prefix is not inside
    expect(followUpRepo([repo('/r/c', '/r/c'), ...repos], { cwd: '/r/cockpit' }, null)?.key).toBe('/r/cockpit')
  })

  it('else in the session’s own repo', () => {
    expect(followUpRepo(repos, {}, { repoRoot: '/r/cockpit' })?.key).toBe('/r/cockpit')
  })

  it('never in the session’s repo when it named another project Cockpit doesn’t know', () => {
    expect(followUpRepo(repos, { cwd: '/elsewhere/x' }, { repoRoot: '/r/cockpit' })?.key).toBe('general')
    expect(followUpRepo(repos.slice(0, 2), { cwd: '/elsewhere/x' }, { repoRoot: '/r/cockpit' })).toBeNull()
  })

  it('in the no-repo bucket for a session outside any repository', () => {
    expect(followUpRepo(repos, {}, { repoRoot: null })?.key).toBe('general')
    expect(followUpRepo(repos, {}, null)?.key).toBe('general')
  })
})
