import type { McpConfig, McpRawDefinitions, Provider } from '../shared/types'
import {
  assignPath,
  isTomlTable,
  scanToml,
  tomlKey,
  tomlKeyPath,
  tomlString,
  tomlValue,
  type TomlKeyValue,
  type TomlSection,
  type TomlSpan,
  type TomlValue
} from './toml'

/*
 * The IO-free half of extensions.ts: one MCP server's definition, read out of an
 * agent's own config and written back into it.
 *
 * Each agent keeps more than Cockpit compares — an http server's headers, Copilot's
 * tools allowlist, Codex's timeouts and tool filters — so a write never rebuilds a
 * definition out of the compared fields. It starts from what the agent holds (its JSON
 * object, or the TOML text of its tables), rewrites only the compared fields that
 * differ, and leaves every other key as it was, the ones Cockpit has never heard of
 * included. Only an agent with no definition of its own gets one built from scratch.
 */

/* ---------- the compared view ---------- */

/**
 * One server as the agent wrote it, keeping only fields of the shape Cockpit reads.
 * These files are hand-edited: a `command` written as an array or an `env` that is a
 * string would otherwise reach code that calls string methods on them, and one such
 * entry used to take the whole Agents panel down with it.
 */
export function normalizeMcp(cfg: any): McpConfig {
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  const env =
    cfg?.env && typeof cfg.env === 'object' && !Array.isArray(cfg.env)
      ? Object.fromEntries(
          Object.entries<unknown>(cfg.env).filter((kv): kv is [string, string] => typeof kv[1] === 'string')
        )
      : undefined
  return {
    command: str(cfg?.command),
    args: Array.isArray(cfg?.args) ? cfg.args.filter((a: unknown) => typeof a === 'string') : undefined,
    env,
    url: str(cfg?.url),
    type: str(cfg?.type)
  }
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** What a stored definition runs, in the view the agents are compared on. */
export function rawMcpConfig(
  raw: McpRawDefinitions | undefined,
  agent: Provider,
  name: string
): McpConfig | undefined {
  if (agent === 'codex') return raw?.codex === undefined ? undefined : parseCodexMcpToml(raw.codex).get(name)
  const own = raw?.[agent]
  return own === undefined ? undefined : normalizeMcp(own)
}

function sameList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const x = a ?? []
  const y = b ?? []
  return x.length === y.length && x.every((v, i) => v === y[i])
}

function sameMap(
  a: Readonly<Record<string, string>> | undefined,
  b: Readonly<Record<string, string>> | undefined
): boolean {
  const x = Object.entries(a ?? {})
  const y = b ?? {}
  return (
    x.length === Object.keys(y).length &&
    x.every(([k, v]) => Object.prototype.hasOwnProperty.call(y, k) && y[k] === v)
  )
}

/** How a server is reached, compared the way `mcpFields` compares it: a local one has no transport. */
function transport(cfg: McpConfig): string {
  return cfg.url ? (cfg.type ?? 'http') : ''
}

/* ---------- Claude Code and Copilot: JSON ---------- */

export type JsonAgent = Exclude<Provider, 'codex'>

/**
 * A server's JSON for Claude Code's or Copilot's config. `base` is what that agent
 * holds — or held, before it was switched off.
 */
export function mcpJsonFor(agent: JsonAgent, cfg: McpConfig, base: unknown): Record<string, unknown> {
  if (isPlainObject(base)) return patchMcpJson(base, cfg, agent)
  return agent === 'claude' ? mcpForClaude(cfg) : mcpForCopilot(cfg)
}

/** The shape claude stores a server in — the same at user and project scope. */
function mcpForClaude(cfg: McpConfig): Record<string, unknown> {
  return cfg.url
    ? { type: cfg.type === 'sse' ? 'sse' : 'http', url: cfg.url }
    : { command: cfg.command, args: cfg.args ?? [], ...(cfg.env ? { env: cfg.env } : {}) }
}

function mcpForCopilot(cfg: McpConfig): Record<string, unknown> {
  return cfg.url
    ? { type: cfg.type ?? 'http', url: cfg.url, tools: ['*'] }
    : { command: cfg.command, args: cfg.args ?? [], tools: ['*'], ...(cfg.env ? { env: cfg.env } : {}) }
}

