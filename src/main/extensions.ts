import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  ExtensionsInventory,
  MarketplaceInfo,
  McpConfig,
  McpPresence,
  McpRawDefinitions,
  McpServerInfo,
  PluginInfo,
  Provider,
  SkillInfo
} from '../shared/types'
import {
  codexMcpServers,
  codexServerText,
  freshCodexServer,
  isPlainObject,
  mcpJsonFor,
  normalizeMcp,
  patchCodexServer,
  putCodexServer,
  removeCodexMcpToml,
  removeMcpFromJson,
  type JsonAgent
} from './extensions-core'
import { parseJsonc, readJsoncFile } from './parsers/util'
import { replaceFile } from './replace-file'

/*
 * Each agent stores MCP servers in its own format:
 *   claude  — ~/.claude.json                { "mcpServers": { name: {command,args,env,type,url} } }
 *   codex   — ~/.codex/config.toml          [mcp_servers.name] command/args/url (+ .env subtable)
 *   copilot — ~/.copilot/mcp-config.json    { "mcpServers": { name: {command,args,tools,type,url} } }
 * Sharing = translating one definition into the target agent's format — patched into
 * what that agent already holds, so the fields only it knows about stay (extensions-core.ts).
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
 *                 copilot ~/.copilot/settings.json      extraKnownMarketplaces, plus the
 *                         top level of ~/.copilot/installed-plugins/ for the ones it ships with
 * Plugin ids are `<name>@<marketplace>` everywhere, so the three inventories line up.
 */
/** Resolved per call, like every other path here, so a test can point HOME elsewhere. */
export const skillDir = (agent: Provider): string =>
  join(homedir(), agent === 'claude' ? '.claude' : agent === 'codex' ? '.codex' : '.copilot', 'skills')

/**
 * Where a *repo* keeps its skills. Claude Code reads `.claude/skills`; Codex and
 * Copilot both read `.agents/skills` natively — the same folder, which is why their
 * switches move together in a project scope.
 */
export const projectSkillDir = (repoRoot: string, agent: Provider): string =>
  agent === 'claude' ? join(repoRoot, '.claude', 'skills') : join(repoRoot, '.agents', 'skills')

const copilotPluginsDir = (): string => join(homedir(), '.copilot', 'installed-plugins')

/**
 * Where copilot records the marketplaces it was given: settings.json today, and
 * config.json — which held the settings before they moved — as a fallback.
 */
const copilotSettingsPaths = (): string[] =>
  ['settings.json', 'config.json'].map((f) => join(homedir(), '.copilot', f))

/**
 * These are the same hand-editable configs accounts.ts reads, so they get the same
 * JSONC tolerance — parsing ~/.claude.json strictly here meant one `//` comment
 * showed the account fine but silently emptied the MCP inventory.
 */
const readJsonFile = readJsoncFile

/* ---------- readers ---------- */

/**
 * Scope without the agent — the agent is attached when inventories merge — and the
 * agent's own definition, which never leaves main (see `readExtensions`).
 */
type FoundScope = Omit<McpPresence, 'agent'> & { readonly raw: McpRawDefinitions }

type FoundServer = {
  /** every place this agent defines the server, each with its own definition */
  readonly scopes: FoundScope[]
}

function addFound(
  out: Map<string, FoundServer>,
  name: string,
  found: { readonly agent: JsonAgent; readonly cfg: any; readonly scope: Omit<FoundScope, 'config' | 'raw'> }
): void {
  const { agent, cfg, scope } = found
  const own = isPlainObject(cfg) ? cfg : undefined
  const raw: McpRawDefinitions = own === undefined ? {} : agent === 'claude' ? { claude: own } : { copilot: own }
  const entry: FoundScope = { ...scope, config: normalizeMcp(cfg), raw }
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
      addFound(out, name, { agent: 'claude', cfg, scope: { scope: 'user' } })
    }
  }
  const projects = j?.projects
  if (projects && typeof projects === 'object') {
    for (const [projPath, proj] of Object.entries<any>(projects)) {
      const ps = proj?.mcpServers
      if (!ps || typeof ps !== 'object') continue
      for (const [name, cfg] of Object.entries<any>(ps)) {
        addFound(out, name, { agent: 'claude', cfg, scope: { scope: 'project', projectPath: projPath } })
      }
    }
  }
  return out
}

