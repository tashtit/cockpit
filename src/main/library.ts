import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildReport,
  buildRow,
  canReach,
  fieldsKey,
  instructionRow,
  kindsForScope,
  marketReach,
  mcpFields,
  PROVIDERS,
  type Actual,
  type Desired,
  type MarketReach,
  type PanelReport,
  type PanelRow
} from '../shared/library'
import { describeMcp, mcpLabel, registryOf, withVersion } from '../shared/mcp-source'
import type {
  ExtensionsInventory,
  LibraryEntry,
  McpConfig,
  McpVersion,
  PanelKind,
  PanelTarget,
  Provider
} from '../shared/types'
import { loadConfig, saveConfig, userDataDir } from './config'
import { cliEnv, execText } from './env'
import {
  adoptSkillInto,
  claudeProjectMcp,
  getExtensions,
  projectSkillDir,
  readExtensions,
  readSkillFingerprint,
  removeMcp,
  shareMcp,
  skillDir,
  writeClaudeProjectMcp,
  type ExtensionsRead
} from './extensions'
import { rawMcpConfig } from './extensions-core'
import { applyInstructions, getInstructions, unapplyInstructions } from './instructions'
import { mcpVersions } from './mcp-versions'
import { adoptInventory } from '../shared/library'

/**
 * Cockpit's own config, reconciled against what each agent really has.
 *
 * The library is the desired state: one entry per managed thing, with a switch per
 * agent. Switching an agent on writes the entry into that agent's own config;
 * switching it off takes it back out. The entry itself survives either way — that
 * is what makes a switch reversible instead of a delete, and it is why Cockpit
 * needs a config of its own rather than just editing the agents'.
 *
 * Everything here is IO. The comparison logic is in shared/library.ts.
 */

/* ---------- storage ---------- */

/**
 * Cockpit's own copy of a skill, so it survives being switched off everywhere.
 * Scoped: a repo's `review` skill and the global `review` are different folders,
 * and sharing one store would let a project quietly overwrite the global copy.
 */
function libSkillDir(name: string, repoRoot: string | null): string {
  const scope =
    repoRoot === null
      ? 'global'
      : `repo-${createHash('sha256').update(repoRoot).digest('hex').slice(0, 12)}`
  return join(userDataDir(), 'library', scope, 'skills', name)
}

function loadEntries(repoRoot: string | null): LibraryEntry[] {
  const lib = loadConfig().library
  return (repoRoot === null ? lib?.global : lib?.repos?.[repoRoot]) ?? []
}

function saveEntries(repoRoot: string | null, entries: readonly LibraryEntry[]): void {
  const cfg = loadConfig()
  const lib = cfg.library ?? {}
  saveConfig({
    ...cfg,
    library:
      repoRoot === null
        ? { ...lib, global: [...entries] }
        : { ...lib, repos: { ...lib.repos, [repoRoot]: [...entries] } }
  })
}

function findEntry(entries: readonly LibraryEntry[], target: PanelTarget): LibraryEntry {
  const found = entries.find((e) => e.kind === target.kind && e.name === target.name)
  if (!found) throw new Error(`Cockpit doesn't track ${target.kind} "${target.name}" here`)
  return found
}

function replaceEntry(entries: readonly LibraryEntry[], next: LibraryEntry): LibraryEntry[] {
  return entries.map((e) => (e.kind === next.kind && e.name === next.name ? next : e))
}

/* ---------- what the agents actually have, per scope ---------- */

/**
 * Global reads the agent home configs; a repo scope reads only what a repo can
 * actually carry. Plugins and marketplaces are installed per machine, so a repo
 * scope has none at all — the panel says so rather than showing empty rows.
 */