function patchMcpJson(
  base: Readonly<Record<string, unknown>>,
  cfg: McpConfig,
  agent: JsonAgent
): Record<string, unknown> {
  const had = normalizeMcp(base)
  const out: Record<string, unknown> = { ...base }
  const put = (key: string, value: unknown): void => {
    if (value === undefined) delete out[key]
    else out[key] = value
  }
  if (had.command !== cfg.command) put('command', cfg.command)
  // a remote server launches nothing, so it has no arguments to keep
  if (!sameList(had.args, cfg.args)) put('args', cfg.command === undefined ? undefined : [...(cfg.args ?? [])])
  if (!sameMap(had.env, cfg.env)) put('env', cfg.env && Object.keys(cfg.env).length > 0 ? { ...cfg.env } : undefined)
  if (had.url !== cfg.url) put('url', cfg.url)
  if (transport(had) !== transport(cfg)) put('type', jsonTransport(cfg, agent, base['type']))
  return out
}

/**
 * The `type` a JSON config gives a server. Claude Code knows `http` and `sse`; a local
 * server keeps whatever its agent calls one (`stdio`, Copilot's `local`) — a remote
 * transport left on it would send the agent looking for a url.
 */
function jsonTransport(cfg: McpConfig, agent: JsonAgent, had: unknown): string | undefined {
  if (cfg.url) return agent === 'claude' ? (cfg.type === 'sse' ? 'sse' : 'http') : (cfg.type ?? 'http')
  return had === 'stdio' || had === 'local' ? had : undefined
}

/**
 * IO-free core of claude/copilot removal: delete the server from a parsed
 * config object. projectPath targets claude's projects[<path>].mcpServers.
 */
export function removeMcpFromJson(j: any, name: string, projectPath?: string): void {
  const table = projectPath ? j?.projects?.[projectPath]?.mcpServers : j?.mcpServers
  if (!table || typeof table !== 'object' || !(name in table)) {
    throw new Error(
      projectPath ? `"${name}" not configured for project ${projectPath}` : `"${name}" not found`
    )
  }
  delete table[name]
}

/* ---------- Codex: TOML ---------- */

/*
 * Codex's config.toml can say one server in several ways, and all of them count: its
 * own `[mcp_servers.<name>]` table, subtables like `[mcp_servers.<name>.env]`, inline
 * tables (`env = { KEY = "v" }`, the form Codex's docs show), and dotted keys written
 * from a table above it. Reading only some of them showed a server with its env
 * missing; removing only some of them left half a server that made Codex refuse the
 * whole file.
 */

/** The server a key path is part of: `mcp_servers.<name>…`. */
function serverOf(path: readonly string[]): string | undefined {
  return path.length >= 2 && path[0] === 'mcp_servers' ? path[1] : undefined
}

type ServerParts = {
  /** its own tables: `[mcp_servers.<name>]` and every `[mcp_servers.<name>.…]` */
  readonly tables: TomlSection[]
  /** its keys written from a table above it — `x.command = …` under `[mcp_servers]` */
  readonly strays: Array<{ readonly path: readonly string[]; readonly kv: TomlKeyValue }>
}

function locateServers(sections: readonly TomlSection[]): Map<string, ServerParts> {
  const out = new Map<string, ServerParts>()
  const partsOf = (name: string): ServerParts => {
    const found = out.get(name) ?? { tables: [], strays: [] }
    out.set(name, found)
    return found
  }
  for (const section of sections) {
    // an array of tables is not how Codex spells a server
    if (section.array) continue
    const own = serverOf(section.path)
    if (own !== undefined) {
      partsOf(own).tables.push(section)
      continue
    }
    for (const kv of section.keys) {
      const path = [...section.path, ...kv.key]
      const name = serverOf(path)
      if (name !== undefined) partsOf(name).strays.push({ path, kv })
    }
  }
  return out
}

/** Everything a server's parts say, as one table. */
function serverTable(parts: ServerParts): Record<string, TomlValue> {
  const table: Record<string, TomlValue> = {}
  for (const section of parts.tables) {
    for (const kv of section.keys) {
      if (kv.value !== undefined) assignPath(table, [...section.path.slice(2), ...kv.key], kv.value)
    }
  }
  for (const { path, kv } of parts.strays) {
    const rel = path.slice(2)
    if (kv.value === undefined) continue
    if (rel.length > 0) assignPath(table, rel, kv.value)
    else if (isTomlTable(kv.value)) for (const [k, v] of Object.entries(kv.value)) assignPath(table, [k], v)
  }
  return table
}

/** Text that ends its last line. */
function lined(s: string): string {
  return s === '' || s.endsWith('\n') ? s : s + '\n'
}

/**
 * One server as standalone TOML: its own table, then the keys written for it from a
 * table above (moved in as that table's own), then its subtables — each exactly as it
 * was written, comments included. For a server kept in one block, that is the block,
 * byte for byte.
 */
