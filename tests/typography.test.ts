import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const CSS_PATH = resolve('src/renderer/src/style.css')
const css = readFileSync(CSS_PATH, 'utf8')
const cssDir = join(CSS_PATH, '..')

/**
 * The app's faces ship with it. The anti-pattern is fetching type (or anything
 * else) at runtime: this is a desktop tool, and a window that waits on a font
 * server renders in a fallback face — or not at all — when the network is down.
 */
describe('bundled typography', () => {
  const urls = [...css.matchAll(/url\('([^']+)'\)/g)].map((m) => m[1])

  it('loads every font from disk, never over the network', () => {
    expect(urls.length).toBeGreaterThan(0)
    for (const url of urls) {
      expect(url.startsWith('./')).toBe(true)
      expect(existsSync(join(cssDir, url))).toBe(true)
    }
    expect(css).not.toMatch(/@import|https?:\/\//)
  })

  it('ships the OFL license beside the files it covers', () => {
    expect(existsSync(join(cssDir, 'assets/fonts/LICENSE-IBM-Plex.txt'))).toBe(true)
  })

  it('declares every weight the app actually sets, and no more', () => {
    const declared = new Set(
      [...css.matchAll(/@font-face \{[^}]*font-family: '(Plex Sans|Plex Mono)';[^}]*font-weight: (\d+)/g)].map(
        (m) => `${m[1]} ${m[2]}`
      )
    )
    const used = new Set([...css.matchAll(/font-weight: (\d+)/g)].map((m) => m[1]))
    // the sans carries the UI, so every used weight must exist as a real file
    for (const w of used) expect(declared.has(`Plex Sans ${w}`)).toBe(true)
    // unused weights are dead bytes in the asar
    for (const d of declared) {
      const weight = d.split(' ').pop()!
      if (d.startsWith('Plex Sans')) expect(used.has(weight)).toBe(true)
    }
  })

  it('keeps a system fallback on both registers', () => {
    expect(css).toMatch(/--sans: 'Plex Sans', -apple-system/)
    expect(css).toMatch(/--mono: 'Plex Mono', ui-monospace/)
  })
})