function scopedInventory(repoRoot: string | null): ExtensionsRead {
  if (repoRoot === null) return readExtensions()
  return {
    ...claudeProjectMcp(repoRoot),
    skills: PROVIDERS.flatMap((agent) => {
      const dir = projectSkillDir(repoRoot, agent)
      if (!existsSync(dir)) return []
      let names: string[] = []
      try {
        names = readdirSync(dir)
      } catch {
        return []
      }
      return names
        .filter((name) => existsSync(join(dir, name, 'SKILL.md')))
        .map((name) => ({
          name,
          agent,
          path: join(dir, name),
          ...readSkillFingerprint(join(dir, name))
        }))
    }),
    plugins: [],
    marketplaces: []
  }
}

/* ---------- an entry's two sides ---------- */

/** The agents' own names, for the sentences that have to name one. */
const AGENT_LABEL: Record<Provider, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'Copilot'
}

/** The marketplace a plugin is installed from — the half after the last `@`. */
function marketOf(entry: LibraryEntry): string | undefined {
  if (entry.kind === 'marketplace') return entry.name
  const at = entry.name.lastIndexOf('@')
  return entry.source ?? (at > 0 ? entry.name.slice(at + 1) : undefined)
}

/**
 * Why an agent can't be offered it. A plugin is only ever installed from its
 * marketplace, so an agent that can't reach the marketplace can't be given the
 * plugin either — and saying that plainly is better than a switch that runs an
 * install and fails.
 *
 * The sentence never names the agent it is about: the chip it sits under *is* that
 * agent, and two blocked agents would otherwise put the same sentence on screen
 * twice with one word different.
 */
function reachReason(entry: LibraryEntry, reach: MarketReach): string {
  const market = marketOf(entry) ?? entry.name
  const verb = entry.kind === 'marketplace' ? 'add it' : `install ${entry.name}`
  const who = reach.has.map((p) => AGENT_LABEL[p]).join(' and ')
  return reach.has.length > 0
    ? `${market} ships with ${who} — there’s no source another agent could add it from.`
    : `Cockpit can’t tell where ${market} comes from, so it can’t ${verb} in another agent.`
}

function skillFields(fingerprint: string, description: string): Record<string, string> {
  // a fingerprint of the folder's files: two agents with the same hash run the same skill
  return { description, 'folder hash': fingerprint.slice(0, 8) }
}

/** The copy Cockpit keeps — what a switch writes when no agent has it to copy from. */
/**
 * Copy a skill into Cockpit's store — but only when the agents are about to stop
 * holding one. Copying every skill on sight cost a folder copy per skill on the
 * first read of a scope, for a backup almost none of them would ever need.
 */
function keepBackup(entry: LibraryEntry, inv: ExtensionsInventory, repoRoot: string | null): void {
  if (entry.kind !== 'skill') return
  const source = inv.skills.find((sk) => sk.name === entry.name)
  if (source) adoptSkillInto(source.path, libSkillDir(entry.name, repoRoot))
}

function savedOf(entry: LibraryEntry, repoRoot: string | null, inv: ExtensionsInventory): Desired {
  switch (entry.kind) {
    case 'mcp':
      return {
        detail: entry.withheld?.length
          ? `needs values: ${entry.withheld.join(', ')}`
          : entry.config
            ? mcpLabel(entry.config)
            : 'no definition yet',
        fields: mcpFields(entry.config ?? {})
      }
    case 'skill':
      // nothing to compare against — the agents' copies are compared with each other —
      // but the row still needs to say what the skill *is*. A restored skill no agent
      // has yet is only in Cockpit's own copy, so read the description from there.
      return {
        detail:
          inv.skills.find((sk) => sk.name === entry.name)?.description ||
          readSkillFingerprint(libSkillDir(entry.name, repoRoot)).description,
        fields: {}
      }
    case 'plugin':
      return { detail: entry.source ? `from ${entry.source}` : '', fields: entry.source ? { marketplace: entry.source } : {} }
    case 'marketplace':
      return { detail: entry.source ?? '', fields: entry.source ? { source: entry.source } : {} }
    default:
      return { detail: getInstructions(repoRoot).baseline.trim().split('\n')[0], fields: {} }
  }
}

