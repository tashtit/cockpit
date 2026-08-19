import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  ExtensionsInventory,
  MarketplaceInfo,
  McpConfig,
  McpPresence,
  McpServerInfo,
  Mutable,
  PluginInfo,
  Provider,
  SkillInfo,
  SyncKind,
  SyncRequest
} from '../shared/types'
import { cliEnv, execText } from './env'
import { readJsoncFile } from './parsers/util'

/*
 * Each agent stores MCP servers in its own format:
 *   claude  — ~/.claude.json                { "mcpServers": { name: {command,args,env,type,url} } }
 *   codex   — ~/.codex/config.toml          [mcp_servers.name] command/args/url (+ .env subtable)
 *   copilot — ~/.copilot/mcp-config.json    { "mcpServers": { name: {command,args,tools,type,url} } }
 * Sharing = translating one definition into the target agent's format.
 */

const claudeJsonPath = (): string => join(homedir(), '.claude.json')
const codexTomlPath = (): string => join(homedir(), '.codex', 'config.toml')
const copilotJsonPath = (): string => join(homedir(), '.copilot', 'mcp-config.json')

/*
 * Skills, plugins and marketplaces each live somewhere different again:
 *   skills        <home>/skills/<name>/SKILL.md            (all three agents)
 *   plugins       claude  ~/.claude/plugins/installed_plugins.json  keyed <name>@<marketplace>
 *                 codex   ~/.codex/config.toml             [plugins."<name>@<marketplace>"]
 *                 copilot ~/.copilot/installed-plugins/<marketplace>/<name>/
 *   marketplaces  claude  ~/.claude/plugins/known_marketplaces.json
 *                 codex   ~/.codex/config.toml             [marketplaces.<name>]
 *                 copilot the top level of ~/.copilot/installed-plugins/
 * Plugin ids are `<name>@<marketplace>` everywhere, so the three inventories line up.
 */
/** Resolved per call, like every other path here, so a test can point HOME elsewhere. */
const skillDir = (agent: Provider): string =>
  join(homedir(), agent === 'claude' ? '.claude' : agent === 'codex' ? '.codex' : '.copilot', 'skills')

const copilotPluginsDir = (): string => join(homedir(), '.copilot', 'installed-plugins')

/**
 * These are the same hand-editable configs accounts.ts reads, so they get the same
 * JSONC tolerance — parsing ~/.claude.json strictly here meant one `//` comment
 * showed the account fine but silently emptied the MCP inventory.
 */
const readJsonFile = readJsoncFile

/* ---------- readers ---------- */

/** Scope without the agent — the agent is attached when inventories merge. */
type FoundScope = Omit<McpPresence, 'agent'>

type FoundServer = {
  /** every place this agent defines the server, each with its own definition */
  readonly scopes: FoundScope[]
}

function normalizeMcp(cfg: any): McpConfig {
  return {
    command: cfg?.command,
    args: Array.isArray(cfg?.args) ? cfg.args : undefined,
    env: cfg?.env,
    url: cfg?.url,
    type: cfg?.type
  }
}

function addFound(
  out: Map<string, FoundServer>,
  name: string,
  found: { readonly cfg: any; readonly scope: Omit<FoundScope, 'config'> }
): void {
  const { cfg, scope } = found
  const entry: FoundScope = { ...scope, config: normalizeMcp(cfg) }
  const existing = out.get(name)
  if (!existing) {
    out.set(name, { scopes: [entry] })
    return
  }
  if (!existing.scopes.some((s) => s.scope === scope.scope && s.projectPath === scope.projectPath)) {
    existing.scopes.push(entry)
  }
}

/**
 * Claude keeps user-level servers at the top of ~/.claude.json AND per-project
 * ones under projects[<path>].mcpServers — most real setups only have the latter.
 */
function readClaudeMcp(): Map<string, FoundServer> {
  const out = new Map<string, FoundServer>()
  const j = readJsonFile(claudeJsonPath())
  const servers = j?.mcpServers
  if (servers && typeof servers === 'object') {
    for (const [name, cfg] of Object.entries<any>(servers)) {
      addFound(out, name, { cfg, scope: { scope: 'user' } })
    }
  }
  const projects = j?.projects
  if (projects && typeof projects === 'object') {
    for (const [projPath, proj] of Object.entries<any>(projects)) {
      const ps = proj?.mcpServers
      if (!ps || typeof ps !== 'object') continue
      for (const [name, cfg] of Object.entries<any>(ps)) {
        addFound(out, name, { cfg, scope: { scope: 'project', projectPath: projPath } })
      }
    }
  }
  return out
}

