import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execText } from './env'
import {
  dedupeEndpoints,
  judgeCoverage,
  parseEndpointFile,
  payloadKeyPaths,
  sessionFromMetadata,
  type AgentHostCoverage,
  type AgentHostEndpoint,
  type AgentHostSession
} from './agent-host-core'

export type { AgentHostCoverage, AgentHostEndpoint, AgentHostSession } from './agent-host-core'

/**
 * The IO half of reading VS Code's agent host — see `agent-host-core.ts` for what the
 * host is and why Cockpit looks at it at all.
 *
 * Every read here is bounded and best-effort, for the same reason the session parsers
 * are: this is another app's private store, it is written while we read it, and its
 * layout has already changed once. A store we cannot read reports nothing; it never
 * throws and it never blocks a scan.
 */

/** Discovery records are a few hundred bytes; anything larger is not one. */
const MAX_ENDPOINT_BYTES = 64 * 1024
/** A stale entries/ dir is still bounded work. */
const MAX_ENDPOINT_ENTRIES = 256
/** One spawn per session, so cap the sweep rather than the store. */
const MAX_SESSION_DIRS = 500
const SQLITE_TIMEOUT_MS = 5000

export type AgentHostReport = {
  readonly home: string
  readonly present: boolean
  readonly endpoints: readonly AgentHostEndpoint[]
  readonly sessions: readonly AgentHostSession[]
  /** true when the store held more sessions than MAX_SESSION_DIRS. */
  readonly truncated: boolean
}

/**
 * VS Code user-data directories on macOS. Cockpit is macOS-only, and the agent host
 * lives under the editor's own user data — Insiders keeps a separate one, and people who
 * run both have two hosts and two stores.
 */
export function defaultAgentHostHomes(): string[] {
  const base = join(homedir(), 'Library', 'Application Support')
  return ['Code', 'Code - Insiders'].map((d) => join(base, d))
}

/**
 * Hosts currently accepting clients.
 *
 * Both discovery files are read and merged, because a machine that has run more than one
 * VS Code build carries both shapes. Records outlive the process that wrote them — the
 * legacy file here still lists four dead editors — so the pid is the evidence, exactly as
 * it is for Copilot's session locks: a record whose process is gone is not an endpoint.
 */
export async function readEndpoints(home: string): Promise<AgentHostEndpoint[]> {
  const dir = join(home, 'agent-host', 'local-endpoint')
  const found: AgentHostEndpoint[] = []
  const legacy = await readBounded(join(dir, 'metadata.json'))
  if (legacy) found.push(...parseEndpointFile(legacy))
  let names: string[] = []
  try {
    names = (await readdir(join(dir, 'entries'))).filter((n) => n.endsWith('.json'))
  } catch {
    // no entries/ dir — an older host, or none has run
  }
  for (const name of names.slice(0, MAX_ENDPOINT_ENTRIES)) {
    const text = await readBounded(join(dir, 'entries', name))
    if (text) found.push(...parseEndpointFile(text))
  }
  return dedupeEndpoints(found).filter((ep) => pidAlive(ep.pid))
}

/** The sessions the host keeps, as far as each one's own metadata states them. */
export async function readSessions(home: string): Promise<{
  readonly sessions: AgentHostSession[]
  readonly truncated: boolean
}> {
  const dir = join(home, 'agentSessionData')
  let ids: string[] = []
  try {
    ids = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return { sessions: [], truncated: false }
  }
  const truncated = ids.length > MAX_SESSION_DIRS
  const sessions: AgentHostSession[] = []
  for (const id of ids.slice(0, MAX_SESSION_DIRS)) {
    const session = await readSession(join(dir, id, 'session.db'), id)
    if (session) sessions.push(session)
  }
  return { sessions, truncated }
}

async function readSession(db: string, id: string): Promise<AgentHostSession | null> {
  const meta = await sqliteRows(db, 'SELECT key, value FROM session_metadata')
  if (!meta) return null
  const rows = meta
    .map((r) => [String(r.key ?? ''), String(r.value ?? '')] as const)
    .filter(([key]) => key !== '')
  const counted = await sqliteRows(db, 'SELECT COUNT(*) AS n FROM turns')
  const n = counted?.[0]?.n
  const turns = typeof n === 'number' ? n : typeof n === 'string' ? Number(n) : null
  return sessionFromMetadata(id, rows, Number.isFinite(turns) ? (turns as number) : null)
}