/** Each agent's side, read back from its own config. */
function actualOf(
  entry: LibraryEntry,
  inv: ExtensionsInventory,
  repoRoot: string | null
): Partial<Record<Provider, Actual>> {
  const out: Partial<Record<Provider, Actual>> = {}
  if (entry.kind === 'mcp') {
    const server = inv.mcp.find((s) => s.name === entry.name)
    for (const agent of PROVIDERS) {
      if (repoRoot !== null && agent !== 'claude') {
        out[agent] = {
          present: false,
          detail: '',
          fields: {},
          // the same sentence for both agents, so the opened row states it once
          reason: 'Only Claude Code scopes MCP servers to a project — set it in Global.'
        }
        continue
      }
      const presence = server?.presences.find((p) => p.agent === agent)
      out[agent] = presence
        ? { present: true, detail: mcpLabel(presence.config), fields: mcpFields(presence.config) }
        : { present: false, detail: '', fields: {} }
    }
    return out
  }
  if (entry.kind === 'skill') {
    for (const agent of PROVIDERS) {
      const found = inv.skills.find((s) => s.name === entry.name && s.agent === agent)
      out[agent] = found
        ? {
            present: true,
            detail: found.path,
            fields: skillFields(found.fingerprint, found.description)
          }
        : { present: false, detail: '', fields: {} }
    }
    return out
  }
  if (entry.kind === 'plugin' || entry.kind === 'marketplace') {
    const key = entry.kind === 'plugin' ? 'marketplace' : 'source'
    const reach = marketReach(marketOf(entry), inv.marketplaces)
    for (const agent of PROVIDERS) {
      const plugin =
        entry.kind === 'plugin'
          ? inv.plugins.find((x) => x.name === entry.name && x.agent === agent)
          : undefined
      const market =
        entry.kind === 'marketplace'
          ? inv.marketplaces.find((x) => x.name === entry.name && x.agent === agent)
          : undefined
      if (!plugin && !market) {
        // an agent that can't reach the marketplace gets no switch at all: offering
        // one would be offering an install Cockpit knows it can't carry out
        out[agent] = canReach(reach, agent)
          ? { present: false, detail: '', fields: {} }
          : { present: false, detail: '', fields: {}, reason: reachReason(entry, reach) }
        continue
      }
      const source = plugin?.marketplace ?? market?.source
      out[agent] = {
        present: true,
        detail: plugin?.version ? `v${plugin.version}` : (source ?? ''),
        // an agent that records no source contributes no field: unknown is not a difference
        fields: source ? { [key]: source } : {}
      }
    }
    return out
  }
  return out
}

/* ---------- the report ---------- */

/**
 * Bring a scope's library up to date with what is on disk, and hand back both sides.
 *
 * Anything the agents already have is adopted, switched on for the agents that have
 * it — otherwise an existing setup would open as a wall of "extra" and Cockpit would
 * spend its first run arguing with reality. Every action goes through here too, so
 * acting on a scope the user hasn't opened yet still finds its entries.
 */
function ensureScope(repoRoot: string | null): {
  entries: LibraryEntry[]
  inv: ExtensionsRead
} {
  const inv = scopedInventory(repoRoot)
  const before = loadEntries(repoRoot)
  const adopted = adoptInventory(before, inv)
  const refreshed = adopted.map((entry) => refreshSaved(entry, inv))
  if (JSON.stringify(refreshed) !== JSON.stringify(before)) saveEntries(repoRoot, refreshed)
  return { entries: refreshed, inv }
}

/**
 * Keep Cockpit's copy current with what the agents run. The copy exists so a switch
 * has something to write and a removed entry can come back — it is a backup, so it
 * follows the agents rather than the other way round.
 *
 * Each agent's own definition is kept alongside, and an agent that no longer has the
 * server keeps the one it had last: switching it back on then gives it exactly that
 * back — headers, tool filters, timeouts — rather than the compared fields alone.
 */
