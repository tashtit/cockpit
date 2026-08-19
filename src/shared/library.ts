import type {
  ExtensionsInventory,
  InstructionsState,
  LibraryEntry,
  McpConfig,
  PanelKind,
  Provider
} from './types'

/**
 * Reconciliation: Cockpit's own config (what you asked for) against each agent's
 * real config (what it actually has).
 *
 * Cockpit is the source of truth. Every managed thing is a library entry with a
 * per-agent switch: on = write it into that agent, off = keep it out. The agent's
 * own config is read back and compared, so a switch can disagree with reality —
 * something was added behind Cockpit's back, or hand-edited, or the write hasn't
 * been made yet. That disagreement is the whole point of this module: it is named,
 * never silently reconciled.
 *
 * Pure, like instructions-core.ts — the IO (reading agent configs, writing them,
 * running agent CLIs) lives in main/library.ts.
 */

export type AgentState =
  /** switch on, and the agent has it */
  | 'on'
  /** switch off, and the agent doesn't have it */
  | 'off'
  /** switch on, but the agent doesn't have it — never applied, or removed elsewhere */
  | 'pending'
  /** the agent has it, but runs a different definition from the other agents */
  | 'changed'
  /** switch off, yet the agent has it anyway — added outside Cockpit */
  | 'extra'
  /** this agent can't hold this kind of thing in this scope */
  | 'na'

/** The three ways the agent can disagree with its switch. */
export const DRIFT_STATES: readonly AgentState[] = ['pending', 'changed', 'extra']

export function isDrift(state: AgentState): boolean {
  return DRIFT_STATES.includes(state)
}

/** Does the agent actually hold it right now, whatever its switch says? */
export function agentHasIt(state: AgentState): boolean {
  return state === 'on' || state === 'changed' || state === 'extra'
}

export type PanelCell = {
  readonly state: AgentState
  /** what the switch is set to (Cockpit's desired state) */
  readonly desired: boolean
  /** what this agent actually holds ('' when it holds nothing) */
  readonly detail: string
  readonly fields: Readonly<Record<string, string>>
  /** why this agent can't hold it (state 'na' only) */
  readonly reason?: string
}

export type PanelRow = {
  readonly kind: PanelKind
  /** `${kind}:${name}` — stable across reloads */
  readonly id: string
  readonly name: string
  /**
   * The copy Cockpit keeps, so switching an agent back on — or putting the whole
   * entry back after a remove — has something to write. It is a backup, refreshed
   * from whatever the agents run; it is never an authority they are judged against.
   */
  readonly saved: { readonly detail: string; readonly fields: Readonly<Record<string, string>> }
  readonly cells: Readonly<Record<Provider, PanelCell>>
  /** field names, in the order the agents that have it record them */
  readonly fields: readonly string[]
  /** agents whose reality disagrees with their switch, or with the other agents */
  readonly drift: readonly Provider[]
  /** the agents that have it, grouped: more than one group means they disagree */
  readonly holders: readonly Provider[]
  /** true when the agents that have it don't all run the same definition */
  readonly disagree: boolean
  /** taken out of every agent; kept so it can be put back */
  readonly removed?: boolean
}

export type PanelReport = {
  /** null = global (agent home configs); otherwise a repo root */
  readonly repoRoot: string | null
  readonly rows: readonly PanelRow[]
  /** taken out of every agent, kept so they can be put back */
  readonly removed: readonly PanelRow[]
  /** switches on, across every row and agent */
  readonly on: number
  readonly drift: number
  /** kinds that can only be configured globally (project scope only) */
  readonly globalOnly: readonly PanelKind[]
}

export const PROVIDERS: readonly Provider[] = ['claude', 'codex', 'copilot']

export const KIND_LABEL: Record<PanelKind, string> = {
  instructions: 'Instructions',
  mcp: 'MCP servers',
  skill: 'Skills',
  plugin: 'Plugins',
  marketplace: 'Marketplaces'
}

/** One line per section, saying what the section actually controls. */
export const KIND_BLURB: Record<PanelKind, string> = {
  instructions: 'The shared baseline, written into each agent’s own instructions file.',
  mcp: 'Tool servers each agent connects to.',
  skill: 'Skill folders each agent loads.',
  plugin: 'Plugins installed from a marketplace.',
  marketplace: 'Where plugins are installed from.'
}

export const KIND_ORDER: readonly PanelKind[] = [
  'instructions',
  'mcp',
  'skill',
  'plugin',
  'marketplace'
]

/** Plugins and marketplaces are installed per machine — a repo can't scope them. */
export const GLOBAL_ONLY_KINDS: readonly PanelKind[] = ['plugin', 'marketplace']

export function kindsForScope(repoRoot: string | null): readonly PanelKind[] {
  return repoRoot === null ? KIND_ORDER : KIND_ORDER.filter((k) => !GLOBAL_ONLY_KINDS.includes(k))
}