function serverText(text: string, name: string, parts: ServerParts): string {
  const strays = parts.strays.flatMap(({ path, kv }) => {
    const rel = path.slice(2)
    if (rel.length > 0) return [`${tomlKeyPath(rel)} = ${text.slice(kv.valueSpan.start, kv.valueSpan.end)}\n`]
    // the whole server as one inline table: its entries become the table's own keys
    return isTomlTable(kv.value) ? Object.entries(kv.value).map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}\n`) : []
  })
  const main = parts.tables.find((t) => t.path.length === 2)
  let head = `[mcp_servers.${tomlKey(name)}]\n${strays.join('')}`
  if (main) {
    const tail = main.keys.at(-1)?.end ?? main.bodyStart
    head = lined(text.slice(main.start, tail)) + strays.join('') + text.slice(tail, main.end)
  }
  const subtables = parts.tables.filter((t) => t.path.length > 2).map((t) => text.slice(t.start, t.end))
  return [head, ...subtables].map(lined).join('')
}

/** Every server in a config.toml: the view Cockpit compares, and its own text. */
export function codexMcpServers(text: string): Map<string, { config: McpConfig; raw: string }> {
  const out = new Map<string, { config: McpConfig; raw: string }>()
  for (const [name, parts] of locateServers(scanToml(text))) {
    out.set(name, { config: normalizeMcp(serverTable(parts)), raw: serverText(text, name, parts) })
  }
  return out
}

export function parseCodexMcpToml(text: string): Map<string, McpConfig> {
  const out = new Map<string, McpConfig>()
  for (const [name, parts] of locateServers(scanToml(text))) out.set(name, normalizeMcp(serverTable(parts)))
  return out
}

/** One server's own text out of a config.toml — null when the file doesn't define it. */
export function codexServerText(text: string, name: string): string | null {
  const parts = locateServers(scanToml(text)).get(name)
  return parts ? serverText(text, name, parts) : null
}

function tomlList(items: readonly string[]): string {
  return `[${items.map(tomlString).join(', ')}]`
}

/** A server Codex has never had: the compared fields, and nothing else to keep. */
export function freshCodexServer(name: string, cfg: McpConfig): string {
  const key = `mcp_servers.${tomlKey(name)}`
  const lines = [`[${key}]`]
  if (cfg.url) lines.push(`url = ${tomlString(cfg.url)}`)
  else if (cfg.command) lines.push(`command = ${tomlString(cfg.command)}`, `args = ${tomlList(cfg.args ?? [])}`)
  else throw new Error('server has neither command nor url')
  const env = Object.entries(cfg.env ?? {})
  if (env.length > 0) lines.push('', `[${key}.env]`, ...env.map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`))
  return lines.join('\n') + '\n'
}

type Edit = TomlSpan & { readonly text: string }

/** Splice edits into the text; edits at one position land in the order they were made. */
function applyEdits(text: string, edits: readonly Edit[]): string {
  // Array.prototype.sort is stable, which is what keeps that order
  const sorted = [...edits].sort((a, b) => a.start - b.start)
  let out = ''
  let at = 0
  for (const edit of sorted) {
    if (edit.start < at) continue
    out += text.slice(at, edit.start) + edit.text
    at = edit.end
  }
  return out + text.slice(at)
}

const cut = (span: TomlSpan): Edit => ({ start: span.start, end: span.end, text: '' })

/**
 * `server` — one server's standalone TOML, as `codexServerText` returns it — with the
 * compared fields that differ from `cfg` rewritten, each where it is written and in
 * the form it is written in. A version bump rewrites one string inside `args`. Keys
 * Cockpit doesn't compare (`startup_timeout_sec`, `enabled_tools`, `http_headers`, a
 * `tools` subtable) are never touched.
 */