function refreshSaved(entry: LibraryEntry, inv: ExtensionsRead): LibraryEntry {
  if (entry.kind !== 'mcp') return entry
  const config = inv.mcp.find((srv) => srv.name === entry.name)?.presences[0]?.config
  const own = inv.mcpRaw.get(entry.name)
  const next = own ? { ...entry, raw: { ...entry.raw, ...own } } : entry
  // an agent's own definition carries the values a passphrase-less restore left
  // out, so adopting it is exactly what clears the "needs values" state
  return config ? withoutWithheld({ ...next, config }) : next
}

/**
 * Drop the marker rather than blank it: `ensureScope` compares entries with
 * JSON.stringify, and a lingering `withheld: []` would rewrite the config forever.
 */
function withoutWithheld(entry: LibraryEntry): LibraryEntry {
  if (entry.withheld === undefined) return entry
  const { withheld, ...rest } = entry
  return rest
}

export function getPanel(repoRoot: string | null): PanelReport {
  const { entries: adopted, inv } = ensureScope(repoRoot)
  const kinds = kindsForScope(repoRoot)
  const entries = adopted.filter((e) => kinds.includes(e.kind))

  const instructions = getInstructions(repoRoot)
  const rows: PanelRow[] = entries
    .filter((e) => e.kind !== 'instructions')
    .map((entry) => buildRow(entry, savedOf(entry, repoRoot, inv), actualOf(entry, inv, repoRoot)))

  if (instructions.baseline.trim() !== '') {
    const entry =
      entries.find((e) => e.kind === 'instructions') ??
      instructionsEntry(repoRoot, instructions.files)
    rows.push(instructionRow(instructions, entry))
  }
  return buildReport(repoRoot, rows)
}

/** The instructions entry starts switched on wherever the baseline is already applied. */
function instructionsEntry(
  repoRoot: string | null,
  files: ReturnType<typeof getInstructions>['files']
): LibraryEntry {
  const enabled: Partial<Record<Provider, boolean>> = {}
  for (const file of files) {
    for (const agent of file.agents) if (file.status !== 'missing') enabled[agent] = true
  }
  const entry: LibraryEntry = { kind: 'instructions', name: 'Shared baseline', enabled }
  saveEntries(repoRoot, [...loadEntries(repoRoot), entry])
  return entry
}

/* ---------- writers ---------- */

const PLUGIN_CMD: Record<Provider, { on: readonly string[]; off: readonly string[] }> = {
  claude: { on: ['plugin', 'install'], off: ['plugin', 'uninstall'] },
  // codex spells install "add" and uninstall "remove"
  codex: { on: ['plugin', 'add'], off: ['plugin', 'remove'] },
  copilot: { on: ['plugin', 'install'], off: ['plugin', 'uninstall'] }
}

/** Marketplace clones and plugin installs hit the network — give them room. */
const CLI_TIMEOUT_MS = 120_000

async function runAgentCli(agent: Provider, args: readonly string[]): Promise<void> {
  const res = await execText(agent, args, { timeoutMs: CLI_TIMEOUT_MS, env: cliEnv() })
  if (!res.ok) {
    const detail = (res.stderr || res.stdout || res.error || '').trim().split('\n').slice(-3).join(' ')
    throw new Error(`${agent} ${args.join(' ')} failed — ${detail || 'no output'}`)
  }
}

/**
 * An install only works from a marketplace the agent already has, so say which one
 * is missing rather than handing back whatever the CLI prints when it can't find it.
 * Unreachable marketplaces never get a switch at all (`reachReason`), so the case
 * left here is the ordinary one: add the marketplace first.
 */
function assertInstallable(entry: LibraryEntry, agent: Provider): void {
  const market = marketOf(entry)
  const reach = marketReach(market, getExtensions().marketplaces)
  if (reach.has.includes(agent)) return
  if (!canReach(reach, agent)) throw new Error(reachReason(entry, reach))
  throw new Error(
    `${AGENT_LABEL[agent]} doesn’t have the ${market} marketplace yet — switch it on under Marketplaces first.`
  )
}

function skillTarget(repoRoot: string | null, agent: Provider): string {
  return repoRoot === null ? skillDir(agent) : projectSkillDir(repoRoot, agent)
}

