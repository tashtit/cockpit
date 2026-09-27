import { describe, expect, it } from 'vitest'
import { mapLimit } from '../src/main/map-limit'

describe('mapLimit', () => {
  it('never runs more than the limit at once, and keeps the input order', async () => {
    let running = 0
    let most = 0
    const out = await mapLimit(
      [50, 10, 30, 0, 20, 40, 5],
      async (ms) => {
        running++
        most = Math.max(most, running)
        await new Promise((r) => setTimeout(r, ms))
        running--
        return ms * 2
      },
      3
    )
    expect(most).toBe(3)
    expect(out).toEqual([100, 20, 60, 0, 40, 80, 10])
  })

  it('answers an empty list without calling anything', async () => {
    expect(await mapLimit([], async () => 1, 4)).toEqual([])
  })
})
