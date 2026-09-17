import { describe, expect, it } from 'vitest'
import { nextVersion, parseLog, tagVersion } from '../scripts/next-version-core.mts'

describe('parseLog', () => {
  it('splits `git log --format=%H%x1f%B%x1e` output into commits with full messages', () => {
    const raw =
      'aaafeat(indexer): a thing\n\nbody line\n\nBREAKING CHANGE: gone\n\n' +
      'bbbdocs: words\n\n'
    expect(parseLog(raw)).toEqual([
      { hash: 'aaa', message: 'feat(indexer): a thing\n\nbody line\n\nBREAKING CHANGE: gone' },
      { hash: 'bbb', message: 'docs: words' }
    ])
  })

  it('returns nothing for an empty range', () => {
    expect(parseLog('')).toEqual([])
  })
})

describe('tagVersion', () => {
  it('reads plain release tags only', () => {
    expect(tagVersion('v0.9.0')).toBe('0.9.0')
    expect(tagVersion('v1.0.0-beta.1')).toBeNull()
    expect(tagVersion('0.9.0')).toBeNull()
  })
})

describe('nextVersion', () => {
  it('bumps like semantic-release, including a major below 1.0.0', () => {
    expect(nextVersion('0.9.0', 'patch')).toBe('0.9.1')
    expect(nextVersion('0.9.3', 'minor')).toBe('0.10.0')
    expect(nextVersion('0.9.3', 'major')).toBe('1.0.0')
  })

  it('is null when no release is due', () => {
    expect(nextVersion('0.9.0', null)).toBeNull()
  })
})
