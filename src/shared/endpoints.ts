import type { ModelEndpoint, ModelEndpointType, Mutable, Provider, WireApi } from './types'

/**
 * Custom model endpoints (BYOK) — pure logic shared by main (env injection) and the
 * renderer (which agents an endpoint applies to). Deliberately IO-free: key material
 * never passes through here except as an opaque string the caller already resolved.
 */

export const ENDPOINT_TYPES: readonly ModelEndpointType[] = ['openai', 'azure', 'anthropic']
export const WIRE_APIS: readonly WireApi[] = ['completions', 'responses']

/**
 * Model names reach a CLI as the `--model` argv value, so they must be argv-safe and
 * never flag-shaped. Single definition on purpose: when this and the spawn-side check
 * drift, a name the picker offers is one the spawn refuses (or worse, accepts).
 */
export function isValidModel(model: string): boolean {
  return /^[A-Za-z0-9._:\/-]{1,64}$/.test(model) && !model.startsWith('-')
}

const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/

/**
 * Hosts a BYOK endpoint may never point at.
 *
 * Local gateways (Ollama, LM Studio, LiteLLM on localhost or the LAN) are a
 * first-class use case, so loopback and private ranges stay allowed. Link-local
 * is not: it carries the cloud instance-metadata services, which no model gateway
 * uses and which hand out credentials to whatever asks. Main fetches these URLs
 * outside the renderer's CSP, so an endpoint the renderer can define is a request
 * the renderer can make. Covers the literal forms, not every numeric encoding.
 */
/**
 * `::ffff:169.254.169.254` is the same address in an IPv6 suit, and the URL parser
 * normalizes it to `::ffff:a9fe:a9fe` — decode it back so one set of rules covers
 * both spellings. Returns the dotted-quad, or null when this isn't a mapped IPv4.
 */
function mappedIpv4(host: string): string | null {
  const m = host.match(/^::ffff:(.+)$/)
  if (!m) return null
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(m[1])) return m[1]
  const hex = m[1].match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (!hex) return null
  const n = ((parseInt(hex[1], 16) << 16) >>> 0) + parseInt(hex[2], 16)
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
}

export function isBlockedEndpointHost(hostname: string): boolean {
  const raw = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  // decode first so a mapped address is judged by the IPv4 rules — which also
  // keeps ::ffff:127.0.0.1 allowed, since local gateways are the point
  const h = mappedIpv4(raw) ?? raw
  if (h === 'metadata.google.internal') return true
  if (/^169\.254\./.test(h)) return true // IPv4 link-local
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true // IPv6 fe80::/10
  return false
}

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
    if (isBlockedEndpointHost(u.hostname)) return null
  } catch {
    return null
  }
  const ep: Mutable<ModelEndpoint> = { id, label, type, baseUrl }
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
      .filter(isValidModel)
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
    .filter(isValidModel)
    .slice(0, 200)
}