function readCodexMcp(): Map<string, FoundServer> {
  const out = new Map<string, FoundServer>()
  for (const [name, { config, raw }] of codexMcpServers(readCodexToml())) {
    out.set(name, { scopes: [{ scope: 'user', config, raw: { codex: raw } }] })
  }
  return out
}

function readCopilotMcp(): Map<string, FoundServer> {
  const out = new Map<string, FoundServer>()
  const j = readJsonFile(copilotJsonPath())
  const servers = j?.mcpServers
  if (servers && typeof servers === 'object') {
    for (const [name, cfg] of Object.entries<any>(servers)) {
      addFound(out, name, { agent: 'copilot', cfg, scope: { scope: 'user' } })
    }
  }
  return out
}

/* ---------- skills / plugins / marketplaces ---------- */

/** Bounded read: SKILL.md is prose, and only its first KBs decide the fingerprint. */
const MAX_SKILL_BYTES = 64 * 1024

/**
 * A skill folder's identity: its description, and a hash of SKILL.md so two agents'
 * copies can be told apart. Unreadable is not fatal — it lists with no fingerprint,
 * which compares as unknown rather than as a difference.
 */
export function readSkillFingerprint(dir: string): { description: string; fingerprint: string } {
  try {
    const raw = readFileSync(join(dir, 'SKILL.md'), 'utf8').slice(0, MAX_SKILL_BYTES)
    return {
      description: raw.match(/^description:\s*(.+)$/m)?.[1]?.slice(0, 200) ?? '',
      fingerprint: createHash('sha256').update(raw).digest('hex').slice(0, 16)
    }
  } catch {
    return { description: '', fingerprint: '' }
  }
}

/**
 * Copy a skill folder somewhere, replacing whatever was there. Links are followed:
 * an agent's skill is often a symlink into another agent's folder, and a copy of the
 * link is no copy at all — when Cockpit then removed the skill everywhere, it took
 * the only real folder with it and kept a link to nothing.
 */
export function adoptSkillInto(src: string, dst: string): void {
  if (!existsSync(src)) throw new Error(`skill not found: ${src}`)
  rmSync(dst, { recursive: true, force: true })
  mkdirSync(join(dst, '..'), { recursive: true })
  cpSync(src, dst, { recursive: true, dereference: true })
}

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
      out.push({ name, agent, path: join(dir, name), ...readSkillFingerprint(join(dir, name)) })
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
  // copilot records the marketplaces it was given in its settings — an added one with
  // nothing installed from it yet is there and nowhere else. The ones it ships with
  // (copilot-plugins, awesome-copilot) are recorded nowhere, and show only as a
  // directory of the plugins installed from them.
  const added = new Set<string>()
  for (const file of copilotSettingsPaths()) {
    const known = readJsonFile(file)?.extraKnownMarketplaces
    if (!known || typeof known !== 'object') continue
    for (const [name, v] of Object.entries<any>(known)) {
      if (added.has(name)) continue
      added.add(name)
      out.push({ name, agent: 'copilot', source: sourceLabel(v?.source) || undefined })
    }
  }
  for (const name of readDirNames(copilotPluginsDir())) {
    if (!added.has(name)) out.push({ name, agent: 'copilot' })
  }
  return out
}

/* ---------- inventory ---------- */

/**
 * The inventory as main reads it: each server's comparable view in the presences,
 * and beside it every agent's own definition — what a write patches, so the fields
 * Cockpit doesn't compare survive being written back. The renderer is sent
 * `getExtensions()`, which leaves that text out: it holds tokens (an http server's
 * `Authorization` header) the UI never needs.
 */
