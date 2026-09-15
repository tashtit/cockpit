import { describe, expect, it } from 'vitest'
import { branchHint, taskTitle } from '../src/renderer/src/task-names'

describe('taskTitle', () => {
  it('reads the first line of the task', () => {
    expect(taskTitle('  Fix the login flake\n\nIt fails on CI one run in five.')).toBe('Fix the login flake')
  })

  it('caps a runaway first line with an ellipsis', () => {
    const t = taskTitle('x'.repeat(300))
    expect(t).toHaveLength(120)
    expect(t.endsWith('…')).toBe(true)
  })

  it('is empty for an images-only start, so callers fall back', () => {
    expect(taskTitle('   ')).toBe('')
  })
})

describe('branchHint', () => {
  it('keeps the meaningful words, drops filler and punctuation', () => {
    expect(branchHint('Add a CHANGELOG entry for the retry fix!')).toBe('add-changelog-entry-retry-fix')
  })

  it('stops after six words — main slugifies and caps the rest', () => {
    expect(branchHint('one two three four five six seven eight')).toBe('one-two-three-four-five-six')
  })

  it('reads only the first line', () => {
    expect(branchHint('Bump deps\nthen run the whole suite')).toBe('bump-deps')
  })

  it('yields nothing when no word survives, letting main name the branch', () => {
    expect(branchHint('')).toBeUndefined()
    expect(branchHint('¿¡ … !!')).toBeUndefined()
  })
})