async function writeSwitch(
  entry: LibraryEntry,
  agent: Provider,
  on: boolean,
  repoRoot: string | null
): Promise<void> {
  switch (entry.kind) {
    case 'mcp': {
      if (!entry.config) throw new Error(`no definition recorded for "${entry.name}"`)
      // a restore without a passphrase brought the definition but not its secrets;
      // writing it would hand the agent a server with blank credentials
      if (on && entry.withheld && entry.withheld.length > 0) {
        throw new Error(
          `"${entry.name}" was restored without ${entry.withheld.join(', ')} — set it up in an agent first, or restore from a backup with a passphrase`
        )
      }
      // entry.config is kept refreshed from the agents on every read, so writing it
      // spreads what your agents actually run rather than something Cockpit invented;
      // entry.raw is what each agent itself holds, which the write patches it into
      const def = { config: entry.config, raw: entry.raw }
      if (repoRoot !== null) {
        if (agent !== 'claude') throw new Error('only Claude Code scopes MCP servers to a project')
        if (on) return writeClaudeProjectMcp(repoRoot, entry.name, def)
        try {
          return removeMcp(entry.name, 'claude', repoRoot)
        } catch {
          return
        }
      }
      if (on) return shareMcp(entry.name, agent, { ...def, overwrite: true })
      // taking out what was never there is what the user asked for either way
      try {
        return removeMcp(entry.name, agent)
      } catch {
        return
      }
    }
    case 'skill': {
      const dst = join(skillTarget(repoRoot, agent), entry.name)
      if (!on) {
        rmSync(dst, { recursive: true, force: true })
        return
      }
      const src = libSkillDir(entry.name, repoRoot)
      if (!existsSync(src)) throw new Error(`Cockpit has no copy of skill "${entry.name}" to write`)
      rmSync(dst, { recursive: true, force: true })
      mkdirSync(join(dst, '..'), { recursive: true })
      cpSync(src, dst, { recursive: true })
      return
    }
    case 'plugin': {
      if (on) assertInstallable(entry, agent)
      const cmd = PLUGIN_CMD[agent]
      return runAgentCli(agent, [...(on ? cmd.on : cmd.off), entry.name])
    }
    case 'marketplace': {
      if (!on) return runAgentCli(agent, ['plugin', 'marketplace', 'remove', entry.name])
      if (!entry.source) throw new Error(`no source recorded for marketplace "${entry.name}"`)
      return runAgentCli(agent, ['plugin', 'marketplace', 'add', entry.source])
    }
    default: {
      const files = getInstructions(repoRoot).files.filter((f) => f.agents.includes(agent))
      for (const file of files) {
        if (on) applyInstructions(repoRoot, file.path)
        else unapplyInstructions(repoRoot, file.path)
      }
    }
  }
}

/* ---------- actions ---------- */

const NAME_RE = /^(?!\.+$)[A-Za-z0-9_.@-]{1,80}$/

function assertTarget(target: PanelTarget): void {
  if (target.kind !== 'instructions' && !NAME_RE.test(target.name)) {
    throw new Error(`invalid ${target.kind} name`)
  }
}

/** Flip one switch: write the entry into that agent, or take it back out. */
export async function setPanelSwitch(
  target: PanelTarget,
  agent: Provider,
  on: boolean
): Promise<PanelReport> {
  assertTarget(target)
  const { entries, inv } = ensureScope(target.repoRoot)
  const entry = findEntry(entries, target)
  // a skill the agent already has (added outside Cockpit, or through a folder it
  // shares with another agent) is switched on by recording it: writing Cockpit's
  // copy over it would replace the agent's folder with whatever was kept last
  const alreadyThere =
    on && entry.kind === 'skill' && inv.skills.some((sk) => sk.name === entry.name && sk.agent === agent)
  // turning the last copy off would leave nothing to switch back on, so take the
  // backup first; turning one on needs a source, which is the backup or a peer
  if (entry.kind === 'skill' && !alreadyThere) {
    if (!on) keepBackup(entry, inv, target.repoRoot)
    else if (!existsSync(libSkillDir(entry.name, target.repoRoot))) {
      keepBackup(entry, inv, target.repoRoot)
      if (!existsSync(libSkillDir(entry.name, target.repoRoot))) {
        throw new Error(`no copy of skill "${entry.name}" left to write — reinstall it in an agent first`)
      }
    }
  }
  if (!alreadyThere) await writeSwitch(entry, agent, on, target.repoRoot)
  // re-read after the write, which can take minutes for a plugin CLI: saving the
  // list read before it would undo any change made to another entry meanwhile
  saveEntries(
    target.repoRoot,
    replaceEntry(loadEntries(target.repoRoot), {
      // an agent switched off has nothing left to differ with; switching one on
      // leaves every difference the user kept exactly as it was
      ...(on ? entry : withoutKept(entry, [agent])),
      enabled: { ...entry.enabled, [agent]: on }
    })
  )
  return getPanel(target.repoRoot)
}

