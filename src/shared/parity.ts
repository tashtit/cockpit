import type {
  ExtensionsInventory,
  InstructionsState,
  McpConfig,
  ParityKind,
  Provider,
  SyncKind
} from './types'

/**
 * Cross-agent parity: one row per shared thing (an MCP server, a skill, a plugin,
 * a marketplace, the shared instructions), one cell per agent.
 *
 * Pure — it derives everything from the inventory + instructions the renderer already
 * holds, so the Compare view needs no extra IPC read. The IO-shaped half (reading each
 * agent's own config format, writing a sync) lives in `main/extensions.ts`.
 *
 * The comparison is deliberately about *what the agent will run*: an MCP server's
 * command/args/url and the names of its env vars, a skill's SKILL.md, a plugin's
 * version. Env *values* are never compared — they hold tokens, they'd never be
 * rendered, and a row reading "differs" with nothing visibly different is a lie.
 */

export type ParityState =
  /** the agent has it, and it matches every other agent that has it */
  | 'present'
  /** the agent has it, but its definition differs from the reference agent's */
  | 'differs'
  /** the agent doesn't have it */
  | 'missing'
  /** the agent can't hold this kind of thing at all */
  | 'na'

export type ParityCell = {
  readonly state: ParityState
  /** one-line summary of what this agent holds ('' when it holds nothing) */
  readonly detail: string
  /** field-by-field definition, for the side-by-side diff */
  readonly fields: Readonly<Record<string, string>>
  /** why the agent can't hold it (state 'na' only) */
  readonly reason?: string
}

export type ParityRow = {
  readonly kind: ParityKind
  /** `${kind}:${name}` — stable across reloads, used as the React key and expand id */
  readonly id: string
  readonly name: string
  readonly cells: Readonly<Record<Provider, ParityCell>>
  /** field names in reference-agent order, then any extras — the diff table's rows */
  readonly fields: readonly string[]
  /** two agents hold it with different definitions */
  readonly diverged: boolean
  /** at least one agent has it and at least one that could is missing it */
  readonly incomplete: boolean
  /** the agent that other agents are compared against (and synced from) */
  readonly reference: Provider | null
}

export type ParityReport = {
  readonly rows: readonly ParityRow[]
  readonly total: number
  readonly aligned: number
  readonly diverged: number
  readonly incomplete: number
}

export const PROVIDERS: readonly Provider[] = ['claude', 'codex', 'copilot']

export const KIND_LABEL: Record<ParityKind, string> = {
  instructions: 'Instructions',
  mcp: 'MCP servers',
  skill: 'Skills',
  plugin: 'Plugins',
  marketplace: 'Marketplaces'
}

/** Row groups, in the order the Compare view stacks them. */
export const KIND_ORDER: readonly ParityKind[] = [
  'instructions',
  'mcp',
  'skill',
  'plugin',
  'marketplace'
]

/** Kinds Cockpit can write itself — 'instructions' syncs through its own apply path. */
export const SYNC_KINDS: readonly SyncKind[] = ['mcp', 'skill', 'plugin', 'marketplace']

/** What one agent holds. `sig === null` = present but not comparable (nothing to diff on). */
type Held = {
  readonly sig: string | null
  readonly detail: string
  readonly fields: Readonly<Record<string, string>>
}

const EMPTY_CELL: ParityCell = { state: 'missing', detail: '', fields: {} }

/**
 * Pick the agent every other agent is compared (and synced) from: the definition the
 * most agents already agree on, ties broken by provider order so the reference — and
 * therefore which agents read as "differs" — never flips between reloads.
 */
function pickReference(held: ReadonlyMap<Provider, Held>): Provider | null {
  let best: Provider | null = null
  let bestVotes = -1
  for (const p of PROVIDERS) {
    const h = held.get(p)
    if (!h) continue
    const votes =
      h.sig === null ? 0 : [...held.values()].filter((o) => o.sig !== null && o.sig === h.sig).length
    if (votes > bestVotes) {
      best = p
      bestVotes = votes
    }
  }
  return best
}

/** Ordered union of field names: the reference agent's first, then anything only others have. */
function unionFields(held: ReadonlyMap<Provider, Held>, reference: Provider | null): string[] {
  const out: string[] = []
  const push = (h: Held | undefined): void => {
    for (const k of Object.keys(h?.fields ?? {})) if (!out.includes(k)) out.push(k)
  }
  if (reference) push(held.get(reference))
  for (const p of PROVIDERS) push(held.get(p))
  return out
}

function buildRow(
  kind: ParityKind,
  name: string,
  held: ReadonlyMap<Provider, Held>,
  na: Partial<Record<Provider, string>> = {}
): ParityRow {
  const reference = pickReference(held)
  const refSig = reference ? held.get(reference)!.sig : null
  const cells = {} as { -readonly [K in keyof ParityRow['cells']]: ParityCell }
  let diverged = false
  let incomplete = false
  for (const p of PROVIDERS) {
    const h = held.get(p)
    if (h) {
      // a null signature means "present, but nothing worth diffing" — never "differs"
      const differs = h.sig !== null && refSig !== null && h.sig !== refSig
      if (differs) diverged = true
      cells[p] = { state: differs ? 'differs' : 'present', detail: h.detail, fields: h.fields }
    } else if (na[p]) {
      cells[p] = { ...EMPTY_CELL, state: 'na', reason: na[p] }
    } else {
      cells[p] = EMPTY_CELL
      if (held.size > 0) incomplete = true
    }
  }
  return {
    kind,
    id: `${kind}:${name}`,
    name,
    cells,
    fields: unionFields(held, reference),
    diverged,
    incomplete,
    reference
  }
}

/* ---------- per-kind readers ---------- */

