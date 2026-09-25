import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addModelEndpoint,
  attentionPrefs,
  bindSessionEndpoint,
  bindSessionLineage,
  loadConfig,
  removeModelEndpoint,
  saveConfig,
  sessionEndpointFor,
  sessionLineage,
  sessionLineageFor,
  setAttentionPrefs,
  setHistoryDays,
  setUpdatePrefs,
  setWindowPlacement,
  setZoom,
  updateModelEndpoint,
  updatePrefs
} from '../src/main/config'
import type { ModelEndpoint } from '../src/shared/types'

/**
 * config.ts resolves its dir from COCKPIT_USER_DATA when no electron runtime is
 * present (userDataDir) — point it at a fresh tmpdir per test, real files only.
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cockpit-config-'))
  process.env['COCKPIT_USER_DATA'] = dir
})

afterEach(() => {
  delete process.env['COCKPIT_USER_DATA']
  rmSync(dir, { recursive: true, force: true })
})

const cfgPath = (): string => join(dir, 'cockpit-config.json')

const ep = (id: string): ModelEndpoint => ({
  id,
  label: 'gateway',
  type: 'anthropic',
  baseUrl: 'https://llm.example.test'
})

describe('loadConfig / saveConfig', () => {
  it('round-trips a saved config', () => {
    saveConfig({ sources: [{ path: '/tmp/x', provider: 'claude', label: 'l' }], archived: ['a'] })
    const cfg = loadConfig()
    expect(cfg.archived).toEqual(['a'])
    expect(cfg.sources).toHaveLength(1)
  })

  it('persists defaults on true first run', () => {
    expect(existsSync(cfgPath())).toBe(false)
    const cfg = loadConfig()
    expect(Array.isArray(cfg.sources)).toBe(true)
    expect(existsSync(cfgPath())).toBe(true)
  })

  it('never clobbers a corrupt config file', () => {
    writeFileSync(cfgPath(), '{ definitely not json')
    const cfg = loadConfig()
    expect(Array.isArray(cfg.sources)).toBe(true)
    // the broken file must survive untouched, with a recovery copy alongside
    expect(readFileSync(cfgPath(), 'utf8')).toBe('{ definitely not json')
    expect(readFileSync(cfgPath() + '.corrupt', 'utf8')).toBe('{ definitely not json')
  })

  it('treats valid JSON without sources[] as corrupt, not as first run', () => {
    writeFileSync(cfgPath(), JSON.stringify({ archived: ['keep-me'] }))
    loadConfig()
    expect(JSON.parse(readFileSync(cfgPath(), 'utf8')).archived).toEqual(['keep-me'])
    expect(existsSync(cfgPath() + '.corrupt')).toBe(true)
  })

  it('leaves no .tmp file behind after a save', () => {
    saveConfig({ sources: [] })
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
    expect(existsSync(cfgPath())).toBe(true)
  })

  it('refuses to write over a config it cannot read — even for a window move', () => {
    // every setter builds on loadConfig(), which runs on defaults while the file is
    // unreadable: the first save used to replace the user's config with them
    writeFileSync(cfgPath(), '{ "sources": [ half a file')
    expect(() => setWindowPlacement({ x: 1, y: 2, width: 900, height: 700, fullScreen: false })).toThrow(
      /unreadable/
    )
    expect(() => setHistoryDays(7)).toThrow(/unreadable/)
    expect(readFileSync(cfgPath(), 'utf8')).toBe('{ "sources": [ half a file')
    // fixed by hand, it saves again
    writeFileSync(cfgPath(), JSON.stringify({ sources: [], archived: ['keep-me'] }))
    setHistoryDays(7)
    expect(loadConfig()).toMatchObject({ historyDays: 7, archived: ['keep-me'] })
  })

  it('drops what this build cannot use instead of failing startup on it', () => {
    // a provider from a newer build, a hand-edited source with no path, and lists that
    // aren't lists — startup builds sets and indexes sources from these before the
    // window opens, and one throw there meant no window at all
    writeFileSync(
      cfgPath(),
      JSON.stringify({
        sources: [
          { path: '/tmp/claude-home', provider: 'claude', label: 'main' },
          { path: '/tmp/gemini-home', provider: 'gemini', label: 'new' },
          { provider: 'codex', label: 'no path' },
          { path: '/tmp/copilot-home', provider: 'copilot' }
        ],
        archived: 'claude:one',
        hiddenRepos: ['gh:a/b', 7],
        repoOrder: null,
        archivedRoundtables: { id: 'x' }
      })
    )
    const cfg = loadConfig()
    expect(cfg.sources).toEqual([
      { path: '/tmp/claude-home', provider: 'claude', label: 'main' },
      { path: '/tmp/copilot-home', provider: 'copilot', label: 'copilot' }
    ])
    expect(cfg.archived).toBeUndefined()
    expect(cfg.hiddenRepos).toEqual(['gh:a/b'])
    expect(cfg.repoOrder).toBeUndefined()
    expect(cfg.archivedRoundtables).toBeUndefined()
    expect(() => new Set(cfg.archived ?? [])).not.toThrow()
  })
})

describe('model endpoints', () => {
  it('keeps session bindings when an endpoint is removed, so resume refuses loudly', () => {
    saveConfig({ sources: [] })
    addModelEndpoint(ep('e1'))
    bindSessionEndpoint('claude:s1', 'e1')
    removeModelEndpoint('e1')
    expect(loadConfig().modelEndpoints ?? []).toEqual([])
    // the dangling binding is what routes a resume into endpointPreflight's refusal
    expect(sessionEndpointFor('claude:s1')).toBe('e1')
  })

  it('does not resurrect a removed endpoint on a models-cache write-back', () => {
    saveConfig({ sources: [] })
    addModelEndpoint(ep('e1'))
    removeModelEndpoint('e1')
    updateModelEndpoint({ ...ep('e1'), models: ['m-1'] })
    expect(loadConfig().modelEndpoints ?? []).toEqual([])
  })

  // the refusal copy promises "until it is re-added", and ids are fresh UUIDs, so
  // without label-keyed reclaim those sessions would refuse forever
  it('re-adding under the same label adopts the sessions bound to the removed one', () => {
    saveConfig({ sources: [] })
    addModelEndpoint(ep('e1'))
    bindSessionEndpoint('claude:s1', 'e1')
    removeModelEndpoint('e1')
    expect(sessionEndpointFor('claude:s1')).toBe('e1')
    addModelEndpoint({ ...ep('e2'), label: 'gateway' })
    expect(sessionEndpointFor('claude:s1')).toBe('e2')
    expect(loadConfig().removedEndpoints ?? {}).toEqual({})
  })

  it('a differently-labelled provider does not adopt them', () => {
    saveConfig({ sources: [] })
    addModelEndpoint(ep('e1'))
    bindSessionEndpoint('claude:s1', 'e1')
    removeModelEndpoint('e1')
    addModelEndpoint({ ...ep('e2'), label: 'something else' })
    expect(sessionEndpointFor('claude:s1')).toBe('e1')
  })

  it('updates an existing endpoint in place', () => {
    saveConfig({ sources: [] })
    addModelEndpoint(ep('e1'))
    updateModelEndpoint({ ...ep('e1'), models: ['m-1'] })
    expect(loadConfig().modelEndpoints?.[0]?.models).toEqual(['m-1'])
  })
})

describe('session lineage', () => {
  it('binds and reads back, returning the updated map', () => {
    saveConfig({ sources: [] })
    const map = bindSessionLineage('codex:new', 'claude:old')
    expect(map).toEqual({ 'codex:new': 'claude:old' })
    expect(sessionLineageFor('codex:new')).toBe('claude:old')
    expect(sessionLineage()).toEqual({ 'codex:new': 'claude:old' })
  })

  it('rebinding moves the entry to the recency end', () => {
    saveConfig({ sources: [] })
    bindSessionLineage('a:1', 'src:0')
    bindSessionLineage('b:2', 'src:0')
    bindSessionLineage('a:1', 'src:9')
    expect(Object.keys(sessionLineage())).toEqual(['b:2', 'a:1'])
    expect(sessionLineageFor('a:1')).toBe('src:9')
  })

  it('caps at 500 entries, evicting the oldest', () => {
    saveConfig({ sources: [] })
    for (let i = 0; i < 501; i++) bindSessionLineage(`claude:s${i}`, 'claude:src')
    const map = sessionLineage()
    expect(Object.keys(map)).toHaveLength(500)
    expect(map['claude:s0']).toBeUndefined()
    expect(map['claude:s500']).toBe('claude:src')
  })

  it('skips the rewrite when the last entry already matches (duplicate session events)', () => {
    saveConfig({ sources: [] })
    bindSessionLineage('codex:new', 'claude:old')
    // whitespace sentinel: JSON.parse tolerates it, any resave would destroy it
    writeFileSync(cfgPath(), readFileSync(cfgPath(), 'utf8') + '\n   \n')
    bindSessionLineage('codex:new', 'claude:old')
    expect(readFileSync(cfgPath(), 'utf8').endsWith('\n   \n')).toBe(true)
  })

  it('refuses a self-link', () => {
    saveConfig({ sources: [] })
    const map = bindSessionLineage('claude:same', 'claude:same')
    expect(map).toEqual({})
    expect(sessionLineageFor('claude:same')).toBeUndefined()
  })
})

describe('attention prefs', () => {
  it('untouched switches follow the build — off outside an installed app, so dev and test runs stay silent', () => {
    saveConfig({ sources: [] })
    expect(attentionPrefs()).toEqual({ notifications: false, sound: false, badge: false, cleanup: false })
  })

  it('writes only the switch the user flipped, so the others keep following the build', () => {
    saveConfig({ sources: [] })
    const saved = setAttentionPrefs({ notifications: false, sound: true, badge: false, cleanup: false })
    expect(saved).toEqual({ notifications: false, sound: true, badge: false, cleanup: false })
    expect(loadConfig().attention).toEqual({ sound: true })

    setAttentionPrefs({ notifications: false, sound: false, badge: false, cleanup: true })
    expect(loadConfig().attention).toEqual({ sound: false, cleanup: true })
  })

  it('treats renderer input as untrusted: anything but true is off, garbage in the file is ignored', () => {
    saveConfig({ sources: [], attention: { notifications: 'yes' as unknown as boolean, badge: true } })
    expect(attentionPrefs()).toEqual({ notifications: false, sound: false, badge: true, cleanup: false })
    const saved = setAttentionPrefs({ notifications: 1, sound: 'on', badge: null, cleanup: 'yes' } as unknown as Parameters<
      typeof setAttentionPrefs
    >[0])
    expect(saved).toEqual({ notifications: false, sound: false, badge: false, cleanup: false })
  })
})

describe('update prefs', () => {
  it('keeps Cockpit current until the user says otherwise', () => {
    // unlike the attention switches these do not follow the build: every build that
    // can update at all is an installed one, and keeping itself current is the point
    expect(updatePrefs()).toEqual({ download: true, install: true })
  })

  it('stores a switch the user flipped, and only that', () => {
    expect(setUpdatePrefs({ download: false, install: true })).toEqual({ download: false, install: true })
    expect(updatePrefs()).toEqual({ download: false, install: true })
    expect(loadConfig().updates).toEqual({ download: false, install: true })
  })

  it('reads anything but a real true out of the renderer as off', () => {
    // these switches act by themselves: a malformed value must land on the side
    // that does no work, and a click puts it back
    expect(setUpdatePrefs({ download: 'yes', install: 1 } as unknown as never)).toEqual({
      download: false,
      install: false
    })
  })
})

describe('interface zoom', () => {
  it('is absent until the user sets one, so a fresh install opens at 100%', () => {
    expect(loadConfig().zoom).toBeUndefined()
  })

  it('stores the level the user last set', () => {
    expect(setZoom(1.25)).toBe(1.25)
    expect(loadConfig().zoom).toBe(1.25)
  })

  it('stores only a level the user could have reached — the file is editable by hand', () => {
    expect(setZoom(9)).toBe(2)
    expect(setZoom(0.01)).toBe(0.7)
    expect(setZoom(Number.NaN)).toBe(1)
    expect(loadConfig().zoom).toBe(1)
  })
})
