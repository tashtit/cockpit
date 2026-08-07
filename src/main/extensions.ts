import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type {
  ExtensionsInventory,
  MarketplaceInfo,
  McpConfig,
  McpServerInfo,
  PluginInfo,
  Provider,
  SkillInfo
} from '../shared/types'

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

function readJsonFile(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/* ---------- readers ---------- */

interface FoundServer {
  config: McpConfig
  origins: string[]
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

function addFound(out: Map<string, FoundServer>, name: string, cfg: any, origin: string): void {
  const existing = out.get(name)
  if (existing) {
    if (!existing.origins.includes(origin)) existing.origins.push(origin)
  } else {
    out.set(name, { config: normalizeMcp(cfg), origins: [origin] })
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
    for (const [name, cfg] of Object.entries<any>(servers)) addFound(out, name, cfg, 'user')
  }
  const projects = j?.projects
  if (projects && typeof projects === 'object') {
    for (const [projPath, proj] of Object.entries<any>(projects)) {
      const ps = proj?.mcpServers
      if (!ps || typeof ps !== 'object') continue
      for (const [name, cfg] of Object.entries<any>(ps)) {
        addFound(out, name, cfg, `project:${basename(projPath)}`)
      }
    }
  }
  return out
}

/** Minimal TOML reader for the [mcp_servers.*] sections codex writes. */
export function parseCodexMcpToml(raw: string): Map<string, McpConfig> {
  const out = new Map<string, McpConfig>()
  const sections = raw.split(/^\[/m)
  for (const section of sections) {
    const header = section.match(/^mcp_servers\.([A-Za-z0-9_-]+)(\.env)?\]/)
    if (!header) continue
    const name = header[1]
    const body = section.slice(section.indexOf(']') + 1)
    const entry = out.get(name) ?? {}
    if (header[2]) {
      // env subtable
      entry.env = entry.env ?? {}
      for (const m of body.matchAll(/^([A-Za-z0-9_]+)\s*=\s*"((?:[^"\\]|\\.)*)"/gm)) {
        entry.env[m[1]] = m[2]
      }
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

function readPlugins(): PluginInfo[] {
  const out: PluginInfo[] = []
  const installed = readJsonFile(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'))
  const plugins = installed?.plugins ?? installed
  if (plugins && typeof plugins === 'object') {
    for (const [name, v] of Object.entries<any>(plugins)) {
      const detail =
        typeof v === 'object' && v
          ? String(v.version ?? v.marketplace ?? (Array.isArray(v) ? `${v.length} versions` : ''))
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
      const source =
        typeof v === 'string' ? v : String(v?.source?.repo ?? v?.source ?? v?.url ?? '')
      out.push({ name, agent: 'claude', source })
    }
  }
  return out
}

/* ---------- inventory ---------- */

export function getExtensions(): ExtensionsInventory {
  const asFound = (servers: Map<string, McpConfig>): Map<string, FoundServer> =>
    new Map([...servers].map(([n, config]) => [n, { config, origins: ['user'] }]))
  const byAgent: Array<{ agent: Provider; servers: Map<string, FoundServer> }> = [
    { agent: 'claude', servers: readClaudeMcp() },
    { agent: 'codex', servers: asFound(readCodexMcp()) },
    { agent: 'copilot', servers: asFound(readCopilotMcp()) }
  ]
  const merged = new Map<string, McpServerInfo>()
  for (const { agent, servers } of byAgent) {
    for (const [name, found] of servers) {
      const existing = merged.get(name)
      if (existing) {
        existing.agents.push(agent)
        for (const o of found.origins) {
          if (!existing.origins.includes(o)) existing.origins.push(o)
        }
      } else {
        merged.set(name, { name, config: found.config, agents: [agent], origins: found.origins })
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

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/

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

function shareToCodex(name: string, cfg: McpConfig): void {
  const path = codexTomlPath()
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : ''
  if (parseCodexMcpToml(raw).has(name)) throw new Error(`codex already has "${name}"`)
  let block = `\n[mcp_servers.${name}]\n`
  if (cfg.url) {
    block += `url = ${tomlString(cfg.url)}\n`
  } else if (cfg.command) {
    block += `command = ${tomlString(cfg.command)}\n`
    block += `args = [${(cfg.args ?? []).map(tomlString).join(', ')}]\n`
  } else {
    throw new Error('server has neither command nor url')
  }
  if (cfg.env && Object.keys(cfg.env).length > 0) {
    block += `\n[mcp_servers.${name}.env]\n`
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
