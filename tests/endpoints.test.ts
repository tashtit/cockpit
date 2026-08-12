import { describe, it, expect } from 'vitest'
import {
  endpointAgents,
  endpointEnv,
  endpointSupports,
  modelsRequest,
  parseModelsResponse,
  sanitizeEndpoint
} from '../src/shared/endpoints'
import { endpointPreflight } from '../src/main/chat'
import type { ChatRequest, ModelEndpoint } from '../src/shared/types'

const ep = (over: Partial<ModelEndpoint> = {}): ModelEndpoint => ({
  id: 'ep-1',
  label: 'gateway',
  type: 'openai',
  baseUrl: 'https://gw.example.com/v1',
  ...over
})

describe('sanitizeEndpoint', () => {
  it('accepts a full definition and trims fields', () => {
    const out = sanitizeEndpoint(
      {
        label: '  ollama ',
        type: 'openai',
        baseUrl: ' http://localhost:11434/v1 ',
        wireApi: 'responses',
        headers: { 'X-Tenant-Id': 'mai' },
        models: [' llama3.3 ', 'qwen2.5-coder']
      },
      'id-1'
    )
    expect(out).toEqual({
      id: 'id-1',
      label: 'ollama',
      type: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      wireApi: 'responses',
      headers: { 'X-Tenant-Id': 'mai' },
      models: ['llama3.3', 'qwen2.5-coder']
    })
  })

  it('accepts a minimal definition without optional fields', () => {
    const out = sanitizeEndpoint({ label: 'x', type: 'anthropic', baseUrl: 'https://a.example' }, 'i')
    expect(out).toEqual({ id: 'i', label: 'x', type: 'anthropic', baseUrl: 'https://a.example' })
    expect(out).not.toHaveProperty('headers')
  })

  it('rejects non-objects, missing label, unknown type', () => {
    expect(sanitizeEndpoint(null, 'i')).toBeNull()
    expect(sanitizeEndpoint('x', 'i')).toBeNull()
    expect(sanitizeEndpoint({ label: '  ', type: 'openai', baseUrl: 'https://a.example' }, 'i')).toBeNull()
    expect(sanitizeEndpoint({ label: 'x', type: 'ollama', baseUrl: 'https://a.example' }, 'i')).toBeNull()
  })

  it('rejects non-http(s) and unparsable base URLs', () => {
    expect(sanitizeEndpoint({ label: 'x', type: 'openai', baseUrl: 'not a url' }, 'i')).toBeNull()
    expect(sanitizeEndpoint({ label: 'x', type: 'openai', baseUrl: 'ftp://a.example' }, 'i')).toBeNull()
    expect(sanitizeEndpoint({ label: 'x', type: 'openai', baseUrl: 'file:///etc' }, 'i')).toBeNull()
  })

  it('rejects malformed headers and wire APIs', () => {
    const base = { label: 'x', type: 'openai', baseUrl: 'https://a.example' }
    expect(sanitizeEndpoint({ ...base, wireApi: 'grpc' }, 'i')).toBeNull()
    // header names must be token-shaped; values must not be able to smuggle extra lines
    expect(sanitizeEndpoint({ ...base, headers: { 'bad name': 'v' } }, 'i')).toBeNull()
    expect(sanitizeEndpoint({ ...base, headers: { 'X-Ok': 'a\r\nInjected: b' } }, 'i')).toBeNull()
    expect(sanitizeEndpoint({ ...base, headers: { 'X-Ok': 42 } }, 'i')).toBeNull()
    expect(sanitizeEndpoint({ ...base, headers: ['a'] }, 'i')).toBeNull()
  })

  it('filters unsafe model names and drops an empty models list', () => {
    const out = sanitizeEndpoint(
      {
        label: 'x',
        type: 'openai',
        baseUrl: 'https://a.example',
        models: ['ok-model', '--dangerous', 'sp ace', 42]
      },
      'i'
    )
    expect(out?.models).toEqual(['ok-model'])
    const empty = sanitizeEndpoint(
      { label: 'x', type: 'openai', baseUrl: 'https://a.example', models: [] },
      'i'
    )
    expect(empty).not.toHaveProperty('models')
  })

  it('rejects a malformed id', () => {
    expect(sanitizeEndpoint({ label: 'x', type: 'openai', baseUrl: 'https://a.example' }, 'a b')).toBeNull()
  })
})

describe('endpointAgents / endpointSupports', () => {
  it('anthropic endpoints serve claude and copilot; others copilot only', () => {
    expect(endpointAgents(ep({ type: 'anthropic' }))).toEqual(['claude', 'copilot'])
    expect(endpointAgents(ep({ type: 'openai' }))).toEqual(['copilot'])
    expect(endpointAgents(ep({ type: 'azure' }))).toEqual(['copilot'])
  })

  it('codex never supports BYOK endpoints', () => {
    expect(endpointSupports('codex', ep({ type: 'anthropic' }))).toBe(false)
    expect(endpointSupports('codex', ep())).toBe(false)
  })
})