/**
 * One query against the host's store. `-json` keeps values that contain the default
 * separator — every metadata value here is JSON — from being mis-split, and `-readonly`
 * keeps a live editor's db untouched. null means the read failed (locked, absent,
 * a table this schema version does not have): unknown, never an empty result.
 */
async function sqliteRows(db: string, sql: string): Promise<Record<string, unknown>[] | null> {
  const r = await execText('sqlite3', ['-readonly', '-json', db, sql], {
    timeoutMs: SQLITE_TIMEOUT_MS
  })
  if (!r.ok) return null
  const text = r.stdout.trim()
  if (!text) return []
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : null
  } catch {
    return null
  }
}

async function readBounded(file: string): Promise<string | null> {
  try {
    if ((await stat(file)).size > MAX_ENDPOINT_BYTES) return null
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * Is the process that advertised this endpoint still there? A pid we may not signal is
 * not ours but a recycled one, so it counts as gone — the same rule the Copilot locks
 * get in `liveness.ts`.
 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** One VS Code user-data dir, read end to end. */
export async function probeAgentHost(home: string): Promise<AgentHostReport> {
  const [endpoints, { sessions, truncated }] = await Promise.all([
    readEndpoints(home),
    readSessions(home)
  ])
  return {
    home,
    present: endpoints.length > 0 || sessions.length > 0,
    endpoints,
    sessions,
    truncated
  }
}

/**
 * The verdict for one report against what the indexer holds. Kept here so the probe
 * script and any future indexer source ask the same question the tests do.
 */
export function coverageFor(
  report: AgentHostReport,
  indexedNativeIds: ReadonlySet<string>
): AgentHostCoverage {
  return judgeCoverage(report.sessions, indexedNativeIds)
}

/** A store's layout, with nothing anybody said in it — see `payloadKeyPaths`. */
export type StoreShape = {
  readonly tables: readonly StoreTable[]
  readonly metadataKeys: readonly string[]
  readonly payloadKeys: readonly string[]
}

export type StoreTable = {
  readonly name: string
  readonly columns: readonly string[]
  readonly rows: number
}

/** Turn payloads are sampled, not swept: they are large, and one states the shape. */
const SHAPE_PAYLOAD_SAMPLE = 5
/** A table name is interpolated into SQL, so only ordinary identifiers are described. */
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/

/**
 * Describe one session store so a parser can be written against it later.
 *
 * This exists because the gap it measures cannot be *closed* from what is on this
 * machine: `turns` and `local_turns` are opaque JSON, and an empty store — the host GCs
 * sessions nobody used — says nothing about their shape. So the probe captures the shape
 * of a real one, redacted, and that becomes the fixture. Returns null when the store
 * cannot be read at all.
 */
export async function describeStore(db: string): Promise<StoreShape | null> {
  const names = await sqliteRows(db, "SELECT name FROM sqlite_master WHERE type = 'table'")
  if (!names) return null
  const tables: StoreTable[] = []
  for (const row of names) {
    const name = String(row.name ?? '')
    if (!SQL_IDENTIFIER.test(name)) continue
    const info = await sqliteRows(db, `PRAGMA table_info("${name}")`)
    const counted = await sqliteRows(db, `SELECT COUNT(*) AS n FROM "${name}"`)
    const n = counted?.[0]?.n
    tables.push({
      name,
      columns: (info ?? []).map((c) => String(c.name ?? '')),
      rows: typeof n === 'number' ? n : Number(n ?? 0) || 0
    })
  }
  const keys = await sqliteRows(db, 'SELECT key FROM session_metadata')
  const payloads = await sqliteRows(
    db,
    `SELECT payload FROM local_turns LIMIT ${SHAPE_PAYLOAD_SAMPLE}`
  )
  const payloadKeys = new Set<string>()
  for (const row of payloads ?? []) {
    for (const path of payloadKeyPaths(String(row.payload ?? ''))) payloadKeys.add(path)
  }
  return {
    tables,
    metadataKeys: (keys ?? []).map((k) => String(k.key ?? '')).filter(Boolean).sort(),
    payloadKeys: [...payloadKeys].sort()
  }
}
