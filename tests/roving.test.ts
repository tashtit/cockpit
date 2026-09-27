import { describe, it, expect } from 'vitest'
import { roveIndex, type RoveKeys } from '../src/renderer/src/roving'

const ROWS: RoveKeys = { next: 'ArrowDown', prev: 'ArrowUp', ends: true }
const TABS: RoveKeys = { next: 'ArrowRight', prev: 'ArrowLeft', ends: true, wrap: true }
const ITEMS: RoveKeys = { next: 'ArrowDown', prev: 'ArrowUp', wrap: true }

describe('roveIndex', () => {
  it('steps a row at a time and stops at either end', () => {
    expect(roveIndex('ArrowDown', { at: 1, count: 4 }, ROWS)).toBe(2)
    expect(roveIndex('ArrowDown', { at: 3, count: 4 }, ROWS)).toBe(3)
    expect(roveIndex('ArrowUp', { at: 0, count: 4 }, ROWS)).toBe(0)
  })

  it('lands on the first row from none focused, either way', () => {
    expect(roveIndex('ArrowDown', { at: -1, count: 4 }, ROWS)).toBe(0)
    expect(roveIndex('ArrowUp', { at: -1, count: 4 }, ROWS)).toBe(0)
  })

  it('jumps to the ends with Home and End, only where the set takes them', () => {
    expect(roveIndex('Home', { at: 2, count: 4 }, ROWS)).toBe(0)
    expect(roveIndex('End', { at: 0, count: 4 }, ROWS)).toBe(3)
    expect(roveIndex('Home', { at: 2, count: 4 }, ITEMS)).toBeNull()
  })

  it('comes round past either end when the set wraps', () => {
    expect(roveIndex('ArrowRight', { at: 2, count: 3 }, TABS)).toBe(0)
    expect(roveIndex('ArrowLeft', { at: 0, count: 3 }, TABS)).toBe(2)
    expect(roveIndex('ArrowDown', { at: -1, count: 3 }, ITEMS)).toBe(0)
  })

  it('leaves every other key alone', () => {
    expect(roveIndex('ArrowLeft', { at: 1, count: 4 }, ROWS)).toBeNull()
    expect(roveIndex('Enter', { at: 1, count: 4 }, TABS)).toBeNull()
  })
})