/** The entry with a kept difference forgotten for these agents (all of them when none named). */
function withoutKept(entry: LibraryEntry, agents: readonly Provider[]): LibraryEntry {
  if (!entry.kept) return entry
  const { kept, ...rest } = entry
  if (agents.length === 0) return rest
  const left: Partial<Record<Provider, string>> = {}
  for (const p of PROVIDERS) if (kept[p] !== undefined && !agents.includes(p)) left[p] = kept[p]
  return Object.keys(left).length > 0 ? { ...rest, kept: left } : rest
}

/**
 * The other answer to "which one is right?": they are meant to differ. Each agent
 * that differs right now has its current definition remembered as intended, so the
 * row goes quiet — until that agent runs something else, which is drift again.
 * `keep` false forgets every kept difference on the entry.
 */
export async function keepPanelDifference(target: PanelTarget, keep: boolean): Promise<PanelReport> {
  assertTarget(target)
  const { entries, inv } = ensureScope(target.repoRoot)
  const entry = findEntry(entries, target)
  if (!keep) {
    saveEntries(target.repoRoot, replaceEntry(entries, withoutKept(entry, [])))
    return getPanel(target.repoRoot)
  }
  const actual = actualOf(entry, inv, target.repoRoot)
  const row = buildRow(entry, savedOf(entry, target.repoRoot, inv), actual)
  const kept: Partial<Record<Provider, string>> = { ...entry.kept }
  const changed = PROVIDERS.filter((p) => row.cells[p].state === 'changed')
  for (const p of changed) kept[p] = fieldsKey(actual[p]?.fields ?? {})
  if (changed.length > 0) saveEntries(target.repoRoot, replaceEntry(entries, { ...entry, kept }))
  return getPanel(target.repoRoot)
}

/**
 * Make the agents agree: copy `source`'s definition to every other agent that has
 * this switched on. Cockpit picks no winner — it has no version of its own to pick
 * with — so the user names the agent whose setup is the right one.
 */
export async function matchPanelEntry(target: PanelTarget, source: Provider): Promise<PanelReport> {
  assertTarget(target)
  const { entries, inv } = ensureScope(target.repoRoot)
  const entry = findEntry(entries, target)
  const taken = withoutKept(takeFrom(entry, source, inv, target.repoRoot), [])
  const others = PROVIDERS.filter((p) => p !== source && taken.enabled[p] === true)
  saveEntries(target.repoRoot, replaceEntry(entries, taken))
  for (const agent of others) await writeSwitch(taken, agent, true, target.repoRoot)
  return getPanel(target.repoRoot)
}

