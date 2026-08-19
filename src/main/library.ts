import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildReport,
  buildRow,
  instructionRow,
  kindsForScope,
  mcpFields,
  mcpSummary,
  PROVIDERS,
  type Actual,
  type Desired,
  type PanelReport,
  type PanelRow
} from '../shared/library'
import type {
  DriftFix,
  ExtensionsInventory,
  LibraryEntry,
  McpConfig,
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
  readSkillFingerprint,
  removeMcp,
  shareMcp,
  skillDir,
  writeClaudeProjectMcp
} from './extensions'
import { applyInstructions, getInstructions, unapplyInstructions } from './instructions'
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
function scopedInventory(repoRoot: string | null): ExtensionsInventory {
  const global = getExtensions()
  if (repoRoot === null) return global
  return {
    mcp: claudeProjectMcp(repoRoot),
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

function skillFields(fingerprint: string, description: string): Record<string, string> {
  return { description, contents: fingerprint.slice(0, 8) }
}

/** Cockpit's side of the comparison. */
function desiredOf(entry: LibraryEntry, repoRoot: string | null): Desired {
  switch (entry.kind) {
    case 'mcp':
      return {
        detail: entry.config ? mcpSummary(entry.config) : 'no definition yet',
        fields: mcpFields(entry.config ?? {})
      }
    case 'skill': {
      const own = readSkillFingerprint(libSkillDir(entry.name, repoRoot))
      return {
        detail: own.description || 'Cockpit’s copy',
        fields: skillFields(own.fingerprint, own.description)
      }
    }
    case 'plugin':
      return { detail: entry.source ? `from ${entry.source}` : '', fields: entry.source ? { marketplace: entry.source } : {} }
    case 'marketplace':
      return { detail: entry.source ?? '', fields: entry.source ? { source: entry.source } : {} }
    default:
      return { detail: 'the shared baseline', fields: { block: 'current' } }
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
          reason: `${agent === 'codex' ? 'Codex' : 'Copilot'} reads MCP servers globally only — set it in Global.`
        }
        continue
      }
      const presence = server?.presences.find((p) => p.agent === agent)
      out[agent] = presence
        ? { present: true, detail: mcpSummary(presence.config), fields: mcpFields(presence.config) }
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
        out[agent] = { present: false, detail: '', fields: {} }
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
  inv: ExtensionsInventory
} {
  const inv = scopedInventory(repoRoot)
  const before = loadEntries(repoRoot)
  const adopted = adoptInventory(before, inv)
  // an adopted skill is only Cockpit's once Cockpit holds the folder: without its
  // own copy every skill would compare against nothing and read as "differs"
  for (const entry of adopted) {
    if (entry.kind !== 'skill' || existsSync(libSkillDir(entry.name, repoRoot))) continue
    const source = inv.skills.find((sk) => sk.name === entry.name)
    if (source) adoptSkillInto(source.path, libSkillDir(entry.name, repoRoot))
  }
  if (JSON.stringify(adopted) !== JSON.stringify(before)) saveEntries(repoRoot, adopted)
  return { entries: adopted, inv }
}

export function getPanel(repoRoot: string | null): PanelReport {
  const { entries: adopted, inv } = ensureScope(repoRoot)
  const kinds = kindsForScope(repoRoot)
  const entries = adopted.filter((e) => kinds.includes(e.kind))

  const instructions = getInstructions(repoRoot)
  const rows: PanelRow[] = entries
    .filter((e) => e.kind !== 'instructions')
    .map((entry) => buildRow(entry, desiredOf(entry, repoRoot), actualOf(entry, inv, repoRoot)))

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
      if (repoRoot !== null) {
        if (agent !== 'claude') throw new Error('only Claude Code scopes MCP servers to a project')
        if (on) return writeClaudeProjectMcp(repoRoot, entry.name, entry.config)
        try {
          return removeMcp(entry.name, 'claude', repoRoot)
        } catch {
          return
        }
      }
      if (on) return shareMcp(entry.name, agent, { overwrite: true, config: entry.config })
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
  const { entries } = ensureScope(target.repoRoot)
  const entry = findEntry(entries, target)
  // a skill can only be written out of a copy Cockpit holds — take one now if the
  // library was populated from an agent that has since been switched off
  if (entry.kind === 'skill' && on && !existsSync(libSkillDir(entry.name, target.repoRoot))) {
    adoptSkillIntoLibrary(entry.name, target.repoRoot)
  }
  await writeSwitch(entry, agent, on, target.repoRoot)
  saveEntries(target.repoRoot, replaceEntry(entries, { ...entry, enabled: { ...entry.enabled, [agent]: on } }))
  return getPanel(target.repoRoot)
}

/** Copy whichever agent still has the skill into Cockpit's own store. */
function adoptSkillIntoLibrary(name: string, repoRoot: string | null): void {
  const inv = scopedInventory(repoRoot)
  const source = inv.skills.find((s) => s.name === name)
  if (!source) throw new Error(`no copy of skill "${name}" left to take — reinstall it in an agent first`)
  adoptSkillInto(source.path, libSkillDir(name, repoRoot))
}

/**
 * Settle a disagreement: `apply` writes Cockpit's definition into the agent,
 * `adopt` takes the agent's definition into Cockpit (and leaves it switched on).
 */
export async function fixPanelDrift(
  target: PanelTarget,
  agent: Provider,
  how: DriftFix
): Promise<PanelReport> {
  assertTarget(target)
  const { entries, inv } = ensureScope(target.repoRoot)
  const entry = findEntry(entries, target)
  if (how === 'apply') {
    const on = entry.enabled[agent] === true
    await writeSwitch(entry, agent, on, target.repoRoot)
    return getPanel(target.repoRoot)
  }
  const next = adoptFrom(entry, agent, inv, target.repoRoot)
  saveEntries(target.repoRoot, replaceEntry(entries, { ...next, enabled: { ...entry.enabled, [agent]: true } }))
  return getPanel(target.repoRoot)
}

/** Pull one agent's real definition into the library entry. */
function adoptFrom(
  entry: LibraryEntry,
  agent: Provider,
  inv: ExtensionsInventory,
  repoRoot: string | null
): LibraryEntry {
  switch (entry.kind) {
    case 'mcp': {
      const config = inv.mcp
        .find((s) => s.name === entry.name)
        ?.presences.find((p) => p.agent === agent)?.config
      if (!config) throw new Error(`${agent} has no "${entry.name}" to take`)
      return { ...entry, config }
    }
    case 'skill': {
      const found = inv.skills.find((s) => s.name === entry.name && s.agent === agent)
      if (!found) throw new Error(`${agent} has no skill "${entry.name}" to take`)
      adoptSkillInto(found.path, libSkillDir(entry.name, repoRoot))
      return entry
    }
    case 'plugin':
    case 'marketplace': {
      const source =
        entry.kind === 'plugin'
          ? inv.plugins.find((x) => x.name === entry.name && x.agent === agent)?.marketplace
          : inv.marketplaces.find((x) => x.name === entry.name && x.agent === agent)?.source
      if (source === undefined) throw new Error(`${agent} has no "${entry.name}" to take`)
      return { ...entry, source }
    }
    default: {
      // the baseline is edited in the Instructions tab, never adopted from a file
      void repoRoot
      throw new Error('edit the shared baseline in the Instructions tab')
    }
  }
}

/** Take it out of every agent that has it, then stop tracking it. */
export async function forgetPanelEntry(target: PanelTarget): Promise<PanelReport> {
  assertTarget(target)
  if (target.kind === 'instructions') throw new Error('the shared baseline is cleared in the Instructions tab')
  const { entries, inv } = ensureScope(target.repoRoot)
  const entry = findEntry(entries, target)
  const failed: string[] = []
  for (const agent of PROVIDERS) {
    const row = buildRow(entry, desiredOf(entry, target.repoRoot), actualOf(entry, inv, target.repoRoot))
    if (!row.cells[agent].detail && !row.cells[agent].desired) continue
    try {
      await writeSwitch(entry, agent, false, target.repoRoot)
    } catch (err) {
      failed.push(`${agent}: ${err instanceof Error ? err.message : err}`)
    }
  }
  if (failed.length > 0) throw new Error(`couldn't remove it everywhere — ${failed.join(' · ')}`)
  rmSync(libSkillDir(entry.name, target.repoRoot), { recursive: true, force: true })
  saveEntries(
    target.repoRoot,
    entries.filter((e) => !(e.kind === entry.kind && e.name === entry.name))
  )
  return getPanel(target.repoRoot)
}
