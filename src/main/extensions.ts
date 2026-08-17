import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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
  SkillInfo
} from '../shared/types'
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
  readonly config: McpConfig
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
  found: { readonly cfg: any; readonly scope: FoundScope }
): void {
  const { cfg, scope } = found
  const existing = out.get(name)
  if (existing) {
    if (!existing.scopes.some((s) => s.scope === scope.scope && s.projectPath === scope.projectPath)) {
      existing.scopes.push(scope)
    }
  } else {
    out.set(name, { config: normalizeMcp(cfg), scopes: [scope] })
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

function readSkills(): SkillInfo[] {
  const out: SkillInfo[] = []
  const dirs: Array<{ agent: Provider; dir: string }> = [
    { agent: 'claude', dir: join(homedir(), '.claude', 'skills') },
    { agent: 'copilot', dir: join(homedir(), '.copilot', 'skills') }
  ]
  for (const { agent, dir } of dirs) {
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
      try {
        description =
          readFileSync(skillMd, 'utf8').match(/^description:\s*(.+)$/m)?.[1]?.slice(0, 200) ?? ''
      } catch {
        /* unreadable — list it anyway */
      }
      out.push({ name, description, agent, path: join(dir, name) })
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
    for (const k of ['repo', 'url', 'path']) {
      if (typeof o[k] === 'string') return o[k] as string
    }
  }
  return ''
}

function readPlugins(): PluginInfo[] {
  const out: PluginInfo[] = []
  const installed = readJsonFile(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'))
  const plugins = installed?.plugins ?? installed
  if (plugins && typeof plugins === 'object') {
    for (const [name, v] of Object.entries<any>(plugins)) {
      const detail =
        typeof v === 'object' && v
          ? Array.isArray(v)
            ? `${v.length} versions`
            : sourceLabel(v.version) || sourceLabel(v.marketplace)
          : ''
      out.push({ name, agent: 'claude', detail })
    }
  }
  const copilotDir = join(homedir(), '.copilot', 'installed-plugins')
  if (existsSync(copilotDir)) {
    try {
      for (const name of readdirSync(copilotDir)) {
        if (!name.startsWith('.')) out.push({ name, agent: 'copilot', detail: '' })
      }
    } catch {
      /* ignore */
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
  return out
}

/* ---------- inventory ---------- */

export function getExtensions(): ExtensionsInventory {
  const asFound = (servers: Map<string, McpConfig>): Map<string, FoundServer> =>
    new Map([...servers].map(([n, config]) => [n, { config, scopes: [{ scope: 'user' }] }]))
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
        merged.set(name, { name, config: found.config, agents: [agent], presences })
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

function findMcp(name: string): McpConfig {
  const inv = getExtensions()
  const server = inv.mcp.find((s) => s.name === name)
  if (!server) throw new Error(`MCP server not found: ${name}`)
  return server.config
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

export function shareMcp(name: string, to: Provider): void {
  if (!NAME_RE.test(name)) throw new Error('invalid server name')
  const cfg = findMcp(name)
  if (to === 'claude') return shareToClaude(name, cfg)
  if (to === 'codex') return shareToCodex(name, cfg)
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

function shareToCodex(name: string, cfg: McpConfig): void {
  const path = codexTomlPath()
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (parseCodexMcpToml(raw).has(name)) throw new Error(`codex already has "${name}"`)
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

const SKILL_DIRS: Partial<Record<Provider, string>> = {
  claude: join(homedir(), '.claude', 'skills'),
  copilot: join(homedir(), '.copilot', 'skills')
}

/** Copy a personal skill directory between agents (claude ↔ copilot). */
export function shareSkill(name: string, from: Provider, to: Provider): void {
  if (!NAME_RE.test(name)) throw new Error('invalid skill name')
  const fromDir = SKILL_DIRS[from]
  const toDir = SKILL_DIRS[to]
  if (!fromDir || !toDir) throw new Error('skills are only supported for Claude and Copilot')
  const src = join(fromDir, name)
  const dst = join(toDir, name)
  if (!existsSync(src)) throw new Error(`skill not found: ${src}`)
  if (existsSync(dst)) throw new Error(`${to} already has "${name}"`)
  mkdirSync(toDir, { recursive: true })
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
