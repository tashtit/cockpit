import { describe, it, expect, afterAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexCatalog, codexConfiguredModel, copilotModelsInLog } from '../src/main/agent-models-core'
import { listAgentModels } from '../src/main/agent-models'
import { BUILTIN_MODELS, mergeModels } from '../src/shared/agent-models'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
function home(): string {
  const d = mkdtempSync(join(tmpdir(), 'cockpit-models-'))
  dirs.push(d)
  return d
}

const CODEX_CACHE = JSON.stringify({
  fetched_at: '2026-09-21T00:00:00Z',
  models: [
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 5 },
    { slug: 'gpt-reserve', display_name: 'GPT Reserve', visibility: 'hide', priority: 2 },
    {
      slug: 'gpt-6-astra',
      display_name: 'GPT-6-Astra',
      description: 'Most capable',
      visibility: 'list',
      priority: 1,
      default_reasoning_level: 'low',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }, { effort: 'Bad Level' }],
      service_tiers: [{ id: 'priority', name: 'Fast' }]
    },
    { slug: '--flag', visibility: 'list' },
    { display_name: 'no slug' }
  ]
})

describe('codexCatalog', () => {
  it('lists what Codex’s own picker lists, in its priority order', () => {
    expect(codexCatalog(CODEX_CACHE)).toEqual([
      {
        id: 'gpt-6-astra',
        label: 'GPT-6-Astra',
        description: 'Most capable',
        efforts: ['low', 'ultra'],
        defaultEffort: 'low',
        fast: true
      },
      { id: 'gpt-5.5', label: 'GPT-5.5' }
    ])
  })

  it('an unreadable cache is an empty list, never a throw', () => {
    expect(codexCatalog('not json')).toEqual([])
    expect(codexCatalog('{"models": 7}')).toEqual([])
  })

  it('reads the configured default model', () => {
    expect(codexConfiguredModel('approval = "never"\nmodel = "gpt-5.5"\n')).toBe('gpt-5.5')
    expect(codexConfiguredModel('[profiles.x]\n')).toBeNull()
  })
})

describe('copilotModelsInLog', () => {
  it('keeps the models the CLI served, skipping custom-provider ids and hashes', () => {
    const log = [
      '{"type":"session.start","data":{"selectedModel":"gpt-5.6-sol"}}',
      '{"type":"assistant.usage","data":{"model":"claude-opus-5"}}',
      '{"type":"session.model_change","data":{"newModel":"977b9f59-161a-40cb-b311-c0b52714ef95/claude-opus-5"}}',
      '{"data":{"model":"b6ea42e4bd2e47862f414a7cee21313ac3435212d79334a6716b7591b90bdc9d"}}',
      '{"data":{"model":"claude-opus-5"}}'
    ].join('\n')
    // claude-opus-5 also ran behind a provider in this log, so its bare name is that
    // provider's too — only the default backend's models are kept
    expect(copilotModelsInLog(log)).toEqual(['gpt-5.6-sol'])
  })

  it('a custom provider’s bare turn records never reach the picker', () => {
    const log = [
      '{"type":"session.start","data":{"selectedModel":"ea92903f-20cf-44d0-9c37-af9c9def253a/qwen3.5:4b"}}',
      '{"type":"assistant.message","data":{"model":"qwen3.5:4b"}}',
      '{"type":"session.shutdown","data":{"currentModel":"qwen3.5:4b"}}'
    ].join('\n')
    expect(copilotModelsInLog(log)).toEqual([])
    expect(copilotModelsInLog('{"data":{"model":"claude-opus-5"}}')).toEqual(['claude-opus-5'])
  })
})

describe('listAgentModels', () => {
  it('claude: the documented aliases and names — it keeps no catalog', () => {
    expect(listAgentModels('claude', home())).toEqual(BUILTIN_MODELS.claude)
  })

  it('codex: its own cached catalog, plus the configured default', () => {
    const h = home()
    writeFileSync(join(h, 'models_cache.json'), CODEX_CACHE)
    writeFileSync(join(h, 'config.toml'), 'model = "gpt-5.4-legacy"\n')
    expect(listAgentModels('codex', h).map((m) => m.id)).toEqual([
      'gpt-6-astra',
      'gpt-5.5',
      'gpt-5.4-legacy'
    ])
  })

  it('copilot: auto, then every model its session logs show it serving', () => {
    const h = home()
    const log = (id: string, text: string, mtime: number): void => {
      mkdirSync(join(h, 'session-state', id), { recursive: true })
      const p = join(h, 'session-state', id, 'events.jsonl')
      writeFileSync(p, text)
      utimesSync(p, mtime, mtime)
    }
    log('a', '{"data":{"model":"gpt-5.6-sol"}}\n', 1000)
    log('b', '{"data":{"currentModel":"claude-opus-5"}}\n', 2000)
    mkdirSync(join(h, 'session-state', 'no-log'))
    expect(listAgentModels('copilot', h).map((m) => m.id)).toEqual([
      'auto',
      'claude-opus-5',
      'gpt-5.6-sol'
    ])
  })

  it('a home with nothing in it still offers the built-ins', () => {
    expect(listAgentModels('codex', home())).toEqual([])
    expect(listAgentModels('copilot', home()).map((m) => m.id)).toEqual(['auto'])
  })
})

describe('mergeModels', () => {
  it('keeps each id once, the first description winning', () => {
    expect(
      mergeModels([{ id: 'a', label: 'A', description: 'first' }], [
        { id: 'a', label: 'a' },
        { id: 'b', label: 'b' }
      ])
    ).toEqual([
      { id: 'a', label: 'A', description: 'first' },
      { id: 'b', label: 'b' }
    ])
  })
})
