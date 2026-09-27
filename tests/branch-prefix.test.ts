import { describe, expect, it } from 'vitest'
import {
  BRANCH_PREFIX_MAX,
  DEFAULT_BRANCH_PREFIX,
  branchPrefixOf,
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
