import type {
  EndpointAuth,
  ModelEndpoint,
  ModelEndpointType,
  Mutable,
  Provider,
  WireApi
} from './types'

/**
 * Custom model endpoints (BYOK) — pure logic shared by main (env injection) and the
 * renderer (which agents an endpoint applies to). Deliberately IO-free: key material
 * never passes through here except as an opaque string the caller already resolved.
 */

export const ENDPOINT_TYPES: readonly ModelEndpointType[] = ['openai', 'azure', 'anthropic']
export const WIRE_APIS: readonly WireApi[] = ['completions', 'responses']
export const ENDPOINT_AUTHS: readonly EndpointAuth[] = ['key', 'bearer']

/**
 * Where "Add a model provider" starts: the providers people bring a key for, with the
 * values that work already filled in — the way `copilot help providers` gives one
 * working example per provider rather than a list of variables to guess at. The two
 * "-compatible" entries are the blank form, for anything else speaking one of those APIs.
 */
export type EndpointPreset = {
  readonly id: string
  /** What the Provider picker lists */
  readonly label: string
  /** The display name it suggests — empty where only the user can name it */
  readonly name: string
  readonly type: ModelEndpointType
  /** The vendor's own address — empty where only the user knows it (an Azure resource, a gateway) */
  readonly baseUrl: string
  /** Concrete example for the Base URL field */
  readonly urlExample: string
  readonly wireApi?: WireApi
  readonly auth?: EndpointAuth
  /** Local servers answer without a key; a hosted API refuses every request without one */
  readonly keyOptional?: boolean
  readonly keyExample?: string
  /** The knobs this provider leaves open — everything else is decided by the fields above */
  readonly ask: readonly ('wireApi' | 'auth' | 'headers')[]
  /** One line on what the fields can't say */
  readonly note: string
}

export const ENDPOINT_PRESETS: readonly EndpointPreset[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    name: 'Anthropic',
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    urlExample: 'https://api.anthropic.com',
    auth: 'key',
    keyExample: 'sk-ant-api03-…',
    ask: [],
    note: 'An API key from console.anthropic.com — usage is billed to that account, not to a Claude plan.'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    name: 'OpenAI',
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    urlExample: 'https://api.openai.com/v1',
    wireApi: 'responses',
    keyExample: 'sk-proj-…',
    ask: ['wireApi'],
    note: 'An API key from platform.openai.com. GPT-5 models need the responses API; older ones take completions.'
  },
  {
    id: 'azure',
    label: 'Azure OpenAI',
    name: 'Azure OpenAI',
    type: 'azure',
    baseUrl: '',
    urlExample: 'https://my-resource.openai.azure.com',
    ask: [],
    note: 'Your resource’s URL and key. Azure lists no models — type the deployment name when you start a session.'
  },
  {
    id: 'ollama',
    label: 'Ollama',
    name: 'Ollama',
    type: 'openai',
    baseUrl: 'http://localhost:11434/v1',
    urlExample: 'http://localhost:11434/v1',
    keyOptional: true,
    ask: [],
    note: 'Runs on this Mac, so no key is needed — start Ollama before starting a session.'
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    name: 'LM Studio',
    type: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    urlExample: 'http://localhost:1234/v1',
    keyOptional: true,
    ask: [],
    note: 'Runs on this Mac, so no key is needed — start its local server before starting a session.'
  },
  {
    id: 'anthropic-compatible',
    label: 'Anthropic-compatible',
    name: '',
    type: 'anthropic',
    baseUrl: '',
    urlExample: 'https://llm-gateway.example.com',
    auth: 'bearer',
    keyOptional: true,
    ask: ['auth', 'headers'],
    note: 'A gateway or proxy that speaks the Anthropic Messages API, such as LiteLLM. Most take the key as a bearer token.'
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible',
    name: '',
    type: 'openai',
    baseUrl: '',
    urlExample: 'http://localhost:8000/v1',
    keyOptional: true,
    ask: ['wireApi', 'headers'],
    note: 'Anything that serves /v1/chat/completions — vLLM, LiteLLM, a company gateway.'
  }
]

const ANTHROPIC_API_HOST = 'api.anthropic.com'

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * How this endpoint's key is sent to `provider` (or to the model listing, with none).
 * An endpoint stored before the choice existed keeps what each agent was given then —
 * Claude a bearer token, everything else the native header — except Claude against the
 * Anthropic API itself, which refuses a bearer key, so that pairing never worked.
 */