/** Read one agent's real definition into the kept copy. */
function takeFrom(
  entry: LibraryEntry,
  agent: Provider,
  inv: ExtensionsInventory,
  repoRoot: string | null
): LibraryEntry {
  switch (entry.kind) {
    case 'mcp': {
      const config = inv.mcp
        .find((srv) => srv.name === entry.name)
        ?.presences.find((p) => p.agent === agent)?.config
      if (!config) throw new Error(`${agent} has no "${entry.name}" to copy`)
      return withoutWithheld({ ...entry, config })
    }
    case 'skill': {
      const found = inv.skills.find((sk) => sk.name === entry.name && sk.agent === agent)
      if (!found) throw new Error(`${agent} has no skill "${entry.name}" to copy`)
      adoptSkillInto(found.path, libSkillDir(entry.name, repoRoot))
      return entry
    }
    default: {
      const source =
        entry.kind === 'plugin'
          ? inv.plugins.find((x) => x.name === entry.name && x.agent === agent)?.marketplace
          : inv.marketplaces.find((x) => x.name === entry.name && x.agent === agent)?.source
      return source ? { ...entry, source } : entry
    }
  }
}

/**
 * Take it out of every agent, and keep the entry. This is what Cockpit's own copy is
 * *for*: removing everywhere would otherwise be the one action in the panel you
 * couldn't undo, and nothing on disk would remember the thing had ever existed.
 * `enabled` is left exactly as it was, so putting it back restores the same agents.
 */
export async function removePanelEntry(target: PanelTarget): Promise<PanelReport> {
  assertTarget(target)
  if (target.kind === 'instructions') {
    throw new Error('the shared baseline is cleared in the Instructions tab')
  }
  const { entries, inv } = ensureScope(target.repoRoot)
  const entry = findEntry(entries, target)
  // this is the moment the backup exists for: after this, no agent holds a copy
  keepBackup(entry, inv, target.repoRoot)
  const failed: string[] = []
  const row = buildRow(entry, savedOf(entry, target.repoRoot, inv), actualOf(entry, inv, target.repoRoot))
  for (const agent of row.holders) {
    try {
      await writeSwitch(entry, agent, false, target.repoRoot)
    } catch (err) {
      failed.push(`${agent}: ${err instanceof Error ? err.message : err}`)
    }
  }
  if (failed.length > 0) throw new Error(`couldn't remove it everywhere — ${failed.join(' · ')}`)
  saveEntries(target.repoRoot, replaceEntry(loadEntries(target.repoRoot), { ...entry, removed: true }))
  return getPanel(target.repoRoot)
}

/* ---------- versions ---------- */

/**
 * What the registries say about this scope's pinned servers. Read on demand — the
 * panel asks once when its MCP section opens — and never as part of `getPanel`: a
 * panel that can't be drawn until two network calls answer is a panel that hangs
 * offline.
 */
export async function mcpVersionsFor(repoRoot: string | null): Promise<readonly McpVersion[]> {
  const { entries } = ensureScope(repoRoot)
  const servers = entries
    .filter((e) => e.kind === 'mcp' && !e.removed && e.config !== undefined)
    .map((e) => ({ name: e.name, config: e.config! }))
  return mcpVersions(servers)
}

/**
 * Pin a server to another version, everywhere it is switched on.
 *
 * Only the version moves: `withVersion` rewrites the package spec and leaves the
 * rest of the launch line byte-identical, so a bump can't quietly become a rewrite
 * of what the user runs — and it does that in each agent's own line, whose other
 * fields the write leaves alone (`pinnedFor`). The version itself arrives from the
 * renderer, which makes it untrusted input on its way into a command line — it is
 * checked against the registry's own answer for this server before anything is
 * written.
 */
export async function setMcpVersion(target: PanelTarget, version: string): Promise<PanelReport> {
  assertTarget(target)
  if (target.kind !== 'mcp') throw new Error('only an MCP server is pinned to a version')
  const { entries } = ensureScope(target.repoRoot)
  const entry = findEntry(entries, target)
  if (!entry.config) throw new Error(`no definition recorded for "${entry.name}"`)
  const described = describeMcp(entry.config)
  if (registryOf(described) === null || described.version === undefined) {
    throw new Error(`“${entry.name}” doesn’t pin a package version`)
  }
  const offered = (await mcpVersions([{ name: entry.name, config: entry.config }]))[0]
  if (offered?.latest !== version) {
    throw new Error(
      `${version} isn’t what ${offered?.registry ?? 'the registry'} offers for ${described.what}`
    )
  }
  const next = { ...entry, config: withVersion(entry.config, version) }
  saveEntries(target.repoRoot, replaceEntry(entries, next))
  // read again now the registry has answered, which can take a while
  const inv = scopedInventory(target.repoRoot)
  const failed: string[] = []
  for (const agent of PROVIDERS.filter((p) => next.enabled[p] === true)) {
    try {
      await writeSwitch({ ...next, config: pinnedFor(next, agent, inv) }, agent, true, target.repoRoot)
    } catch (err) {
      failed.push(`${agent}: ${err instanceof Error ? err.message : err}`)
    }
  }
  if (failed.length > 0) throw new Error(`pinned to ${version}, but not everywhere — ${failed.join(' · ')}`)
  return getPanel(target.repoRoot)
}