/** A TOML key can only be bare if it matches this — anything else must be quoted. */
const BARE_TOML_KEY = /^[A-Za-z0-9_-]+$/

/**
 * Server name out of an `mcp_servers.<key>` section header (brackets stripped).
 * Names with dots must be quoted, or TOML reads `a.b` as a nested table — which
 * both renames the server for codex and hides it from this parser.
 */
function mcpSectionName(header: string): { name: string; isEnv: boolean } | null {
  const m = header.match(/^mcp_servers\.(?:([A-Za-z0-9_-]+)|"((?:[^"\\]|\\.)*)")(\.env)?$/)
  if (!m) return null
  return { name: m[1] ?? m[2].replace(/\\(.)/g, '$1'), isEnv: Boolean(m[3]) }
}

/** Minimal TOML reader for the [mcp_servers.*] sections codex writes. */
export function parseCodexMcpToml(raw: string): Map<string, McpConfig> {
  // entries are assembled across multiple TOML sections, so they stay mutable here
  const out = new Map<string, Mutable<McpConfig>>()
  const sections = raw.split(/^\[/m)
  for (const section of sections) {
    const close = section.indexOf(']')
    if (close === -1) continue
    const header = mcpSectionName(section.slice(0, close).trim())
    if (!header) continue
    const name = header.name
    const body = section.slice(close + 1)
    const entry = out.get(name) ?? {}
    if (header.isEnv) {
      // env subtable
      const env: Record<string, string> = { ...entry.env }
      for (const m of body.matchAll(/^([A-Za-z0-9_]+)\s*=\s*"((?:[^"\\]|\\.)*)"/gm)) {
        env[m[1]] = m[2]
      }
      entry.env = env
    } else {
      const str = (key: string): string | undefined =>
        body.match(new RegExp(`^${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'm'))?.[1]
      entry.command = str('command') ?? entry.command
      entry.url = str('url') ?? entry.url
      const argsRaw = body.match(/^args\s*=\s*\[([\s\S]*?)\]/m)?.[1]
      if (argsRaw !== undefined) {
        entry.args = [...argsRaw.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1])
      }
    }
    out.set(name, entry)
  }
  return out
}

function readCodexMcp(): Map<string, McpConfig> {
  try {
    return parseCodexMcpToml(readFileSync(codexTomlPath(), 'utf8'))
  } catch {
    return new Map()
  }
}

function readCopilotMcp(): Map<string, McpConfig> {
  const out = new Map<string, McpConfig>()
  const j = readJsonFile(copilotJsonPath())
  const servers = j?.mcpServers
  if (servers && typeof servers === 'object') {
    for (const [name, cfg] of Object.entries<any>(servers)) {
      out.set(name, {
        command: cfg?.command,
        args: Array.isArray(cfg?.args) ? cfg.args : undefined,
        env: cfg?.env,
        url: cfg?.url,
        type: cfg?.type
      })
    }
  }
  return out
}

/* ---------- skills / plugins / marketplaces ---------- */

/** Bounded read: SKILL.md is prose, and only its first KBs decide the fingerprint. */
const MAX_SKILL_BYTES = 64 * 1024

function readSkills(): SkillInfo[] {
  const out: SkillInfo[] = []
  for (const agent of ['claude', 'codex', 'copilot'] as Provider[]) {
    const dir = skillDir(agent)
    if (!existsSync(dir)) continue
    let entries: string[] = []
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of entries) {
      const skillMd = join(dir, name, 'SKILL.md')
      if (!existsSync(skillMd)) continue
      let description = ''
      let fingerprint = ''
      try {
        const raw = readFileSync(skillMd, 'utf8').slice(0, MAX_SKILL_BYTES)
        description = raw.match(/^description:\s*(.+)$/m)?.[1]?.slice(0, 200) ?? ''
        fingerprint = createHash('sha256').update(raw).digest('hex').slice(0, 16)
      } catch {
        /* unreadable — list it anyway, with no fingerprint to compare on */
      }
      out.push({ name, description, agent, path: join(dir, name), fingerprint })
    }
  }
  return out
}

/**
 * Plugin/marketplace fields drift across Claude releases: a value that used to be a
 * plain string can arrive as an object (`{source: 'github', repo}` /
 * `{source: 'git', url}` / `{source: 'directory', path}`). Reduce anything to a
 * human string — an object must never reach the UI as "[object Object]".
 */
function sourceLabel(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number') return String(v)
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    for (const k of ['repo', 'url', 'path', 'source']) {
      const inner = o[k]
      if (typeof inner === 'string') return inner
      if (k === 'source' && inner && typeof inner === 'object') return sourceLabel(inner)
    }
  }
  return ''
}

/** `name@marketplace` split — the id every agent uses for a plugin. */
function splitPluginId(id: string): { name: string; marketplace?: string } {
  const at = id.lastIndexOf('@')
  return at > 0 ? { name: id.slice(0, at), marketplace: id.slice(at + 1) } : { name: id }
}

/**
 * Top-level `[plugins."<id>"]` / `[marketplaces.<name>]` sections of codex's config.
 * Values are read per section; a nested `[marketplaces.x.y]` is not a marketplace.
 */
export function parseCodexSections(raw: string, table: string): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>()
  const header = new RegExp(`^${table}\\.(?:([A-Za-z0-9_-]+)|"((?:[^"\\\\]|\\\\.)*)")$`)
  for (const section of raw.split(/^\[/m)) {
    const close = section.indexOf(']')
    if (close === -1) continue
    const m = section.slice(0, close).trim().match(header)
    if (!m) continue
    const name = m[1] ?? m[2].replace(/\\(.)/g, '$1')
    // the split above already ended this section at the next header
    const body = section.slice(close + 1)
    const fields: Record<string, string> = {}
    for (const kv of body.matchAll(/^([A-Za-z0-9_]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|(\S+))/gm)) {
      fields[kv[1]] = kv[2] ?? kv[3]
    }
    out.set(name, fields)
  }
  return out
}

function readCodexToml(): string {
  try {
    return readFileSync(codexTomlPath(), 'utf8')
  } catch {
    return ''
  }
}

function readDirNames(dir: string): string[] {
  if (!existsSync(dir)) return []
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
  } catch {
    return []
  }
}

function readPlugins(): PluginInfo[] {
  const out: PluginInfo[] = []
  const installed = readJsonFile(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'))
  const plugins = installed?.plugins ?? installed
  if (plugins && typeof plugins === 'object') {
    for (const [id, v] of Object.entries<any>(plugins)) {
      // an id's value can be the record itself or an array of installed versions
      const record = Array.isArray(v) ? v[v.length - 1] : v
      const version = record && typeof record === 'object' ? sourceLabel(record.version) : ''
      const { name, marketplace } = splitPluginId(id)
      out.push({
        name: id,
        agent: 'claude',
        detail: [name, version && `v${version}`].filter(Boolean).join(' '),
        marketplace,
        version: version || undefined
      })
    }
  }
  for (const [id, fields] of parseCodexSections(readCodexToml(), 'plugins')) {
    // codex records no version, only whether the plugin is switched on
    if (fields.enabled === 'false') continue
    const { name, marketplace } = splitPluginId(id)
    out.push({ name: id, agent: 'codex', detail: name, marketplace })
  }
  const copilotDir = copilotPluginsDir()
  for (const marketplace of readDirNames(copilotDir)) {
    for (const name of readDirNames(join(copilotDir, marketplace))) {
      const manifest = readJsonFile(join(copilotDir, marketplace, name, '.claude-plugin', 'plugin.json'))
      const version = typeof manifest?.version === 'string' ? manifest.version : undefined
      out.push({
        name: `${name}@${marketplace}`,
        agent: 'copilot',
        detail: [name, version && `v${version}`].filter(Boolean).join(' '),
        marketplace,
        version
      })
    }
  }
  return out
}

function readMarketplaces(): MarketplaceInfo[] {
  const out: MarketplaceInfo[] = []
  const known = readJsonFile(join(homedir(), '.claude', 'plugins', 'known_marketplaces.json'))
  const entries = known?.marketplaces ?? known
  if (entries && typeof entries === 'object') {
    for (const [name, v] of Object.entries<any>(entries)) {
      const source = typeof v === 'string' ? v : sourceLabel(v?.source) || sourceLabel(v?.url)
      out.push({ name, agent: 'claude', source })
    }
  }
  for (const [name, fields] of parseCodexSections(readCodexToml(), 'marketplaces')) {
    out.push({ name, agent: 'codex', source: fields.source })
  }
  // copilot keeps no registry file: each marketplace is a directory of its plugins
  for (const name of readDirNames(copilotPluginsDir())) {
    out.push({ name, agent: 'copilot' })
  }
  return out
}

/* ---------- inventory ---------- */

export function getExtensions(): ExtensionsInventory {
  const asFound = (servers: Map<string, McpConfig>): Map<string, FoundServer> =>
    new Map([...servers].map(([n, config]) => [n, { scopes: [{ scope: 'user' as const, config }] }]))
  const byAgent: Array<{ agent: Provider; servers: Map<string, FoundServer> }> = [
    { agent: 'claude', servers: readClaudeMcp() },
    { agent: 'codex', servers: asFound(readCodexMcp()) },
    { agent: 'copilot', servers: asFound(readCopilotMcp()) }
  ]
  const merged = new Map<string, McpServerInfo>()
  for (const { agent, servers } of byAgent) {
    for (const [name, found] of servers) {
      const presences = found.scopes.map((s) => ({ agent, ...s }))
      const existing = merged.get(name)
      if (existing) {
        existing.agents.push(agent)
        existing.presences.push(...presences)
      } else {
        merged.set(name, { name, config: presences[0].config, agents: [agent], presences })
      }
    }
  }
  return {
    mcp: [...merged.values()].sort((a, b) => a.name.localeCompare(b.name)),
    skills: readSkills(),
    plugins: readPlugins(),
    marketplaces: readMarketplaces()
  }
}

/* ---------- sharing ---------- */

/** Where a sync copies from, and whether it may replace what the target has. */
export type SyncOptions = Omit<SyncRequest, 'to'>


function findMcp(name: string, from?: Provider): McpConfig {
  const inv = getExtensions()
  const server = inv.mcp.find((s) => s.name === name)
  if (!server) throw new Error(`MCP server not found: ${name}`)
  if (!from) return server.config
  // prefer the source agent's global definition; a project entry is still its answer
  const own = server.presences.filter((p) => p.agent === from)
  const picked = own.find((p) => p.scope === 'user') ?? own[0]
  if (!picked) throw new Error(`${from} has no "${name}" to copy`)
  return picked.config
}

/** Config for a named server, for probing — throws when unknown. */
export function getMcpConfig(name: string): McpConfig {
  return findMcp(name)
}

/**
 * The renderer supplies projectPath — only trust it once it matches a project
 * entry this module itself read from ~/.claude.json.
 */
export function assertClaudeProjectServer(name: string, projectPath: string): string {
  const j = readJsonFile(claudeJsonPath())
  const cfg = j?.projects?.[projectPath]?.mcpServers?.[name]
  if (!cfg) throw new Error(`no project-scoped server "${name}" in ${projectPath}`)
  return projectPath
}

// names become path segments (shareSkill) — dots-only names ("." / "..") would
// escape the skills dir and copy a whole config home, credentials included
const NAME_RE = /^(?!\.+$)[A-Za-z0-9_.-]{1,64}$/

/**
 * Copy a server definition into another agent's config, translated into its format.
 * `from` picks which agent's definition wins when they disagree; `overwrite` replaces
 * what the target already has instead of refusing.
 */
export function shareMcp(name: string, to: Provider, opts: SyncOptions = {}): void {
  if (!NAME_RE.test(name)) throw new Error('invalid server name')
  const cfg = findMcp(name, opts.from)
  if (opts.from === to) throw new Error('source and target are the same agent')
  if (to === 'claude') return shareToClaude(name, cfg)
  if (to === 'codex') return shareToCodex(name, cfg, opts.overwrite)
  return shareToCopilot(name, cfg)
}

function shareToClaude(name: string, cfg: McpConfig): void {
  const path = claudeJsonPath()
  const j = readJsonFile(path) ?? {}
  j.mcpServers = j.mcpServers ?? {}
  j.mcpServers[name] = cfg.url
    ? { type: cfg.type === 'sse' ? 'sse' : 'http', url: cfg.url }
    : { command: cfg.command, args: cfg.args ?? [], ...(cfg.env ? { env: cfg.env } : {}) }
  writeFileSync(path, JSON.stringify(j, null, 2))
}

function tomlString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Quote a server name unless it is a valid bare TOML key (dotted names must be quoted). */
function tomlKey(name: string): string {
  return BARE_TOML_KEY.test(name) ? name : tomlString(name)
}

function shareToCodex(name: string, cfg: McpConfig, overwrite = false): void {
  const path = codexTomlPath()
  let raw = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (parseCodexMcpToml(raw).has(name)) {
    if (!overwrite) throw new Error(`codex already has "${name}"`)
    // claude/copilot rewrite their JSON key in place; codex appends, so the old
    // section (and its subtables) has to go first or the file would define it twice
    raw = removeCodexMcpToml(raw, name)
  }
  let block = `\n[mcp_servers.${tomlKey(name)}]\n`
  if (cfg.url) {
    block += `url = ${tomlString(cfg.url)}\n`
  } else if (cfg.command) {
    block += `command = ${tomlString(cfg.command)}\n`
    block += `args = [${(cfg.args ?? []).map(tomlString).join(', ')}]\n`
  } else {
    throw new Error('server has neither command nor url')
  }
  if (cfg.env && Object.keys(cfg.env).length > 0) {
    block += `\n[mcp_servers.${tomlKey(name)}.env]\n`
    for (const [k, v] of Object.entries(cfg.env)) {
      if (/^[A-Za-z0-9_]+$/.test(k)) block += `${k} = ${tomlString(v)}\n`
    }
  }
  writeFileSync(path, raw.endsWith('\n') || raw === '' ? raw + block : raw + '\n' + block)
}

/* ---------- skill sharing ---------- */

/** Copy a personal skill directory into another agent's skills dir. */
export function shareSkill(name: string, to: Provider, opts: SyncOptions = {}): void {
  if (!NAME_RE.test(name)) throw new Error('invalid skill name')
  const from = opts.from ?? findSkillSource(name, to)
  if (from === to) throw new Error('source and target are the same agent')
  const src = join(skillDir(from), name)
  const dst = join(skillDir(to), name)
  if (!existsSync(src)) throw new Error(`skill not found: ${src}`)
  if (existsSync(dst)) {
    if (!opts.overwrite) throw new Error(`${to} already has "${name}"`)
    rmSync(dst, { recursive: true, force: true })
  }
  mkdirSync(skillDir(to), { recursive: true })
  cpSync(src, dst, { recursive: true })
}

function shareToCopilot(name: string, cfg: McpConfig): void {
  const path = copilotJsonPath()
  const j = readJsonFile(path) ?? {}
  j.mcpServers = j.mcpServers ?? {}
  j.mcpServers[name] = cfg.url
    ? { type: cfg.type ?? 'http', url: cfg.url, tools: ['*'] }
    : {
        command: cfg.command,
        args: cfg.args ?? [],
        tools: ['*'],
        ...(cfg.env ? { env: cfg.env } : {})
      }
  writeFileSync(path, JSON.stringify(j, null, 2))
}

/* ---------- removal ---------- */

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

/**
 * Is this section header the server's own table or one of its subtables? Covers
 * both key spellings (bare and quoted) and every subtable, not just `.env` —
 * leaving `[mcp_servers.x.headers]` behind would hand codex a half-server.
 */
function sectionBelongsTo(section: string, name: string): boolean {
  return [name, tomlString(name)].some((key) => {
    const own = `mcp_servers.${key}`
    return section === own || section.startsWith(own + '.')
  })
}

/**
 * IO-free core of codex removal: drop [mcp_servers.<name>] and its subtables
 * (e.g. .env) from the TOML, leaving every other section byte-identical.
 */
export function removeCodexMcpToml(raw: string, name: string): string {
  if (!parseCodexMcpToml(raw).has(name)) throw new Error(`"${name}" not found in codex config`)
  const lines = raw.split('\n')
  const out: string[] = []
  let dropping = false
  for (const line of lines) {
    // capture up to the first ] and ignore anything after it: a header can carry a
    // trailing inline comment, and a regex anchored at end-of-line would fail to
    // match it, leaving `dropping` stuck and eating the next unrelated section
    const header = line.match(/^\s*\[([^\]]+)\]/)
    if (header) dropping = sectionBelongsTo(header[1].trim(), name)
    if (!dropping) out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n')
}

export function removeMcp(name: string, agent: Provider, projectPath?: string): void {
  if (!NAME_RE.test(name)) throw new Error('invalid server name')
  if (agent === 'codex') {
    const path = codexTomlPath()
    const raw = existsSync(path) ? readFileSync(path, 'utf8') : ''
    writeFileSync(path, removeCodexMcpToml(raw, name))
    return
  }
  const path = agent === 'claude' ? claudeJsonPath() : copilotJsonPath()
  const j = readJsonFile(path)
  if (!j) throw new Error(`cannot read ${path}`)
  removeMcpFromJson(j, name, agent === 'claude' ? projectPath : undefined)
  writeFileSync(path, JSON.stringify(j, null, 2))
}

/* ---------- cross-agent sync ---------- */

/** An agent that already has the skill — sync needs a source, not just a target. */
function findSkillSource(name: string, to: Provider): Provider {
  const from = readSkills().find((sk) => sk.name === name && sk.agent !== to)?.agent
  if (!from) throw new Error(`no agent has a skill named "${name}"`)
  return from
}

/**
 * Plugins and marketplaces are not config entries Cockpit can write: registering one
 * means cloning a repo, resolving a version and updating the agent's own bookkeeping.
 * So Cockpit runs the agent's own CLI, which does all of that correctly.
 */
const PLUGIN_INSTALL: Record<Provider, readonly string[]> = {
  claude: ['plugin', 'install'],
  // codex spells install "add"; every other subcommand matches the other two
  codex: ['plugin', 'add'],
  copilot: ['plugin', 'install']
}

const MARKETPLACE_ADD: readonly string[] = ['plugin', 'marketplace', 'add']

/** Marketplace clones and plugin installs hit the network — give them room. */
const CLI_TIMEOUT_MS = 120_000

async function runAgentCli(agent: Provider, args: readonly string[]): Promise<string> {
  const res = await execText(agent, args, { timeoutMs: CLI_TIMEOUT_MS, env: cliEnv() })
  if (!res.ok) {
    const detail = (res.stderr || res.stdout || res.error || '').trim().split('\n').slice(-3).join(' ')
    throw new Error(`${agent} ${args.join(' ')} failed — ${detail || 'no output'}`)
  }
  return res.stdout.trim()
}

/** Where an agent clones a marketplace from — only some agents record it. */
function marketplaceSource(name: string, exclude: Provider): string {
  const source = readMarketplaces().find(
    (m) => m.name === name && m.agent !== exclude && m.source && !m.source.startsWith('/')
  )?.source
  if (!source) {
    throw new Error(
      `no shareable source recorded for marketplace "${name}" — add it in ${PROVIDER_CLI[exclude]} with its repo or URL`
    )
  }
  return source
}

const PROVIDER_CLI: Record<Provider, string> = { claude: 'claude', codex: 'codex', copilot: 'copilot' }

async function syncMarketplace(name: string, to: Provider): Promise<string> {
  if (!NAME_RE.test(name)) throw new Error('invalid marketplace name')
  const source = marketplaceSource(name, to)
  await runAgentCli(to, [...MARKETPLACE_ADD, source])
  return `Added marketplace "${name}" to ${to} from ${source}.`
}

async function syncPlugin(id: string, to: Provider): Promise<string> {
  const at = id.lastIndexOf('@')
  const marketplace = at > 0 ? id.slice(at + 1) : ''
  if (at <= 0 || !NAME_RE.test(id.slice(0, at)) || !NAME_RE.test(marketplace)) {
    throw new Error(`plugin id must be <name>@<marketplace>: ${id}`)
  }
  const steps: string[] = []
  // the CLI can only install from a marketplace it already knows; registering it
  // first is part of the same "make this agent match" action the user asked for
  if (!readMarketplaces().some((m) => m.name === marketplace && m.agent === to)) {
    steps.push(await syncMarketplace(marketplace, to))
  }
  await runAgentCli(to, [...PLUGIN_INSTALL[to], id])
  steps.push(`Installed "${id}" in ${to}.`)
  return steps.join(' ')
}

/**
 * One entry point for the Compare view: make `to` match the agent that already has
 * the thing. MCP servers and skills are written directly; plugins and marketplaces
 * go through the target agent's CLI. Resolves with a line to show the user.
 */
export async function syncExtension(
  kind: SyncKind,
  name: string,
  req: SyncRequest
): Promise<string> {
  const { to, ...opts } = req
  if (!PROVIDER_CLI[to]) throw new Error(`unknown agent: ${to}`)
  switch (kind) {
    case 'mcp':
      shareMcp(name, to, opts)
      return `Wrote "${name}" into ${to}'s config — restart that CLI to pick it up.`
    case 'skill':
      shareSkill(name, to, opts)
      return `Copied skill "${name}" to ${to}.`
    case 'marketplace':
      return syncMarketplace(name, to)
    case 'plugin':
      return syncPlugin(name, to)
    default:
      throw new Error(`cannot sync ${kind}`)
  }
}
