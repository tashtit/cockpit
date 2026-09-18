import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CH, PUSH } from '../src/shared/contract'

/**
 * The renderer↔main contract is 96 channel names that main and preload have to agree
 * on exactly. TypeScript checks the shape of `CockpitApi`, but `ipcMain.handle` and
 * `ipcRenderer.invoke` take a plain string, so nothing checked the names themselves —
 * a typo surfaced as a runtime "No handler registered", if anything reached it at all.
 *
 * Routing every call through `CH`/`PUSH` makes a typo a typecheck failure. These tests
 * cover what the compiler still can't see: that no bare literal comes back, and that
 * both ends of every channel actually exist.
 */
const read = (p: string): string => readFileSync(fileURLToPath(new URL(p, import.meta.url)), 'utf8')
const MAIN = read('../src/main/index.ts')
const PRELOAD = read('../src/preload/index.ts')

/** Escape every regex metacharacter, not just the dot — `\` first, or it re-escapes. */
function quoteRe(literal: string): string {
  return literal.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

/**
 * Channel argument as written at the call site, literal or not. The lookbehind skips
 * `function sendToWin(channel: …)` — the declaration is not a call site.
 */
function argsOf(source: string, fn: string): string[] {
  const pattern = new RegExp(`(?<!function )${quoteRe(fn)}\\(\\s*([^,)\\s]+)`, 'g')
  return [...source.matchAll(pattern)].map((m) => m[1])
}

describe('IPC channels are named, never spelled', () => {
  it.each([
    ['ipcMain.handle', () => MAIN],
    ['sendToWin', () => MAIN],
    ['ipcRenderer.invoke', () => PRELOAD],
    ['ipcRenderer.on', () => PRELOAD],
    ['ipcRenderer.removeListener', () => PRELOAD]
  ])('%s takes a CH/PUSH member, not a string literal', (fn, source) => {
    const literals = argsOf(source(), fn).filter((a) => a.startsWith("'"))
    expect(literals).toEqual([])
  })
})

describe('every channel has both ends', () => {
  const handled = new Set(argsOf(MAIN, 'ipcMain.handle'))
  const invoked = new Set(argsOf(PRELOAD, 'ipcRenderer.invoke'))
  const pushed = new Set(argsOf(MAIN, 'sendToWin'))
  const listened = new Set(argsOf(PRELOAD, 'ipcRenderer.on'))

  it('every CH member is handled in main', () => {
    const missing = Object.keys(CH).filter((k) => !handled.has(`CH.${k}`))
    expect(missing).toEqual([])
  })

  it('every CH member is invoked from preload', () => {
    const missing = Object.keys(CH).filter((k) => !invoked.has(`CH.${k}`))
    expect(missing).toEqual([])
  })

  it('every PUSH member is sent by main and listened for in preload', () => {
    const unsent = Object.keys(PUSH).filter((k) => !pushed.has(`PUSH.${k}`))
    const unheard = Object.keys(PUSH).filter((k) => !listened.has(`PUSH.${k}`))
    expect({ unsent, unheard }).toEqual({ unsent: [], unheard: [] })
  })

  it('main and preload reference the same invoke channels', () => {
    expect([...handled].sort()).toEqual([...invoked].sort())
  })
})

describe('the map itself', () => {
  it('has no duplicate wire names', () => {
    const all = [...Object.values(CH), ...Object.values(PUSH)]
    expect(new Set(all).size).toBe(all.length)
  })

  it('invoke channels are domain:verb, push channels kebab-case nouns', () => {
    // both halves may be kebab-case: `time-format:get`, `panel:set-switch`
    const kebab = /^[a-z]+(-[a-z]+)*$/
    expect(Object.values(CH).filter((c) => !c.split(':').every((h) => kebab.test(h)))).toEqual([])
    expect(Object.values(CH).filter((c) => c.split(':').length !== 2)).toEqual([])
    expect(Object.values(PUSH).filter((c) => !kebab.test(c))).toEqual([])
  })
})