/**
 * What one agent runs, with only the version moved to the one `entry` now pins.
 * Agents can launch the same package with different flags, and a pin is a version
 * bump, not a rewrite: each keeps its own line. An agent running something else —
 * another package, or this one unpinned, which already installs the newest at every
 * launch — is left as it is, and said so. One with nothing of its own yet (switched
 * on, never written) gets Cockpit's copy.
 */
function pinnedFor(
  entry: LibraryEntry & { readonly config: McpConfig },
  agent: Provider,
  inv: ExtensionsInventory
): McpConfig {
  const own =
    inv.mcp.find((s) => s.name === entry.name)?.presences.find((p) => p.agent === agent)?.config ??
    rawMcpConfig(entry.raw, agent, entry.name)
  if (!own) return entry.config
  const mine = describeMcp(own)
  const pinned = describeMcp(entry.config)
  const same = registryOf(mine) === registryOf(pinned) && mine.what === pinned.what
  if (!same || mine.version === undefined || pinned.version === undefined) {
    throw new Error(`runs ${mcpLabel(own)} — left as it is`)
  }
  return withVersion(own, pinned.version)
}

/* ---------- what a backup needs ---------- */

/**
 * Adopt whatever the agents already have in a scope, without building a report.
 * Restore calls this first: merging against a library that was never opened would
 * "add" entries this machine already runs, and then override them with the
 * backup's switches.
 */
export function adoptScope(repoRoot: string | null): void {
  ensureScope(repoRoot)
}

/**
 * Where to read a skill's content for a backup: an agent's live copy first, since
 * Cockpit's own is only refreshed when a switch goes off, and is otherwise as old
 * as the last time this skill was taken out of an agent.
 */
export function skillSource(name: string, repoRoot: string | null): string | null {
  const inv = scopedInventory(repoRoot)
  const found = inv.skills.find((sk) => sk.name === name)
  if (found) return found.path
  const kept = libSkillDir(name, repoRoot)
  return existsSync(kept) ? kept : null
}

/** True when this machine can already write that skill — restore then leaves it alone. */
export function hasSkillCopy(name: string, repoRoot: string | null): boolean {
  return skillSource(name, repoRoot) !== null
}

/** Cockpit's own copy of a restored skill; a switch writes it into the agents from here. */
export function skillCopyDir(name: string, repoRoot: string | null): string {
  return libSkillDir(name, repoRoot)
}

/** Put a removed entry back on the agents it was on when it went. */
export async function restorePanelEntry(target: PanelTarget): Promise<PanelReport> {
  assertTarget(target)
  const { entries } = ensureScope(target.repoRoot)
  const entry = findEntry(entries, target)
  const back: LibraryEntry = { ...entry, removed: false }
  const failed: string[] = []
  for (const agent of PROVIDERS.filter((p) => back.enabled[p] === true)) {
    try {
      await writeSwitch(back, agent, true, target.repoRoot)
    } catch (err) {
      failed.push(`${agent}: ${err instanceof Error ? err.message : err}`)
    }
  }
  saveEntries(target.repoRoot, replaceEntry(loadEntries(target.repoRoot), back))
  if (failed.length > 0) throw new Error(`put back, but not everywhere — ${failed.join(' · ')}`)
  return getPanel(target.repoRoot)
}