export type ExtensionsRead = ExtensionsInventory & {
  /** by server name; for each agent, the definition its presence was read from */
  readonly mcpRaw: ReadonlyMap<string, McpRawDefinitions>
}

function mergeServers(
  byAgent: ReadonlyArray<{ readonly agent: Provider; readonly servers: Map<string, FoundServer> }>
): Pick<ExtensionsRead, 'mcp' | 'mcpRaw'> {
  const merged = new Map<string, McpServerInfo>()
  const mcpRaw = new Map<string, McpRawDefinitions>()
  for (const { agent, servers } of byAgent) {
    for (const [name, found] of servers) {
      const presences = found.scopes.map(({ raw, ...s }) => ({ agent, ...s }))
      // the panel compares an agent's first presence, so that is the definition kept
      mcpRaw.set(name, { ...mcpRaw.get(name), ...found.scopes[0]?.raw })
      const existing = merged.get(name)
      if (existing) {
        existing.agents.push(agent)
        existing.presences.push(...presences)
      } else {
        merged.set(name, { name, config: presences[0].config, agents: [agent], presences })
      }
    }
  }
  return { mcp: [...merged.values()].sort((a, b) => a.name.localeCompare(b.name)), mcpRaw }
}

export function readExtensions(): ExtensionsRead {
  return {
    ...mergeServers([
      { agent: 'claude', servers: readClaudeMcp() },
      { agent: 'codex', servers: readCodexMcp() },
      { agent: 'copilot', servers: readCopilotMcp() }
    ]),
    skills: readSkills(),
    plugins: readPlugins(),
    marketplaces: readMarketplaces()
  }
}

export function getExtensions(): ExtensionsInventory {
  const { mcpRaw, ...inventory } = readExtensions()
  return inventory
}

/**
 * A repo's own MCP servers. Only Claude Code scopes servers to a project (under
 * projects[<root>] in ~/.claude.json) — the panel says as much for the other two
 * rather than pretending a repo can carry them.
 */
export function claudeProjectMcp(repoRoot: string): Pick<ExtensionsRead, 'mcp' | 'mcpRaw'> {
  const table = readJsonFile(claudeJsonPath())?.projects?.[repoRoot]?.mcpServers
  const servers = new Map<string, FoundServer>()
  if (table && typeof table === 'object') {
    for (const [name, cfg] of Object.entries<any>(table)) {
      addFound(servers, name, { agent: 'claude', cfg, scope: { scope: 'project', projectPath: repoRoot } })
    }
  }
  return mergeServers([{ agent: 'claude', servers }])
}

/** A definition to write: the compared view, and each agent's own text to patch it into. */
export type McpWrite = {
  readonly config: McpConfig
  readonly raw?: McpRawDefinitions
}

export function writeClaudeProjectMcp(repoRoot: string, name: string, def: McpWrite): void {
  const path = claudeJsonPath()
  const j = readJsonForWrite(path)
  j.projects = j.projects ?? {}
  j.projects[repoRoot] = j.projects[repoRoot] ?? {}
  j.projects[repoRoot].mcpServers = j.projects[repoRoot].mcpServers ?? {}
  const table = j.projects[repoRoot].mcpServers
  table[name] = mcpJsonFor('claude', def.config, table[name] ?? def.raw?.claude)
  writeJsonFile(path, j)
}

/* ---------- sharing ---------- */