export function patchCodexServer(server: string, name: string, cfg: McpConfig): string {
  const parts = locateServers(scanToml(server)).get(name)
  const main = parts?.tables.find((t) => t.path.length === 2)
  if (!parts || !main) return freshCodexServer(name, cfg)
  const had = normalizeMcp(serverTable(parts))
  const edits: Edit[] = []
  const own = (field: string): TomlKeyValue | undefined =>
    main.keys.find((kv) => kv.key.length === 1 && kv.key[0] === field)
  // new keys go after the table's last one, ahead of any comment or blank line closing it
  const tail = main.keys.at(-1)?.end ?? main.bodyStart
  const append = (lines: string): void => {
    edits.push({ start: tail, end: tail, text: (server[tail - 1] === '\n' ? '' : '\n') + lines })
  }

  for (const field of ['command', 'url'] as const) {
    const next = cfg[field]
    if (had[field] === next) continue
    const kv = own(field)
    if (kv && next !== undefined) edits.push({ ...kv.valueSpan, text: tomlString(next) })
    else if (kv) edits.push(cut(kv))
    else if (next !== undefined) append(`${field} = ${tomlString(next)}\n`)
  }

  if (!sameList(had.args, cfg.args)) {
    const next = cfg.args ?? []
    const kv = own('args')
    const was = kv?.value
    const items = kv?.items
    if (kv && cfg.command === undefined) edits.push(cut(kv))
    else if (
      kv &&
      items &&
      Array.isArray(was) &&
      was.length === next.length &&
      was.every((v) => typeof v === 'string')
    ) {
      // the same number of arguments: only the ones that changed are rewritten
      next.forEach((arg, i) => {
        if (was[i] !== arg) edits.push({ ...items[i], text: tomlString(arg) })
      })
    } else if (kv) edits.push({ ...kv.valueSpan, text: tomlList(next) })
    else if (next.length > 0) append(`args = ${tomlList(next)}\n`)
  }

  if (!sameMap(had.env, cfg.env)) {
    const next = Object.entries(cfg.env ?? {})
    const pairs = (prefix: string): string =>
      next.map(([k, v]) => `${prefix}${tomlKey(k)} = ${tomlString(v)}\n`).join('')
    const inline = own('env')
    const dotted = main.keys.filter((kv) => kv.key.length > 1 && kv.key[0] === 'env')
    const tables = parts.tables.filter((t) => t.path.length > 2 && t.path[2] === 'env')
    const table = tables.find((t) => t.path.length === 3)
    // every place the old env was written goes; the new one is written where the
    // first of them was, in the same form — or as a subtable when there was none
    if (inline) {
      const entries = next.map(([k, v]) => `${tomlKey(k)} = ${tomlString(v)}`).join(', ')
      edits.push(next.length > 0 ? { ...inline.valueSpan, text: `{ ${entries} }` } : cut(inline))
    }
    dotted.forEach((kv, i) => edits.push({ ...cut(kv), text: i === 0 && !inline ? pairs('env.') : '' }))
    for (const t of tables) {
      const rewrite = t === table && !inline && dotted.length === 0 && next.length > 0
      // the table keeps its header and spacing; only its keys are rewritten
      if (rewrite) edits.push({ start: t.bodyStart, end: t.keys.at(-1)?.end ?? t.bodyStart, text: pairs('') })
      else edits.push(cut(t))
    }
    if (!inline && dotted.length === 0 && !table && next.length > 0) {
      append(`\n[mcp_servers.${tomlKey(name)}.env]\n${pairs('')}`)
    }
  }
  return applyEdits(server, edits)
}

/**
 * `server` in place of everything the file says about that server — where its own
 * table was, so a patched server doesn't move to the bottom of the user's file — or
 * at the end, for a server the file didn't have.
 */
export function putCodexServer(text: string, name: string, server: string): string {
  const parts = locateServers(scanToml(text)).get(name)
  if (!parts) return appendTable(text, server)
  const first = parts.tables.reduce<TomlSection | undefined>((a, t) => (a && a.start <= t.start ? a : t), undefined)
  const edits = [...parts.tables, ...parts.strays.map((s) => s.kv)].map((span) => ({
    ...cut(span),
    text: span === first ? server : ''
  }))
  const out = applyEdits(text, edits)
  return first ? out : appendTable(out, server)
}

/** A new table at the end of the file, a blank line after whatever was there. */
function appendTable(text: string, table: string): string {
  let end = text.length
  while (end > 0 && (text[end - 1] === '\n' || text[end - 1] === '\r')) end--
  return end === 0 ? table : `${text.slice(0, end)}\n\n${table}`
}

/**
 * IO-free core of codex removal: everything the file says about the server goes —
 * its table, every subtable, keys written for it from a table above — and every other
 * byte stays as it was.
 */
export function removeCodexMcpToml(text: string, name: string): string {
  const parts = locateServers(scanToml(text)).get(name)
  if (!parts) throw new Error(`"${name}" not found in codex config`)
  const spans = [...parts.tables, ...parts.strays.map((s) => s.kv)]
  const out = applyEdits(text, spans.map(cut))
  // the last table gone leaves the one before it ending the file on a blank line
  return spans.some((s) => s.end === text.length) ? out.replace(/\n+$/, '\n') : out
}