/* ---------- definitions → comparable fields ---------- */

/**
 * An MCP definition reduced to what the agent will actually run. Env vars
 * contribute their *names* only: values hold tokens, they are never rendered, and
 * a row reading "changed" with nothing visibly changed is a lie.
 */
export function mcpFields(config: McpConfig): Record<string, string> {
  return {
    url: config.url ?? '',
    transport: config.url ? (config.type ?? 'http') : '',
    command: config.command ?? '',
    args: (config.args ?? []).join(' '),
    env: Object.keys(config.env ?? {}).sort().join(', ')
  }
}

export function mcpSummary(config: McpConfig): string {
  return config.url ?? [config.command, ...(config.args ?? [])].filter(Boolean).join(' ')
}

/**
 * Same definition? Only fields *both* sides record are compared: an agent that
 * simply doesn't track a version or a source is unknown, not different, and
 * reporting that as drift would light an amber lamp the user can never clear.
 * Extractors that can always answer (mcpFields) emit every key, so for those the
 * comparison stays total.
 */
export function sameFields(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>
): boolean {
  for (const k of Object.keys(a)) {
    if (k in b && a[k] !== b[k]) return false
  }
  return true
}

/* ---------- what an agent actually holds ---------- */

/** One agent's reality for one entry, as read back from its own config. */
export type Actual = {
  readonly present: boolean
  readonly detail: string
  readonly fields: Readonly<Record<string, string>>
  /** set when the agent can't hold this at all */
  readonly reason?: string
  /**
   * This agent is definitively out of step, whatever the others are doing. Only the
   * shared instructions can say this: the baseline is written *in* Cockpit, so it is
   * the one thing Cockpit really does own a version of. Everything else is compared
   * agent-to-agent, because Cockpit keeps a backup rather than an opinion.
   */
  readonly mismatch?: boolean
}

export const ABSENT: Actual = { present: false, detail: '', fields: {} }

/** Cockpit's definition for an entry, in the same comparable shape. */
export type Desired = {
  readonly detail: string
  readonly fields: Readonly<Record<string, string>>
}

/**
 * Which agents run the same thing. Grouped pairwise rather than by a hashed
 * signature, so a field one agent simply doesn't record stays "unknown" instead of
 * splitting it off into a group of its own.
 */
function agreementGroups(
  holders: readonly Provider[],
  actual: Readonly<Partial<Record<Provider, Actual>>>
): Provider[][] {
  const groups: Provider[][] = []
  for (const p of holders) {
    const fields = actual[p]?.fields ?? {}
    const found = groups.find((g) => sameFields(actual[g[0]]?.fields ?? {}, fields))
    if (found) found.push(p)
    else groups.push([p])
  }
  return groups
}

/**
 * The agents that are the odd ones out. When one definition is more common than any
 * other, the agents running it are fine and the rest are flagged. When there is no
 * such definition — two agents, two answers — nobody is right, so both are flagged.
 * Cockpit does not break the tie: it has no version of its own to break it with.
 */
function oddOnesOut(groups: readonly Provider[][]): Provider[] {
  if (groups.length <= 1) return []
  const max = Math.max(...groups.map((g) => g.length))
  const biggest = groups.filter((g) => g.length === max)
  return biggest.length === 1
    ? groups.filter((g) => g !== biggest[0]).flat()
    : groups.flat()
}

export function buildRow(
  entry: LibraryEntry,
  saved: Desired,
  actual: Readonly<Partial<Record<Provider, Actual>>>
): PanelRow {
  const holders = PROVIDERS.filter((p) => (actual[p] ?? ABSENT).present)
  // an authoritative reader supersedes peer comparison: when one exists it already
  // knows who is out of step, and the agents' own fields (a per-agent file path, say)
  // would only split them into groups that mean nothing
  const authoritative = holders.some((p) => actual[p]?.mismatch !== undefined)
  const groups = authoritative ? [holders] : agreementGroups(holders, actual)
  const odd = authoritative ? [] : oddOnesOut(groups)

  const cells = {} as { -readonly [K in Provider]: PanelCell }
  for (const p of PROVIDERS) {
    const a = actual[p] ?? ABSENT
    const on = entry.enabled[p] === true
    if (a.reason) {
      cells[p] = { state: 'na', desired: on, detail: '', fields: {}, reason: a.reason }
      continue
    }
    const base = { desired: on, detail: a.detail, fields: a.fields }
    if (on && !a.present) cells[p] = { ...base, state: 'pending' }
    else if (!on && a.present) cells[p] = { ...base, state: 'extra' }
    else if (!on) cells[p] = { ...base, state: 'off' }
    else cells[p] = { ...base, state: a.mismatch || odd.includes(p) ? 'changed' : 'on' }
  }

  // the diff reads in the order the agents record their fields; the saved copy only
  // fills in names none of them happened to have
  const fields: string[] = []
  for (const p of [...holders, ...PROVIDERS]) {
    for (const k of Object.keys(cells[p].fields)) if (!fields.includes(k)) fields.push(k)
  }
  for (const k of Object.keys(saved.fields)) if (!fields.includes(k)) fields.push(k)

  return {
    kind: entry.kind,
    id: `${entry.kind}:${entry.name}`,
    name: entry.name,
    saved,
    cells,
    fields,
    drift: PROVIDERS.filter((p) => isDrift(cells[p].state)),
    holders,
    disagree: !authoritative && groups.length > 1,
    ...(entry.removed ? { removed: true } : {})
  }
}