export function endpointAuth(ep: ModelEndpoint, provider?: Provider): EndpointAuth {
  if (ep.auth) return ep.auth
  if (provider === 'claude' && hostOf(ep.baseUrl) !== ANTHROPIC_API_HOST) return 'bearer'
  return 'key'
}

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
 * the renderer can make.
 *
 * Numeric encodings need no rule of their own: every caller reads `hostname` off a
 * parsed URL, and the WHATWG parser has already folded `2852039166`, `0xA9FEA9FE`
 * and `0251.0376.0251.0376` to the dotted quad by then (`tests/endpoints.test.ts`
 * pins that). What no rule here can see is a *name* that resolves to a blocked
 * address — only the resolver knows that, and only at connect time.
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
  if (o.auth !== undefined && o.auth !== '') {
    const auth = ENDPOINT_AUTHS.find((a) => a === o.auth)
    if (!auth) return null
    ep.auth = auth
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
export function endpointAgents(ep: Pick<ModelEndpoint, 'type'>): Provider[] {
  return ep.type === 'anthropic' ? ['claude', 'copilot'] : ['copilot']
}

export function endpointSupports(provider: Provider, ep: ModelEndpoint): boolean {
  return endpointAgents(ep).includes(provider)
}

/**
 * Env vars that point a provider CLI at a BYOK endpoint for one spawned turn.
 * The caller decrypts `apiKey` from the keychain store — this stays pure.
 * Returns null when the provider can't use the endpoint.
 *
 * The endpoint's key is the only credential a turn carries, so every credential
 * variable the CLI reads is set — the unused ones to empty, which both CLIs treat as
 * unset. Left alone, one inherited from the shell rides along: Claude sends
 * `ANTHROPIC_API_KEY` *and* `ANTHROPIC_AUTH_TOKEN` when both are there, which would put
 * a first-party Anthropic key in front of a third-party gateway, and Copilot lets a
 * bearer token or key command outrank the key given here.
 */
export function endpointEnv(
  provider: Provider,
  ep: ModelEndpoint,
  apiKey?: string
): Record<string, string> | null {
  if (!endpointSupports(provider, ep)) return null
  const bearer = endpointAuth(ep, provider) === 'bearer'
  // both CLIs take extra headers as newline-separated "Name: Value" pairs
  const headerLines = ep.headers
    ? Object.entries(ep.headers).map(([k, v]) => `${k}: ${v}`).join('\n')
    : ''
  if (provider === 'copilot') {
    const env: Record<string, string> = {
      COPILOT_PROVIDER_BASE_URL: ep.baseUrl,
      COPILOT_PROVIDER_TYPE: ep.type,
      COPILOT_PROVIDER_API_KEY: '',
      COPILOT_PROVIDER_BEARER_TOKEN: '',
      COPILOT_PROVIDER_API_KEY_COMMAND: ''
    }
    // an API key goes out as the type's own header (x-api-key, api-key, Authorization)
    if (apiKey) env[bearer ? 'COPILOT_PROVIDER_BEARER_TOKEN' : 'COPILOT_PROVIDER_API_KEY'] = apiKey
    if (ep.wireApi) env.COPILOT_PROVIDER_WIRE_API = ep.wireApi
    if (headerLines) env.COPILOT_PROVIDER_HEADERS = headerLines
    return env
  }
  // claude: ANTHROPIC_API_KEY is sent as x-api-key (what the Anthropic API takes),
  // ANTHROPIC_AUTH_TOKEN as Authorization: Bearer (what most gateways take)
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: ep.baseUrl,
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_AUTH_TOKEN: ''
  }
  if (apiKey) env[bearer ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY'] = apiKey
  if (headerLines) env.ANTHROPIC_CUSTOM_HEADERS = headerLines
  return env
}

/**
 * The request that lists an endpoint's models, provider-shape aware, carrying the key
 * the way a turn will — so a listing that answers is a key that works. Null when the
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
    if (apiKey && endpointAuth(ep) === 'bearer') headers.Authorization = `Bearer ${apiKey}`
    else if (apiKey) headers['x-api-key'] = apiKey
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
