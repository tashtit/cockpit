import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addModelEndpoint,
  bindSessionEndpoint,
  loadConfig,
  removeModelEndpoint,
  saveConfig,
  sessionEndpointFor,
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
