import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodeWav, encodeWav, loudness, render, SAMPLE_RATE, SOUND_NAMES } from '../scripts/sounds-core.mts'
import type { AttentionSurface } from '../src/main/attention'

// resources/sounds/ is written by `npm run sounds` and committed. These pin the files to
// their definitions in scripts/sounds-core.mts — a file swapped for a recording, or a
// definition changed without regenerating, fails here — and keep each one fit to be a
// notification.
const committed = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(new URL(`../resources/sounds/${name}.wav`, import.meta.url)))

/** Every sound the attention desk plays — a new one fails to typecheck here until it is listed */
const PLAYED: Record<Parameters<AttentionSurface['play']>[0], true> = { finish: true, asks: true, fail: true }

describe('resources/sounds', () => {
  it('has a sound for everything the attention desk plays', () => {
    expect(SOUND_NAMES).toEqual(expect.arrayContaining(Object.keys(PLAYED)))
  })

  it('synthesizes from its own numbers alone: the generator imports nothing, so it can read no recording', () => {
    const source = readFileSync(new URL('../scripts/sounds-core.mts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/^\s*import\b|\bimport\s*\(|\brequire\s*\(/m)
  })

  it.each(SOUND_NAMES)('%s.wav is what its definition synthesizes', (name) => {
    const file = committed(name)
    const fresh = encodeWav(render(name))
    expect(file.subarray(0, 44)).toEqual(fresh.subarray(0, 44))
    const a = decodeWav(file)
    const b = decodeWav(fresh)
    let worst = 0
    for (const side of ['left', 'right'] as const) {
      for (let i = 0; i < a[side].length; i++) worst = Math.max(worst, Math.abs(a[side][i] - b[side][i]))
    }
    // one 16-bit step at most: the last bit of a sine may round the other way elsewhere
    expect(Math.round(worst * 32767)).toBeLessThanOrEqual(1)
  })

  it.each(SOUND_NAMES)('%s.wav is short, has headroom, and starts and ends on silence', (name) => {
    const sound = decodeWav(committed(name))
    const { left, right } = sound
    // no longer than Glass, the longest sound it replaced
    expect(left.length / SAMPLE_RATE).toBeLessThanOrEqual(1.65)
    const peak = [...left, ...right].reduce((m, v) => Math.max(m, Math.abs(v)), 0)
    expect(peak).toBeLessThan(10 ** (-6 / 20))
    // no click at either end
    for (const side of [left, right]) {
      expect(side[0]).toBe(0)
      expect(side[side.length - 1]).toBe(0)
    }
    // as loud as the macOS sounds they replaced, on the scale ears use: Glass is -22.6
    // LUFS and Basso -26.5
    expect(loudness(sound)).toBeGreaterThan(-27)
    expect(loudness(sound)).toBeLessThan(-21)
  })
})
