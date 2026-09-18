import type { Provider } from '../shared/types'

/**
 * VS Code's agent host — what it is, and why Cockpit reads it at all.
 *
 * Since VS Code 1.129 the editor drives Claude, Codex and Copilot through a separate
 * "agent host" process, and talks to it over the Agent Host Protocol (AHP). AHP is not
 * a rival to the ACP work in `acp.ts`: it is a coordination layer whose host holds
 * authoritative state for N clients and speaks ACP *down* to the agent. Cockpit has no
 * multi-client problem, so none of that is a transport Cockpit wants.
 *
 * What Cockpit does have is a coverage problem. The host keeps each session in its own
 * store — `agentSessionData/<uuid>/session.db` — and for Claude drives a downloaded SDK
 * over a `proxy` transport rather than the `claude` CLI. None of it lands in ~/.claude,
 * ~/.codex or ~/.copilot, which are the only places `SessionIndexer` looks. So a session
 * someone starts in VS Code is invisible to an app whose premise is "every agent session
 * on this machine, wherever it ran".
 *
 * This module is the IO-free half of the evidence for that claim: the host's discovery
 * records, its session metadata, and the verdict on whether the indexer can see each
 * session. It deliberately stops at a verdict. Indexing the host's *transcripts* needs
 * the `turns` / `local_turns` payload shape, and that only a real VS Code session
 * produces — `npm run probe:agent-host` is how that sample gets captured, redacted, and
 * turned into a fixture.
 *
 * Everything here is failure-tolerant for the same reason the provider parsers are: this
 * is another app's internal format. It has already drifted once (see the two discovery
 * shapes below), and an unreadable record is skipped, never thrown.
 */

/**
 * A running agent host, as its own discovery file advertises it.
 *
 * Two shapes coexist on disk today, which is the whole reason this is parsed rather than
 * typed against one layout:
 * - schemaVersion 1 — an array in `local-endpoint/metadata.json`, socket under
 *   `endpointPath`, protocolVersion "0.7.0"
 * - schemaVersion 2 — one object per `local-endpoint/entries/<sha256>.json`, socket under
 *   `endpoint.path`, protocolVersion "0.8.0"
 *
 * Neither is in the published AHP transport spec, which documents WebSocket. This is VS
 * Code's private arrangement and will move again; read it the way the parsers read logs.
 */
export type AgentHostEndpoint = {
  readonly instanceId: string
  readonly pid: number
  readonly socketPath: string
  readonly protocolVersion: string
  readonly schemaVersion: number
}

/** One session in the host's own store, as far as its metadata table states it. */
export type AgentHostSession = {
  readonly id: string
  /** Which provider the host ran, inferred from its metadata key prefix. */
  readonly agent: Provider | null
  readonly title: string | null
  readonly model: string | null
  /** Claude's is `proxy` when the host drives its SDK instead of the CLI. */
  readonly transport: string | null
  readonly customizationDir: string | null
  readonly workspaceless: boolean
  /** null when the count could not be read — unknown, which is not the same as zero. */
  readonly turns: number | null
}

/**
 * What the indexer can see of one host session.
 *
 * `indexed` is the only verdict that proves anything on its own: the id turned up in a
 * provider store, so the session is already in the tree. `invisible` is the honest
 * negative — not visible *under this id* — because a backend that mints its own session
 * id would write a transcript Cockpit indexes under a different one. `empty` is the
 * host's own GC'd husk: nothing was ever said in it, so matching on it proves nothing
 * either way and it must not be counted as a gap.
 */
export type SessionVerdict = 'indexed' | 'invisible' | 'empty'

export type AgentHostCoverage = {
  readonly total: number
  readonly indexed: readonly string[]
  readonly invisible: readonly string[]
  readonly empty: readonly string[]
}

const AGENT_BY_PREFIX: Readonly<Record<string, Provider>> = {
  claude: 'claude',
  codex: 'codex',
  copilot: 'copilot',
  copilotcli: 'copilot'
}

/** One discovery record → an endpoint, or null for a shape we don't recognise. */
export function endpointFromRecord(value: unknown): AgentHostEndpoint | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const r = value as Record<string, unknown>
  const instanceId = typeof r.instanceId === 'string' ? r.instanceId : ''
  const pid = typeof r.pid === 'number' && Number.isInteger(r.pid) && r.pid > 0 ? r.pid : 0
  const socketPath = socketPathOf(r)
  if (!instanceId || !pid || !socketPath) return null
  return {
    instanceId,
    pid,
    socketPath,
    protocolVersion: typeof r.protocolVersion === 'string' ? r.protocolVersion : '',
    schemaVersion: typeof r.schemaVersion === 'number' ? r.schemaVersion : 0
  }
}

function socketPathOf(r: Record<string, unknown>): string {
  const ep = r.endpoint
  if (ep && typeof ep === 'object') {
    const p = (ep as Record<string, unknown>).path
    if (typeof p === 'string' && p) return p
  }
  return typeof r.endpointPath === 'string' ? r.endpointPath : ''
}

/**
 * A discovery file's contents → the endpoints in it. Takes either shape: the legacy file
 * is an array of records, an entries/ file is one record.
 */
export function parseEndpointFile(text: string): AgentHostEndpoint[] {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // mid-write, or not JSON at all — no endpoints, no error
    return []
  }
  const records = Array.isArray(value) ? value : [value]
  const out: AgentHostEndpoint[] = []
  for (const rec of records) {
    const ep = endpointFromRecord(rec)
    if (ep) out.push(ep)
  }
  return out
}

