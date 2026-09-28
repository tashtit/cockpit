import { describe, expect, it } from 'vitest'
import {
  BRANCH_PREFIX_MAX,
  DEFAULT_BRANCH_PREFIX,
  branchPrefixClash,
  branchPrefixOf,
  branchPrefixParents,
  branchPrefixRefusal,
  normalizeBranchPrefix
} from '../src/shared/branch-prefix'

describe('normalizeBranchPrefix', () => {
  it('gives a bare name its slash, and leaves one that ends in a separator alone', () => {
    expect(normalizeBranchPrefix('titan')).toBe('titan/')
    expect(normalizeBranchPrefix('  users/titan  ')).toBe('users/titan/')
    expect(normalizeBranchPrefix('titan/')).toBe('titan/')
    expect(normalizeBranchPrefix('titan-')).toBe('titan-')
    expect(normalizeBranchPrefix('')).toBe('')
  })
})

describe('branchPrefixRefusal', () => {
  it('takes what team branch rules ask for', () => {
    for (const p of ['titan/', 'users/titan/', 'feat-', 'ron.t/', 'a1_b/', DEFAULT_BRANCH_PREFIX]) {
      expect(branchPrefixRefusal(p), p).toBeNull()
    }
    // empty is the default, not a mistake
    expect(branchPrefixRefusal('')).toBeNull()
  })

  it('refuses what a shell, a refspec or git itself would read specially', () => {
    expect(branchPrefixRefusal('my prefix/')).toMatch(/letters, digits/)
    expect(branchPrefixRefusal('a~b/')).toMatch(/letters, digits/)
    expect(branchPrefixRefusal('fix:/')).toMatch(/letters, digits/)
    expect(branchPrefixRefusal('--force/')).toMatch(/Start with a letter/)
    expect(branchPrefixRefusal('/titan/')).toMatch(/Start with a letter/)
    expect(branchPrefixRefusal('.titan/')).toMatch(/Start with a letter/)
    expect(branchPrefixRefusal('a//b/')).toMatch(/\/\//)
    expect(branchPrefixRefusal('a..b/')).toMatch(/\.\./)
    expect(branchPrefixRefusal('a/.b/')).toMatch(/starts with \./)
    expect(branchPrefixRefusal('team.lock/')).toMatch(/\.lock/)
    expect(branchPrefixRefusal(`${'a'.repeat(BRANCH_PREFIX_MAX)}/`)).toMatch(/40 characters/)
  })

  it('refuses a ref’s full name, a ref namespace and a remote as the first part', () => {
    // all pass git check-ref-format, and each makes a branch git reads as something else
    for (const p of ['refs/heads/', 'refs/', 'heads/', 'remotes/origin/', 'tags/', 'Refs/heads/']) {
      expect(branchPrefixRefusal(p), p).toMatch(/full name/)
    }
    for (const p of ['origin/', 'upstream/', 'Origin/', 'origin/titan/']) {
      expect(branchPrefixRefusal(p), p).toMatch(/names a remote/)
    }
    // only as a part of its own: a name that merely starts with one is fine
    for (const p of ['origins/', 'refsmith/', 'tagsy/', 'titan/origin/', 'origin-']) {
      expect(branchPrefixRefusal(p), p).toBeNull()
    }
  })
})

describe('branchPrefixParents', () => {
  it('names each branch the prefix would put new branches inside', () => {
    expect(branchPrefixParents('main/')).toEqual(['main'])
    expect(branchPrefixParents('users/titan/')).toEqual(['users', 'users/titan'])
    // what follows the last slash starts the new branch's own name
    expect(branchPrefixParents('users/titan-')).toEqual(['users'])
    expect(branchPrefixParents('feat-')).toEqual([])
    expect(branchPrefixParents('')).toEqual([])
  })

  it('says which repository and which branch are in the way', () => {
    expect(branchPrefixClash('main/', 'main', 'rocket')).toMatch(/^main\/ can't be used in rocket: it has a branch named main/)
  })
})

describe('branchPrefixOf', () => {
  it('is the saved prefix, or the default for nothing saved or something no longer valid', () => {
    expect(branchPrefixOf('titan/')).toBe('titan/')
    expect(branchPrefixOf('titan')).toBe('titan/')
    expect(branchPrefixOf(undefined)).toBe(DEFAULT_BRANCH_PREFIX)
    expect(branchPrefixOf('')).toBe(DEFAULT_BRANCH_PREFIX)
    expect(branchPrefixOf(42)).toBe(DEFAULT_BRANCH_PREFIX)
    expect(branchPrefixOf('--upload-pack=x/')).toBe(DEFAULT_BRANCH_PREFIX)
  })
})
