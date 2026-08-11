import type { ModelEndpoint, ModelEndpointType, Provider, WireApi } from './types'

/**
 * Custom model endpoints (BYOK) — pure logic shared by main (env injection) and the
 * renderer (which agents an endpoint applies to). Deliberately IO-free: key material
 * never passes through here except as an opaque string the caller already resolved.
 */

export const ENDPOINT_TYPES: readonly ModelEndpointType[] = ['openai', 'azure', 'anthropic']
export const WIRE_APIS: readonly WireApi[] = ['completions', 'responses']

/** Same shape chat.ts accepts for --model — endpoint model suggestions feed that flag. */
const MODEL_NAME = /^[A-Za-z0-9._:\/-]{1,64}$/
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/

/**
 * Renderer input is untrusted — normalize and validate every field. The API key is NOT
 * part of the definition handled here: main strips it off and stores it encrypted.
 * Returns null when the definition is unusable.
 */
export function sanitizeEndpoint(input: unknown, id: string): ModelEndpoint | null {
  if (typeof input !== 'object' || input === null) return null
  if (!/^[A-Za-z0-9-]{1,64}$/.test(id)) return null
  const o = input as Record<string, unknown>
  const label = typeof o.label === 'string' ? o.label.trim().slice(0, 64) : ''
  const baseUrl = typeof o.baseUrl === 'string' ? o.baseUrl.trim() : ''
  const type = ENDPOINT_TYPES.find((t) => t === o.type)
  if (!label || !type) return null
  try {
    const u = new URL(baseUrl)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
  } catch {
    return null
  }
  const ep: ModelEndpoint = { id, label, type, baseUrl }
  if (o.wireApi !== undefined && o.wireApi !== '') {
    const wire = WIRE_APIS.find((w) => w === o.wireApi)
    if (!wire) return null
    ep.wireApi = wire
  }
  if (o.headers !== undefined) {
    if (typeof o.headers !== 'object' || o.headers === null || Array.isArray(o.headers)) return null
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(o.headers as Record<string, unknown>)) {
      // header values become env-carried "Name: Value" lines — reject anything that
      // could split lines or smuggle a second header
      if (typeof v !== 'string') return null
      if (!HEADER_NAME.test(k)) return null
      if (/[\r\n\0]/.test(v) || v.length > 1024) return null
      headers[k] = v.trim()
    }
    const names = Object.keys(headers)
    if (names.length > 16) return null
    if (names.length > 0) ep.headers = headers
  }
  if (o.models !== undefined) {
    if (!Array.isArray(o.models)) return null
    const models = o.models
      .filter((m): m is string => typeof m === 'string')
      .map((m) => m.trim())
      // same rule as chat.ts isValidModel: argv-safe and never flag-shaped
      .filter((m) => MODEL_NAME.test(m) && !m.startsWith('-'))
      .slice(0, 20)
    if (models.length > 0) ep.models = models
  }
  return ep
}

/**
 * Agents that can run against this endpoint. Copilot's BYOK mode speaks every provider
 * class; Claude Code only its own API shape (ANTHROPIC_BASE_URL). Codex would need
 * config.toml writes (model_providers) rather than env — not supported yet.
 */
export function endpointAgents(ep: ModelEndpoint): Provider[] {
  return ep.type === 'anthropic' ? ['claude', 'copilot'] : ['copilot']
}

export function endpointSupports(provider: Provider, ep: ModelEndpoint): boolean {
  return endpointAgents(ep).includes(provider)
}

/**
 * Env vars that point a provider CLI at a BYOK endpoint for one spawned turn.
 * The caller decrypts `apiKey` from the keychain store — this stays pure.
 * Returns null when the provider can't use the endpoint.
 */
export function endpointEnv(
  provider: Provider,
  ep: ModelEndpoint,
  apiKey?: string
): Record<string, string> | null {
  if (!endpointSupports(provider, ep)) return null
  // both CLIs take extra headers as newline-separated "Name: Value" pairs
  const headerLines = ep.headers
    ? Object.entries(ep.headers).map(([k, v]) => `${k}: ${v}`).join('\n')
    : ''
  if (provider === 'copilot') {
    const env: Record<string, string> = {
      COPILOT_PROVIDER_BASE_URL: ep.baseUrl,
      COPILOT_PROVIDER_TYPE: ep.type
    }
    if (apiKey) env.COPILOT_PROVIDER_API_KEY = apiKey
    if (ep.wireApi) env.COPILOT_PROVIDER_WIRE_API = ep.wireApi
    if (headerLines) env.COPILOT_PROVIDER_HEADERS = headerLines
    return env
  }
  // claude: ANTHROPIC_AUTH_TOKEN is the documented auth var for custom endpoints
  // (gateways expect Authorization: Bearer, unlike the first-party x-api-key)
  const env: Record<string, string> = { ANTHROPIC_BASE_URL: ep.baseUrl }
  if (apiKey) env.ANTHROPIC_AUTH_TOKEN = apiKey
  if (headerLines) env.ANTHROPIC_CUSTOM_HEADERS = headerLines
  return env
}

/**
 * The request that lists an endpoint's models, provider-shape aware. Null when the
 * endpoint type has no listable catalog (Azure deployments need the management API).
 */
export function modelsRequest(
  ep: ModelEndpoint,
  apiKey?: string
): { url: string; headers: Record<string, string> } | null {
  const base = ep.baseUrl.replace(/\/+$/, '')
  if (ep.type === 'openai') {
    const headers: Record<string, string> = { ...ep.headers }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    return { url: `${base}/models`, headers }
  }
  if (ep.type === 'anthropic') {
    const headers: Record<string, string> = {
      'anthropic-version': '2023-06-01',
      ...ep.headers
    }
    if (apiKey) headers['x-api-key'] = apiKey
    return { url: `${base}/v1/models`, headers }
  }
  return null
}

/** Both the OpenAI and Anthropic list-models shapes are `{data: [{id}]}`. */
export function parseModelsResponse(json: unknown): string[] {
  const data = (json as { data?: unknown })?.data
  if (!Array.isArray(data)) return []
  return data
    .map((m) => (m as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === 'string')
    .map((id) => id.trim())
    .filter((id) => MODEL_NAME.test(id) && !id.startsWith('-'))
    .slice(0, 200)
}
