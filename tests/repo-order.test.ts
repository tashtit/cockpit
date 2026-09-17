import { describe, it, expect } from 'vitest'
import { isAlphabetical, moveRepo, orderRepos } from '../src/shared/repo-order'

const g = (key: string, fullName: string | null, name = key) => ({ key, name, fullName })
const keys = (list: { key: string }[]): string[] => list.map((r) => r.key)

describe('orderRepos', () => {
  const repos = [
    g('general', null),
    g('gh:acme/zeta', 'acme/zeta'),
    g('/home/dev/Beta', null, 'Beta'),
    g('gh:acme/alpha', 'acme/alpha'),
    g('gh:acme/repo-10', 'acme/repo-10'),
    g('gh:acme/repo-9', 'acme/repo-9')
  ]

  it('lists projects A→Z by the name the tree shows, case-insensitively, general last', () => {
    expect(keys(orderRepos(repos, []))).toEqual([
      'gh:acme/alpha',
      'gh:acme/repo-9',
      'gh:acme/repo-10',
      'gh:acme/zeta',
      '/home/dev/Beta',
      'general'
    ])
  })

  it('puts the saved order first and anything unsaved after it, A→Z', () => {
    expect(keys(orderRepos(repos, ['gh:acme/zeta', 'gone:repo', '/home/dev/Beta']))).toEqual([
      'gh:acme/zeta',
      '/home/dev/Beta',
      'gh:acme/alpha',
      'gh:acme/repo-9',
      'gh:acme/repo-10',
      'general'
    ])
  })

  it('keeps general last even when a saved order names it', () => {
    expect(keys(orderRepos(repos, ['general', 'gh:acme/zeta'])).at(-1)).toBe('general')
  })
})

describe('moveRepo', () => {
  const order = ['a', 'b', 'c', 'd']

  it('moves a key before or after a target', () => {
    expect(moveRepo(order, 'd', { target: 'b', place: 'before' })).toEqual(['a', 'd', 'b', 'c'])
    expect(moveRepo(order, 'a', { target: 'c', place: 'after' })).toEqual(['b', 'c', 'a', 'd'])
    expect(moveRepo(order, 'a', { target: 'd', place: 'after' })).toEqual(['b', 'c', 'd', 'a'])
  })

  it('leaves the order alone for a self-drop or an unknown key', () => {
    expect(moveRepo(order, 'b', { target: 'b', place: 'after' })).toEqual(order)
    expect(moveRepo(order, 'x', { target: 'b', place: 'after' })).toEqual(order)
    expect(moveRepo(order, 'b', { target: 'x', place: 'after' })).toEqual(order)
  })
})

describe('isAlphabetical', () => {
  it('tells a dragged order from plain A→Z', () => {
    expect(isAlphabetical([g('a', 'acme/a'), g('b', 'acme/B')])).toBe(true)
    expect(isAlphabetical([g('b', 'acme/b'), g('a', 'acme/a')])).toBe(false)
  })
})
