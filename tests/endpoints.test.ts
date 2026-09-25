import { describe, it, expect } from 'vitest'
import {
  endpointUrlRefusal,
  isLocalEndpointHost,
  ENDPOINT_PRESETS,
  endpointAgents,
  endpointAuth,
  endpointEnv,
  endpointSupports,
  isBlockedEndpointHost,
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

  it('rejects link-local hosts but keeps local gateways usable', () => {
    const base = { label: 'x', type: 'openai' }
    // main fetches these URLs outside the renderer's CSP — cloud metadata is off limits
    expect(sanitizeEndpoint({ ...base, baseUrl: 'http://169.254.169.254/latest' }, 'i')).toBeNull()
    expect(sanitizeEndpoint({ ...base, baseUrl: 'http://metadata.google.internal/x' }, 'i')).toBeNull()
    expect(sanitizeEndpoint({ ...base, baseUrl: 'http://[fe80::1]/v1' }, 'i')).toBeNull()
    // running Ollama/LM Studio locally or on the LAN stays a first-class setup
    expect(sanitizeEndpoint({ ...base, baseUrl: 'http://localhost:11434/v1' }, 'i')).not.toBeNull()
    expect(sanitizeEndpoint({ ...base, baseUrl: 'http://192.168.1.20:4000' }, 'i')).not.toBeNull()
  })

  it('takes plain http only for this machine and private networks', () => {
    const base = { label: 'x', type: 'openai' }
    for (const url of ['http://api.openai.com/v1', 'http://gateway.example.com', 'http://8.8.8.8/v1', 'http://[2001:db8::1]/v1']) {
      expect(sanitizeEndpoint({ ...base, baseUrl: url }, 'i'), url).toBeNull()
      expect(endpointUrlRefusal(url), url).toMatch(/Use https:\/\//)
    }
    for (const url of [
      'http://127.0.0.1:8080',
      'http://10.0.0.5/v1',
      'http://172.20.1.1',
      'http://100.101.102.103:11434',
      'http://[fd12:3456::1]/v1',
      'http://gpu-box:8000/v1',
      'http://studio.local:1234/v1',
      'https://gateway.example.com/v1'
    ]) {
      expect(sanitizeEndpoint({ ...base, baseUrl: url }, 'i'), url).not.toBeNull()
      expect(endpointUrlRefusal(url), url).toBeNull()
    }
    expect(isLocalEndpointHost('172.32.0.1')).toBe(false)
  })

  // the URL parser rewrites a mapped address to ::ffff:a9fe:a9fe, which matches
  // neither the IPv4 nor the IPv6 rule unless it is decoded first
  it('sees through IPv4-mapped IPv6 spellings of a blocked address', () => {
    const base = { label: 'x', type: 'openai' }
    expect(sanitizeEndpoint({ ...base, baseUrl: 'http://[::ffff:169.254.169.254]/v1' }, 'i')).toBeNull()
    expect(isBlockedEndpointHost('[::ffff:a9fe:a9fe]')).toBe(true)
    expect(isBlockedEndpointHost('::ffff:169.254.169.254')).toBe(true)
    // a mapped loopback is still just loopback — local gateways keep working
    expect(isBlockedEndpointHost('::ffff:7f00:1')).toBe(false)
    expect(sanitizeEndpoint({ ...base, baseUrl: 'http://[::ffff:127.0.0.1]:11434' }, 'i')).not.toBeNull()
  })

  it('normalizes numeric IPv4 encodings of a blocked address', () => {
    const base = { label: 'x', type: 'openai' }
    // WHATWG parses these back to 169.254.169.254 before the guard sees them
    expect(sanitizeEndpoint({ ...base, baseUrl: 'http://2852039166/latest' }, 'i')).toBeNull()
    expect(sanitizeEndpoint({ ...base, baseUrl: 'http://0251.0376.0251.0376/' }, 'i')).toBeNull()
  })

  it('keeps a known key-sending choice and refuses anything else', () => {
    const base = { label: 'x', type: 'anthropic', baseUrl: 'https://gw.example' }
    expect(sanitizeEndpoint({ ...base, auth: 'bearer' }, 'i')?.auth).toBe('bearer')
    expect(sanitizeEndpoint({ ...base, auth: 'key' }, 'i')?.auth).toBe('key')
    expect(sanitizeEndpoint({ ...base, auth: '' }, 'i')).not.toHaveProperty('auth')
    expect(sanitizeEndpoint({ ...base, auth: 'basic' }, 'i')).toBeNull()
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
  /** Every credential variable a turn sets, blank — what a keyless endpoint carries */
  const noCopilotKey = {
    COPILOT_PROVIDER_API_KEY: '',
    COPILOT_PROVIDER_BEARER_TOKEN: '',
    COPILOT_PROVIDER_API_KEY_COMMAND: ''
  }
  const noClaudeKey = { ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' }

  it('copilot gets the full COPILOT_PROVIDER_* set', () => {
    expect(endpointEnv('copilot', ep({ wireApi: 'responses' }), 'sk-1')).toEqual({
      COPILOT_PROVIDER_BASE_URL: 'https://gw.example.com/v1',
      COPILOT_PROVIDER_TYPE: 'openai',
      ...noCopilotKey,
      COPILOT_PROVIDER_API_KEY: 'sk-1',
      COPILOT_PROVIDER_WIRE_API: 'responses'
    })
  })

  it('copilot carries no key and no wire api when there are none (local Ollama)', () => {
    expect(endpointEnv('copilot', ep())).toEqual({
      COPILOT_PROVIDER_BASE_URL: 'https://gw.example.com/v1',
      COPILOT_PROVIDER_TYPE: 'openai',
      ...noCopilotKey
    })
  })

  it('the Anthropic API gets its key as x-api-key from both agents, as it requires', () => {
    const anthropic = ep({ type: 'anthropic', baseUrl: 'https://api.anthropic.com', auth: 'key' })
    expect(endpointEnv('claude', anthropic, 'sk-ant')).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_API_KEY: 'sk-ant',
      ANTHROPIC_AUTH_TOKEN: ''
    })
    expect(endpointEnv('copilot', anthropic, 'sk-ant')).toMatchObject({
      COPILOT_PROVIDER_TYPE: 'anthropic',
      COPILOT_PROVIDER_API_KEY: 'sk-ant',
      COPILOT_PROVIDER_BEARER_TOKEN: ''
    })
  })

  it('a bearer gateway gets Authorization from both agents', () => {
    const gateway = ep({ type: 'anthropic', auth: 'bearer' })
    expect(endpointEnv('claude', gateway, 'gw-1')).toEqual({
      ANTHROPIC_BASE_URL: 'https://gw.example.com/v1',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: 'gw-1'
    })
    expect(endpointEnv('copilot', gateway, 'gw-1')).toMatchObject({
      COPILOT_PROVIDER_API_KEY: '',
      COPILOT_PROVIDER_BEARER_TOKEN: 'gw-1'
    })
  })

  // the shell's own ANTHROPIC_API_KEY would otherwise ride along: Claude sends both
  // headers when both variables are set
  it('blanks every credential the endpoint does not supply, so none is inherited', () => {
    expect(endpointEnv('claude', ep({ type: 'anthropic', auth: 'bearer' }))).toEqual({
      ANTHROPIC_BASE_URL: 'https://gw.example.com/v1',
      ...noClaudeKey
    })
  })

  it('an endpoint stored before the choice existed keeps what each agent was sent', () => {
    const legacy = ep({ type: 'anthropic' })
    expect(endpointAuth(legacy, 'claude')).toBe('bearer')
    expect(endpointAuth(legacy, 'copilot')).toBe('key')
    expect(endpointAuth(legacy)).toBe('key')
    expect(endpointEnv('claude', legacy, 'sk-gw')).toMatchObject({ ANTHROPIC_AUTH_TOKEN: 'sk-gw' })
  })

  // Claude used to send the key as a bearer token there, which the API refuses
  it('except Claude against the Anthropic API, which only ever took x-api-key', () => {
    const legacy = ep({ type: 'anthropic', baseUrl: 'https://api.anthropic.com/' })
    expect(endpointAuth(legacy, 'claude')).toBe('key')
    expect(endpointEnv('claude', legacy, 'sk-ant')).toMatchObject({
      ANTHROPIC_API_KEY: 'sk-ant',
      ANTHROPIC_AUTH_TOKEN: ''
    })
  })

  it('custom headers become newline-separated Name: Value pairs for both CLIs', () => {
    const withHeaders = ep({ headers: { 'X-Gateway-Key': 'abc', 'X-Tenant-Id': 'mai' } })
    expect(endpointEnv('copilot', withHeaders)).toMatchObject({
      COPILOT_PROVIDER_HEADERS: 'X-Gateway-Key: abc\nX-Tenant-Id: mai'
    })
    expect(
      endpointEnv('claude', ep({ type: 'anthropic', headers: { 'X-Tenant-Id': 'mai' } }))
    ).toMatchObject({ ANTHROPIC_CUSTOM_HEADERS: 'X-Tenant-Id: mai' })
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

  // the listing is the add form's only check of the key, so it has to send it the
  // way a turn will — a gateway taking bearer tokens refuses x-api-key
  it('an anthropic gateway taking bearer tokens is listed with one', () => {
    const req = modelsRequest(ep({ type: 'anthropic', auth: 'bearer' }), 'gw-1')
    expect(req?.headers).toEqual({ 'anthropic-version': '2023-06-01', Authorization: 'Bearer gw-1' })
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

describe('ENDPOINT_PRESETS', () => {
  const preset = (id: string) => {
    const p = ENDPOINT_PRESETS.find((x) => x.id === id)
    if (!p) throw new Error(`no preset ${id}`)
    return p
  }

  it('opens on Anthropic, filled in with the address and key header its API takes', () => {
    expect(ENDPOINT_PRESETS[0]).toMatchObject({
      id: 'anthropic',
      type: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      auth: 'key'
    })
    expect(ENDPOINT_PRESETS[0].keyOptional).toBeFalsy()
  })

  it('every preset with an address of its own is one sanitizeEndpoint accepts as-is', () => {
    for (const p of ENDPOINT_PRESETS.filter((x) => x.baseUrl)) {
      const out = sanitizeEndpoint(
        { label: p.name, type: p.type, baseUrl: p.baseUrl, wireApi: p.wireApi, auth: p.auth },
        'i'
      )
      expect(out, p.id).not.toBeNull()
      expect(out?.baseUrl, p.id).toBe(p.baseUrl)
    }
  })

  it('every example address is valid too, so a placeholder never teaches a refused URL', () => {
    for (const p of ENDPOINT_PRESETS) {
      expect(sanitizeEndpoint({ label: 'x', type: p.type, baseUrl: p.urlExample }, 'i'), p.id).not.toBeNull()
    }
  })

  it('only local servers and bring-your-own gateways go without a key', () => {
    const optional = ENDPOINT_PRESETS.filter((p) => p.keyOptional).map((p) => p.id)
    expect(optional).toEqual(['ollama', 'lmstudio', 'anthropic-compatible', 'openai-compatible'])
  })

  it('asks about the wire API only where it is an openai endpoint, and the key header only on an anthropic one', () => {
    for (const p of ENDPOINT_PRESETS) {
      if (p.ask.includes('wireApi')) expect(p.type, p.id).toBe('openai')
      if (p.ask.includes('auth')) expect(p.type, p.id).toBe('anthropic')
    }
    expect(preset('openai').wireApi).toBe('responses')
    expect(preset('anthropic-compatible').auth).toBe('bearer')
  })

  it('local presets point at the servers\' own default ports', () => {
    expect(preset('ollama').baseUrl).toBe('http://localhost:11434/v1')
    expect(preset('lmstudio').baseUrl).toBe('http://localhost:1234/v1')
  })

  it('ids are unique — they are the picker values', () => {
    expect(new Set(ENDPOINT_PRESETS.map((p) => p.id)).size).toBe(ENDPOINT_PRESETS.length)
  })
})