/** Where a sync copies from, and whether it may replace what the target has. */
export type SyncOptions = {
  /** Agent to copy from — defaults to whichever already has it */
  readonly from?: Provider
  /** Replace the target's existing definition instead of refusing */
  readonly overwrite?: boolean
  /** Write this definition rather than looking one up (the library's own copy) */
  readonly config?: McpConfig
  /**
   * Each agent's own definition from the library's copy: what a write patches when
   * the target no longer holds one — switched off, it still gets its own back.
   */
  readonly raw?: McpRawDefinitions
}

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
  const def: McpWrite = { config: opts.config ?? findMcp(name, opts.from), raw: opts.raw }
  if (opts.from === to) throw new Error('source and target are the same agent')
  if (to === 'codex') return shareToCodex(name, def, opts.overwrite)
  return shareToJson(to, name, def)
}

/** Write a config file, creating the agent's config home if this is its first one. */
function writeJsonFile(path: string, value: unknown): void {
  replaceFile(path, JSON.stringify(value, null, 2))
}

/**
 * An agent's JSON config, read to be rewritten: `{}` only when there is no file yet.
 * A file that is there but does not parse — a trailing comma, a block comment, a
 * crash mid-write — is refused. Reading it as empty and writing back one server
 * would replace the whole file, and for ~/.claude.json that is the sign-in and
 * every project Claude Code knows.
 */
function readJsonForWrite(path: string): any {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw new Error(`cannot read ${path}: ${err instanceof Error ? err.message : err}`)
  }
  if (raw.trim() === '') return {}
  const j = parseJsonc(raw)
  if (j === null || typeof j !== 'object' || Array.isArray(j)) {
    throw new Error(`${path} isn't valid JSON — Cockpit won't rewrite a file it can't read; fix it first`)
  }
  return j
}

/**
 * Claude Code and Copilot key servers by name in one JSON object. What the agent
 * holds now — or held before it was switched off — is patched rather than replaced:
 * an http server's `headers` are its sign-in, and Copilot's `tools` is an allowlist
 * someone narrowed on purpose.
 */
function shareToJson(agent: JsonAgent, name: string, def: McpWrite): void {
  const path = agent === 'claude' ? claudeJsonPath() : copilotJsonPath()
  const j = readJsonForWrite(path)
  j.mcpServers = j.mcpServers ?? {}
  j.mcpServers[name] = mcpJsonFor(agent, def.config, j.mcpServers[name] ?? def.raw?.[agent])
  writeJsonFile(path, j)
}

function shareToCodex(name: string, def: McpWrite, overwrite = false): void {
  const path = codexTomlPath()
  mkdirSync(join(path, '..'), { recursive: true })
  const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const current = codexServerText(text, name)
  if (current !== null && !overwrite) throw new Error(`codex already has "${name}"`)
  if (!def.config.url && !def.config.command) throw new Error('server has neither command nor url')
  // the same rule as the JSON agents: what codex has, or had, is patched in place —
  // its timeouts, tool filters and inline env are Cockpit's to keep, not to drop
  const base = current ?? def.raw?.codex
  const server = base === undefined ? freshCodexServer(name, def.config) : patchCodexServer(base, name, def.config)
  replaceFile(path, putCodexServer(text, name, server))
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

/* ---------- removal ---------- */

export function removeMcp(name: string, agent: Provider, projectPath?: string): void {
  if (!NAME_RE.test(name)) throw new Error('invalid server name')
  if (agent === 'codex') {
    const path = codexTomlPath()
    if (!existsSync(path)) return
    replaceFile(path, removeCodexMcpToml(readFileSync(path, 'utf8'), name))
    return
  }
  const path = agent === 'claude' ? claudeJsonPath() : copilotJsonPath()
  if (!existsSync(path)) throw new Error(`cannot read ${path}`)
  const j = readJsonForWrite(path)
  removeMcpFromJson(j, name, agent === 'claude' ? projectPath : undefined)
  writeJsonFile(path, j)
}

/** An agent that already has the skill — a copy needs a source, not just a target. */
function findSkillSource(name: string, to: Provider): Provider {
  const from = readSkills().find((sk) => sk.name === name && sk.agent !== to)?.agent
  if (!from) throw new Error(`no agent has a skill named "${name}"`)
  return from
}
