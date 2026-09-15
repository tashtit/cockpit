import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// build/icon.icns is packed by `npm run icon` (iconutil) and committed, rather than rendered
// from a PNG by electron-builder at package time: its converter stores the 16/32/64px entries
// as PNG under the legacy icp4/icp5/icp6 chunk types, which IconServices (Finder, Dock,
// Spotlight) decodes as raw pixels — those sizes show up as noise. This pins the committed
// file to iconutil's layout so a regenerated one cannot quietly bring that back.
const ICNS = join(__dirname, '..', 'build', 'icon.icns')

type Chunk = { readonly type: string; readonly body: Buffer }

/** Every chunk of an icns file, in file order. */
function chunks(icns: Buffer): Chunk[] {
  const out: Chunk[] = []
  for (let at = 8; at + 8 <= icns.length; ) {
    const length = icns.readUInt32BE(at + 4)
    if (length < 8 || at + length > icns.length) break
    out.push({ type: icns.toString('latin1', at, at + 4), body: icns.subarray(at + 8, at + length) })
    at += length
  }
  return out
}

describe('build/icon.icns', () => {
  const icns = readFileSync(ICNS)
  const parsed = chunks(icns)
  const types = parsed.map((c) => c.type)

  it('is a well-formed icns file', () => {
    expect(icns.toString('latin1', 0, 4)).toBe('icns')
    expect(icns.readUInt32BE(4)).toBe(icns.length)
  })

  it('holds 16px and 32px as ARGB, never as PNG in the legacy types', () => {
    for (const type of ['ic04', 'ic05']) {
      const chunk = parsed.find((c) => c.type === type)
      expect(chunk, type).toBeDefined()
      expect(chunk?.body.toString('latin1', 0, 4)).toBe('ARGB')
    }
    for (const legacy of ['icp4', 'icp5', 'icp6']) expect(types).not.toContain(legacy)
  })

  it('covers every size macOS asks for, 1x and 2x', () => {
    // 16@2x, 32@2x, 128, 256, 256@2x, 512, 512@2x, 1024 — the PNG-native types
    const png = ['ic11', 'ic12', 'ic07', 'ic08', 'ic13', 'ic09', 'ic14', 'ic10']
    expect(types).toEqual(expect.arrayContaining(png))
    for (const type of png) {
      const chunk = parsed.find((c) => c.type === type)
      expect(chunk?.body.toString('latin1', 1, 4), type).toBe('PNG')
    }
  })
})