/**
 * Collapse endpoints advertised by both discovery files. One host writes itself into the
 * new entries/ dir *and* the legacy array, so the same instance arrives twice; the higher
 * schemaVersion is the one it maintains.
 */
export function dedupeEndpoints(endpoints: readonly AgentHostEndpoint[]): AgentHostEndpoint[] {
  const best = new Map<string, AgentHostEndpoint>()
  for (const ep of endpoints) {
    const seen = best.get(ep.instanceId)
    if (!seen || ep.schemaVersion > seen.schemaVersion) best.set(ep.instanceId, ep)
  }
  return [...best.values()]
}

/** `file:///Users/me/dev` → `/Users/me/dev`; anything else is left alone. */
export function fileUriToPath(uri: string): string | null {
  if (!uri) return null
  if (!uri.startsWith('file://')) return uri
  try {
    const path = decodeURIComponent(uri.slice('file://'.length))
    return path || null
  } catch {
    return null
  }
}

/**
 * The host's `session_metadata` rows → what Cockpit would need to show the session.
 *
 * Keys are namespaced by the agent that ran (`claude.model`, `claude.transport`), which
 * is the only statement of provider in the store — the session's own id is a bare uuid.
 */
export function sessionFromMetadata(
  id: string,
  rows: readonly (readonly [string, string])[],
  turns: number | null = null
): AgentHostSession {
  const meta = new Map(rows)
  const agent = agentFromKeys([...meta.keys()])
  const prefixed = (suffix: string): string | null => {
    for (const [key, value] of meta) {
      if (key.endsWith(`.${suffix}`) && AGENT_BY_PREFIX[key.slice(0, key.indexOf('.'))]) return value
    }
    return null
  }
  const customizationDir = prefixed('customizationDirectory')
  return {
    id,
    agent,
    title: meta.get('customTitle') || null,
    model: modelOf(prefixed('model')),
    transport: prefixed('transport'),
    customizationDir: customizationDir ? fileUriToPath(customizationDir) : null,
    workspaceless: meta.get('agentHost.workspaceless') === 'true',
    turns
  }
}

function agentFromKeys(keys: readonly string[]): Provider | null {
  for (const key of keys) {
    const dot = key.indexOf('.')
    if (dot <= 0) continue
    const agent = AGENT_BY_PREFIX[key.slice(0, dot)]
    if (agent) return agent
  }
  return null
}

/** Claude states its model as `{"id":"..."}`; other agents may state a bare string. */
function modelOf(raw: string | null): string | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') {
      const id = (parsed as Record<string, unknown>).id
      return typeof id === 'string' && id ? id : null
    }
  } catch {
    // not JSON — the value itself is the model
  }
  return raw
}

/**
 * The evaluation: how much of the agent host's own store the indexer already covers.
 *
 * `indexedNativeIds` is what the provider stores hold, so a hit is proof of visibility.
 * A miss is only evidence — see `SessionVerdict` — which is why the probe prints the
 * host's sessions next to what the provider stores wrote at the same time, and why an
 * empty session is reported apart from the gap rather than inside it.
 */
export function judgeCoverage(
  sessions: readonly AgentHostSession[],
  indexedNativeIds: ReadonlySet<string>
): AgentHostCoverage {
  const indexed: string[] = []
  const invisible: string[] = []
  const empty: string[] = []
  for (const s of sessions) {
    if (s.turns === 0) empty.push(s.id)
    else if (indexedNativeIds.has(s.id)) indexed.push(s.id)
    else invisible.push(s.id)
  }
  return { total: sessions.length, indexed, invisible, empty }
}

/**
 * What a `local_turns` payload is shaped like, with nothing that was said in it.
 *
 * The host stores a turn as opaque JSON, and a parser for it cannot be written without a
 * real sample — but a real sample is someone's prompts, their file contents and their
 * tool output, which must not land in a fixture or a bug report. So the probe captures
 * paths and leaf *types* only: `requests[].message.role: string` tells a future parser
 * everything it needs and carries nothing the user typed.
 *
 * Keys are themselves data when an object is used as a map — a payload keyed by file
 * path would leak the paths — so only identifier-shaped keys are recorded and anything
 * else collapses to `<dynamic>`.
 */
const IDENTIFIER_KEY = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/
const MAX_PATH_DEPTH = 8
const MAX_PATHS = 500

export function payloadKeyPaths(text: string): string[] {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return []
  }
  const paths = new Set<string>()
  walkShape(value, '', paths)
  return [...paths].sort()
}

function walkShape(value: unknown, prefix: string, out: Set<string>): void {
  if (out.size >= MAX_PATHS || prefix.split('.').length > MAX_PATH_DEPTH) return
  if (Array.isArray(value)) {
    // one entry stands for the array: a turn's items are homogeneous, and walking all of
    // them would only multiply the same paths
    if (value.length) walkShape(value[0], `${prefix}[]`, out)
    else out.add(`${prefix}[]: empty`)
    return
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      const safe = IDENTIFIER_KEY.test(key) ? key : '<dynamic>'
      walkShape(child, prefix ? `${prefix}.${safe}` : safe, out)
      if (out.size >= MAX_PATHS) return
    }
    return
  }
  out.add(`${prefix}: ${value === null ? 'null' : typeof value}`)
}
