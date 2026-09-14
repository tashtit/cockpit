import { describe, it, expect } from 'vitest'
import {
  diffLines,
  diffStat,
  foldUnchanged,
  splitLines,
  type DiffLine
} from '../src/shared/line-diff'

/* A diff is only right if both sides read back out of it. */
const left = (d: readonly DiffLine[]): string[] => d.filter((l) => l.op !== 'add').map((l) => l.text)
const right = (d: readonly DiffLine[]): string[] => d.filter((l) => l.op !== 'del').map((l) => l.text)
const ops = (d: readonly DiffLine[]): string => d.map((l) => l.op[0]).join('')

function roundTrip(a: string[], b: string[]): DiffLine[] {
  const d = diffLines(a, b)
  expect(left(d)).toEqual(a)
  expect(right(d)).toEqual(b)
  return d
}

describe('diffLines', () => {
  it('reads identical input as context only', () => {
    expect(ops(roundTrip(['a', 'b'], ['a', 'b']))).toBe('ss')
  })

  it('finds one inserted line', () => {
    expect(ops(roundTrip(['a', 'c'], ['a', 'b', 'c']))).toBe('sas')
  })

  it('finds one removed line', () => {
    expect(ops(roundTrip(['a', 'b', 'c'], ['a', 'c']))).toBe('sds')
  })

  it('reads a changed line as its removal, then its replacement', () => {
    const d = roundTrip(['keep', 'old', 'keep too'], ['keep', 'new', 'keep too'])
    expect(ops(d)).toBe('sdas')
    expect(d[1]).toEqual({ op: 'del', text: 'old' })
    expect(d[2]).toEqual({ op: 'add', text: 'new' })
  })

  it('groups a changed stretch as removals then additions, never a zipper', () => {
    const d = roundTrip(['a', 'b', 'c', 'd'], ['a', 'x', 'y', 'z', 'd'])
    expect(ops(d)).toBe('sddaaas')
  })

  it('keeps a matching line inside a changed stretch as context, once', () => {
    // the match sits between two changes, so neither the head nor the tail peel it
    // off — this is the path a backtrack bug would double it on
    const d = roundTrip(['1', '2', '3', '4', '5'], ['1', 'x', '3', 'y', '5'])
    expect(ops(d)).toBe('sdasdas')
    expect(d.filter((l) => l.text === '3')).toHaveLength(1)
  })

  it('round-trips every small pair it is thrown', () => {
    // a seeded walk over short sequences on a tiny alphabet: many interior matches,
    // many ties — the shapes a hand-written case list never quite covers
    let seed = 7
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    for (let t = 0; t < 300; t++) {
      const a = Array.from({ length: rnd(8) }, () => 'abc'[rnd(3)])
      const b = Array.from({ length: rnd(8) }, () => 'abc'[rnd(3)])
      const d = roundTrip(a, b)
      // never worse than replacing everything
      const { added, removed } = diffStat(d)
      expect(added + removed).toBeLessThanOrEqual(a.length + b.length)
    }
  })

  it('handles an empty side', () => {
    expect(ops(roundTrip([], ['a', 'b']))).toBe('aa')
    expect(ops(roundTrip(['a', 'b'], []))).toBe('dd')
    expect(roundTrip([], [])).toEqual([])
  })

  it('keeps a long common head and tail as context around the change', () => {
    const head = Array.from({ length: 30 }, (_, i) => `h${i}`)
    const tail = Array.from({ length: 30 }, (_, i) => `t${i}`)
    const d = roundTrip([...head, 'mid', ...tail], [...head, 'MID', ...tail])
    expect(ops(d)).toBe(`${'s'.repeat(30)}da${'s'.repeat(30)}`)
  })

  it('still round-trips past the table cap, as a whole-block swap', () => {
    // 1100 × 1100 cells is past the LCS budget: everything out, everything in
    const a = Array.from({ length: 1100 }, (_, i) => `a${i}`)
    const b = Array.from({ length: 1100 }, (_, i) => `b${i}`)
    const d = roundTrip(a, b)
    expect(diffStat(d)).toEqual({ added: 1100, removed: 1100 })
    expect(d[0].op).toBe('del')
    expect(d[1100].op).toBe('add')
  })
})

describe('splitLines', () => {
  it('ignores the blank padding a trimmed write would drop', () => {
    expect(splitLines('\n\na\nb\n\n')).toEqual(['a', 'b'])
    expect(splitLines('   ')).toEqual([])
  })
})

describe('foldUnchanged', () => {
  const same = (n: number, tag: string): DiffLine[] =>
    Array.from({ length: n }, (_, i) => ({ op: 'same', text: `${tag}${i}` }))

  it('keeps two lines of context around a change and folds the quiet stretch', () => {
    const rows = foldUnchanged([...same(10, 'a'), { op: 'add', text: 'new' }, ...same(10, 'b')])
    expect(rows.map((r) => r.op)).toEqual(['fold', 'same', 'same', 'add', 'same', 'same', 'fold'])
    expect(rows[0].op === 'fold' && rows[0].lines.length).toBe(8)
    expect(rows[6].op === 'fold' && rows[6].lines.map((l) => l.text)).toEqual(
      same(10, 'b').slice(2).map((l) => l.text)
    )
  })

  it('shows a quiet stretch too short to be worth a fold row', () => {
    // a b [c d] e f: c and d are beyond context on both sides, but two lines is
    // not worth a "2 unchanged lines" row the reader has to click
    const rows = foldUnchanged([
      { op: 'del', text: 'x' },
      ...same(4, 's'),
      { op: 'add', text: 'y' }
    ])
    expect(rows.every((r) => r.op !== 'fold')).toBe(true)
    expect(rows).toHaveLength(6)
  })

  it('folds a diff with no changes at all into one row', () => {
    const rows = foldUnchanged(same(5, 'q'))
    expect(rows).toHaveLength(1)
    expect(rows[0].op).toBe('fold')
  })
})

describe('diffStat', () => {
  it('counts what goes in and what comes out', () => {
    expect(
      diffStat([
        { op: 'same', text: '' },
        { op: 'add', text: '' },
        { op: 'add', text: '' },
        { op: 'del', text: '' }
      ])
    ).toEqual({ added: 2, removed: 1 })
  })
})
