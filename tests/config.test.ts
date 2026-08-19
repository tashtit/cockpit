import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addModelEndpoint,
  bindSessionEndpoint,
  bindSessionLineage,
  loadConfig,
  removeModelEndpoint,
  saveConfig,
  sessionEndpointFor,
  sessionLineage,
  sessionLineageFor,
  updateModelEndpoint
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
    expect(existsSync(cfgPath() + '.tmp')).toBe(false)
    expect(existsSync(cfgPath())).toBe(true)
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