export function buildReport(repoRoot: string | null, rows: readonly PanelRow[]): PanelReport {
  const kinds = kindsForScope(repoRoot)
  const live = rows.filter((r) => !r.removed)
  const ordered = kinds.flatMap((kind) =>
    live.filter((r) => r.kind === kind).sort((a, b) => a.name.localeCompare(b.name))
  )
  let on = 0
  let drift = 0
  for (const row of ordered) {
    for (const p of PROVIDERS) {
      if (row.cells[p].state === 'on') on++
      if (isDrift(row.cells[p].state)) drift++
    }
  }
  return {
    repoRoot,
    rows: ordered,
    removed: rows.filter((r) => r.removed).sort((a, b) => a.name.localeCompare(b.name)),
    on,
    drift,
    globalOnly: repoRoot === null ? [] : GLOBAL_ONLY_KINDS
  }
}

/* ---------- adopting what is already on disk ---------- */

/**
 * First open of a scope: everything the agents already have becomes a library entry
 * switched on for the agents that have it. Without this every existing setup would
 * open as a wall of "extra" — Cockpit has to start by agreeing with reality.
 *
 * Idempotent: an entry the library already knows is left exactly as the user set it.
 */
export function adoptInventory(
  existing: readonly LibraryEntry[],
  inv: ExtensionsInventory
): LibraryEntry[] {
  const byId = new Map(existing.map((e) => [`${e.kind}:${e.name}`, e]))
  const add = (entry: LibraryEntry): void => {
    const id = `${entry.kind}:${entry.name}`
    const found = byId.get(id)
    if (!found) {
      byId.set(id, entry)
      return
    }
    // a known entry keeps its switches, but picks up agents the user turned on
    // outside Cockpit only if it has never recorded a decision for them
    const enabled = { ...entry.enabled, ...found.enabled }
    byId.set(id, { ...found, enabled })
  }

  for (const server of inv.mcp) {
    const enabled: Partial<Record<Provider, boolean>> = {}
    for (const p of server.presences) enabled[p.agent] = true
    const config = server.presences[0]?.config ?? server.config
    add({ kind: 'mcp', name: server.name, enabled, config })
  }
  for (const skill of inv.skills) {
    add({ kind: 'skill', name: skill.name, enabled: { [skill.agent]: true } })
  }
  for (const plugin of inv.plugins) {
    add({
      kind: 'plugin',
      name: plugin.name,
      enabled: { [plugin.agent]: true },
      source: plugin.marketplace
    })
  }
  for (const market of inv.marketplaces) {
    add({ kind: 'marketplace', name: market.name, enabled: { [market.agent]: true }, source: market.source })
  }
  return [...byId.values()]
}

/* ---------- instructions as a library row ---------- */

const INSTRUCTION_DETAIL: Record<InstructionsState['files'][number]['status'], string> = {
  synced: 'carries the current baseline',
  drifted: 'block differs from the baseline',
  unmanaged: 'file exists, no shared block',
  missing: 'no file yet'
}

export function shortPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~')
}

/**
 * The shared baseline as one row. Its switch means "keep this agent's file in sync";
 * a repo-scope AGENTS.md is read by two agents, so one file fills two cells.
 */
export function instructionRow(state: InstructionsState, entry: LibraryEntry): PanelRow {
  const actual: Partial<Record<Provider, Actual>> = {}
  for (const file of state.files) {
    for (const agent of file.agents) {
      actual[agent] = {
        present: file.status === 'synced' || file.status === 'drifted',
        detail: `${shortPath(file.path)} — ${INSTRUCTION_DETAIL[file.status]}`,
        mismatch: file.status === 'drifted',
        // every file holds the same baseline, so they never differ from each other —
        // only from the baseline itself, which `mismatch` carries
        fields: { file: shortPath(file.path) }
      }
    }
  }
  // the entry's own first line is far more use here than restating the row's name
  const firstLine = state.baseline.trim().split('\n')[0].replace(/^#+\s*/, '')
  const detail = firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine
  return buildRow(entry, { detail, fields: {} }, actual)
}