describe('endpointEnv', () => {
  it('copilot gets the full COPILOT_PROVIDER_* set', () => {
    expect(endpointEnv('copilot', ep({ wireApi: 'responses' }), 'sk-1')).toEqual({
      COPILOT_PROVIDER_BASE_URL: 'https://gw.example.com/v1',
      COPILOT_PROVIDER_TYPE: 'openai',
      COPILOT_PROVIDER_API_KEY: 'sk-1',
      COPILOT_PROVIDER_WIRE_API: 'responses'
    })
  })

  it('copilot omits key and wire api when absent (local Ollama)', () => {
    expect(endpointEnv('copilot', ep())).toEqual({
      COPILOT_PROVIDER_BASE_URL: 'https://gw.example.com/v1',
      COPILOT_PROVIDER_TYPE: 'openai'
    })
  })

  it('claude gets ANTHROPIC_BASE_URL plus the bearer auth token', () => {
    expect(endpointEnv('claude', ep({ type: 'anthropic' }), 'sk-ant')).toEqual({
      ANTHROPIC_BASE_URL: 'https://gw.example.com/v1',
      ANTHROPIC_AUTH_TOKEN: 'sk-ant'
    })
    expect(endpointEnv('claude', ep({ type: 'anthropic' }))).toEqual({
      ANTHROPIC_BASE_URL: 'https://gw.example.com/v1'
    })
  })

  it('custom headers become newline-separated Name: Value pairs for both CLIs', () => {
    const withHeaders = ep({ headers: { 'X-Gateway-Key': 'abc', 'X-Tenant-Id': 'mai' } })
    expect(endpointEnv('copilot', withHeaders)).toMatchObject({
      COPILOT_PROVIDER_HEADERS: 'X-Gateway-Key: abc\nX-Tenant-Id: mai'
    })
    expect(
      endpointEnv('claude', ep({ type: 'anthropic', headers: { 'anthropic-version': '2023-06-01' } }))
    ).toMatchObject({ ANTHROPIC_CUSTOM_HEADERS: 'anthropic-version: 2023-06-01' })
  })

  it('returns null for unsupported provider/endpoint pairs', () => {
    expect(endpointEnv('claude', ep({ type: 'openai' }))).toBeNull()
    expect(endpointEnv('codex', ep({ type: 'anthropic' }))).toBeNull()
  })
})

describe('modelsRequest / parseModelsResponse', () => {
  it('openai listing hits /models with a bearer token and custom headers', () => {
    const req = modelsRequest(ep({ baseUrl: 'http://localhost:11434/v1/', headers: { 'X-A': 'b' } }), 'sk-1')
    expect(req).toEqual({
      url: 'http://localhost:11434/v1/models',
      headers: { 'X-A': 'b', Authorization: 'Bearer sk-1' }
    })
  })

  it('anthropic listing hits /v1/models with x-api-key and a version header', () => {
    const req = modelsRequest(ep({ type: 'anthropic', baseUrl: 'https://api.anthropic.com' }), 'sk-ant')
    expect(req).toEqual({
      url: 'https://api.anthropic.com/v1/models',
      headers: { 'anthropic-version': '2023-06-01', 'x-api-key': 'sk-ant' }
    })
  })

  it('azure has no listable catalog', () => {
    expect(modelsRequest(ep({ type: 'azure' }))).toBeNull()
  })

  it('parses the shared {data:[{id}]} shape and drops junk', () => {
    expect(
      parseModelsResponse({
        data: [{ id: 'llama3.3' }, { id: 'claude-sonnet-4' }, { id: '--flag' }, { name: 'no-id' }, 42]
      })
    ).toEqual(['llama3.3', 'claude-sonnet-4'])
    expect(parseModelsResponse({ models: [] })).toEqual([])
    expect(parseModelsResponse('nope')).toEqual([])
  })
})

describe('endpointPreflight', () => {
  const req = (over: Partial<ChatRequest>): ChatRequest => ({
    provider: 'copilot',
    cwd: '/x',
    prompt: 'p',
    permissionMode: 'safe',
    ...over
  })

  it('passes turns that request no endpoint', () => {
    expect(endpointPreflight(req({}), undefined, false)).toBeNull()
  })

  it('refuses when the endpoint no longer resolves', () => {
    const r = req({ options: { modelEndpoint: 'gone' } })
    expect(endpointPreflight(r, undefined, false)).toMatch(/no longer configured/)
  })

  it('refuses unsupported provider/endpoint pairs', () => {
    const r = req({ provider: 'codex', options: { modelEndpoint: 'ep-1' } })
    expect(endpointPreflight(r, ep(), false)).toMatch(/can't be used with codex/)
  })

  it('refuses when the stored key cannot be decrypted', () => {
    const r = req({ options: { modelEndpoint: 'ep-1', model: 'm1' } })
    expect(endpointPreflight(r, ep({ hasKey: true }), false)).toMatch(/keychain/)
  })

  it('copilot needs an explicit valid model; claude does not', () => {
    const noModel = req({ options: { modelEndpoint: 'ep-1' } })
    expect(endpointPreflight(noModel, ep(), true)).toMatch(/explicit model/)
    const claude = req({
      provider: 'claude',
      options: { modelEndpoint: 'ep-1' }
    })
    expect(endpointPreflight(claude, ep({ type: 'anthropic' }), true)).toBeNull()
  })

  it('passes a fully-specified copilot BYOK turn', () => {
    const r = req({ options: { modelEndpoint: 'ep-1', model: 'llama3.3' } })
    expect(endpointPreflight(r, ep({ hasKey: true }), true)).toBeNull()
  })
})