/**
 * One agent's MCP definition, reduced to what it will actually run. Env vars
 * contribute their *names* only — see the module comment.
 */
export function mcpFields(config: McpConfig): Record<string, string> {
  const fields: Record<string, string> = {}
  if (config.url) {
    fields.transport = config.type ?? 'http'
    fields.url = config.url
  }
  if (config.command) fields.command = config.command
  if (config.args?.length) fields.args = config.args.join(' ')
  const env = Object.keys(config.env ?? {}).sort()
  if (env.length > 0) fields.env = env.join(', ')
  return fields
}

function mcpHeld(config: McpConfig): Held {
  const fields = mcpFields(config)
  return {
    sig: JSON.stringify(fields),
    detail: config.url ?? [config.command, ...(config.args ?? [])].filter(Boolean).join(' '),
    fields
  }
}

function mcpRows(inv: ExtensionsInventory): ParityRow[] {
  return inv.mcp.map((server) => {
    const held = new Map<Provider, Held>()
    for (const presence of server.presences) {
      // user scope is the agent's real answer; a project entry only fills in for an
      // agent that has no global one, so the row still shows that agent as having it
      if (held.has(presence.agent) && presence.scope !== 'user') continue
      held.set(presence.agent, mcpHeld(presence.config))
    }
    return buildRow('mcp', server.name, held)
  })
}

function skillRows(inv: ExtensionsInventory): ParityRow[] {
  const byName = new Map<string, Map<Provider, Held>>()
  for (const skill of inv.skills) {
    const held = byName.get(skill.name) ?? new Map<Provider, Held>()
    held.set(skill.agent, {
      sig: skill.fingerprint || null,
      detail: skill.description || skill.path,
      fields: { description: skill.description, path: skill.path }
    })
    byName.set(skill.name, held)
  }
  return [...byName].map(([name, held]) => buildRow('skill', name, held))
}

function pluginRows(inv: ExtensionsInventory): ParityRow[] {
  const byName = new Map<string, Map<Provider, Held>>()
  for (const plugin of inv.plugins) {
    const held = byName.get(plugin.name) ?? new Map<Provider, Held>()
    held.set(plugin.agent, {
      // agents don't all record a version; comparing on one they don't have would
      // report a difference that isn't there, so an unknown version compares equal
      sig: plugin.version ?? null,
      detail: plugin.version ? `v${plugin.version}` : (plugin.detail ?? ''),
      fields: {
        ...(plugin.marketplace ? { marketplace: plugin.marketplace } : {}),
        ...(plugin.version ? { version: plugin.version } : {})
      }
    })
    byName.set(plugin.name, held)
  }
  return [...byName].map(([name, held]) => buildRow('plugin', name, held))
}

function marketplaceRows(inv: ExtensionsInventory): ParityRow[] {
  const byName = new Map<string, Map<Provider, Held>>()
  for (const market of inv.marketplaces) {
    const held = byName.get(market.name) ?? new Map<Provider, Held>()
    held.set(market.agent, {
      // a locally-cached marketplace has no shareable source; don't diff on the path
      sig: market.source && !market.source.startsWith('/') ? market.source : null,
      detail: market.source ?? '',
      fields: market.source ? { source: market.source } : {}
    })
    byName.set(market.name, held)
  }
  return [...byName].map(([name, held]) => buildRow('marketplace', name, held))
}

const INSTRUCTION_DETAIL = {
  synced: 'carries the current baseline',
  drifted: 'block differs from the baseline',
  unmanaged: 'file exists, no shared block',
  missing: 'no file yet'
} as const

/**
 * The shared baseline as one row: each agent's own instructions file is a cell.
 * A repo-scope AGENTS.md is read by two agents, so one file can fill two cells.
 * With no baseline written there is nothing to be in or out of sync with.
 */
function instructionRows(state: InstructionsState | null): ParityRow[] {
  if (!state || state.baseline.trim() === '') return []
  const held = new Map<Provider, Held>()
  for (const file of state.files) {
    for (const agent of file.agents) {
      if (file.status === 'missing' || file.status === 'unmanaged') continue
      held.set(agent, {
        // 'synced' agents share one signature; each drifted file is its own
        sig: file.status === 'synced' ? 'synced' : `drifted:${file.path}`,
        detail: `${file.path.replace(/^\/Users\/[^/]+/, '~')} — ${INSTRUCTION_DETAIL[file.status]}`,
        fields: { file: file.path.replace(/^\/Users\/[^/]+/, '~'), state: INSTRUCTION_DETAIL[file.status] }
      })
    }
  }
  const name = state.repoRoot === null ? 'Global baseline' : `Baseline · ${state.repoRoot.split('/').pop()}`
  return [buildRow('instructions', name, held)]
}

/* ---------- report ---------- */

export function buildParity(
  inv: ExtensionsInventory,
  instructions: InstructionsState | null = null
): ParityReport {
  const byKind: Record<ParityKind, ParityRow[]> = {
    instructions: instructionRows(instructions),
    mcp: mcpRows(inv),
    skill: skillRows(inv),
    plugin: pluginRows(inv),
    marketplace: marketplaceRows(inv)
  }
  const rows = KIND_ORDER.flatMap((kind) =>
    [...byKind[kind]].sort((a, b) => a.name.localeCompare(b.name))
  )
  return {
    rows,
    total: rows.length,
    aligned: rows.filter((r) => !r.diverged && !r.incomplete).length,
    diverged: rows.filter((r) => r.diverged).length,
    incomplete: rows.filter((r) => r.incomplete).length
  }
}

/** Agents that could receive `row` from its reference agent. */
export function syncTargets(row: ParityRow): Provider[] {
  return PROVIDERS.filter((p) => {
    const state = row.cells[p].state
    return state === 'missing' || state === 'differs'
  })
}
