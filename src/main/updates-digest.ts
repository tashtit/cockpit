import { isNewer } from '../shared/mcp-source'
import { KIND_LABEL, PROVIDERS, type AgentState } from '../shared/library'
import { sortSuggestions } from '../shared/updates-digest'
import type { Provider, UpdateState, UpdateSuggestion, UpdatesDigest } from '../shared/types'
import { listCliStatus } from './agent-cli'
import { getExtensions } from './extensions'
import { getPanel, mcpVersionsFor } from './library'
import { localCatalogVersions } from './marketplace'

/*
 * Everything on this machine that could be brought up to date, gathered once.
 *
 * Each half of this already existed and each was asked in a different view: the app's
 * own update state in Settings › About, the agent CLIs in Settings › Accounts, a
 * pinned MCP server in the Agents panel, a plugin nowhere at all. This asks all of
 * them together so the home can answer "is anything out of date?" without the person
 * touring four views to find out.
 *
 * On demand and cached, never polled — the same rule every other outward question in
 * Cockpit follows. Every source fails soft and says what it couldn't ask (`problems`):
 * a registry that can't be reached must leave the rest of the list standing.
 *
 * Each source is exported on its own, because that is what can be tested without
 * spawning anything: `updatesDigest` itself is the assembly and the cache.
 */

/** A gathering is reused for this long; the home asks on every visit. */
const TTL_MS = 15 * 60 * 1000

const AGENT_LABEL: Record<Provider, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'Copilot'
}

/** What a drifted row is waiting for, in the panel's own words. */
const DRIFT_WORD: Partial<Record<AgentState, string>> = {
  pending: 'switched on, but not written yet',
  changed: 'the agents run different definitions',
  extra: 'added outside Cockpit'
}

/** One source's answer: what it found, and what it couldn't ask. */
export type Found = {
  readonly items: readonly UpdateSuggestion[]
  readonly problems: readonly string[]
}

const NOTHING: Found = { items: [], problems: [] }

let cached: UpdatesDigest | null = null
/** One gathering at a time: two windows opening home together ask one set of questions. */
let inFlight: Promise<UpdatesDigest> | null = null

export type DigestInputs = {
  /** The app's own update state and the version running — the UpdateManager owns both */
  readonly app?: { readonly state: UpdateState; readonly version: string }
  /** Ask everything again, ignoring what was gathered before (the "Check again" click) */
  readonly force?: boolean
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Cockpit itself, but only while there is something on offer. */
export function appUpdate(app: DigestInputs['app']): Found {
  const state = app?.state
  if (!state?.version) return NOTHING
  if (state.status !== 'available' && state.status !== 'downloading' && state.status !== 'ready') {
    return NOTHING
  }
  return {
    items: [
      {
        kind: 'app',
        id: 'app:cockpit',
        name: 'Cockpit',
        agents: [],
        current: app!.version,
        latest: state.version,
        detail:
          state.status === 'ready'
            ? 'downloaded and ready to install'
            : state.status === 'downloading'
              ? `downloading — ${state.percent ?? 0}%`
              : 'a new release is out'
      }
    ],
    problems: []
  }
}

/** The agent CLIs against the channel each was installed from. */
export async function cliUpdates(force: boolean): Promise<Found> {
  try {
    const rows = await listCliStatus({ force })
    return {
      items: rows
        .filter((s) => s.updateAvailable && s.version && s.latest)
        .map((s) => ({
          kind: 'cli' as const,
          id: `cli:${s.provider}`,
          name: AGENT_LABEL[s.provider],
          agents: [s.provider],
          current: s.version!,
          latest: s.latest!,
          detail: `${s.channel ?? 'its channel'} has ${s.latest}`
        })),
      problems: []
    }
  } catch (err) {
    return { items: [], problems: [`couldn’t check the agent CLIs — ${reason(err)}`] }
  }
}

/** Pinned MCP servers against their registries — the Agents panel's own question. */
export async function mcpUpdates(): Promise<Found> {
  try {
    const versions = await mcpVersionsFor(null)
    const unknown = new Set(versions.filter((v) => v.status === 'unknown').map((v) => v.registry))
    return {
      items: versions
        .filter((v) => v.status === 'update' && v.latest)
        .map((v) => ({
          kind: 'mcp' as const,
          id: `mcp:${v.name}`,
          name: v.name,
          agents: [],
          current: v.current,
          latest: v.latest!,
          detail: `${v.registry} · ${v.pkg}`
        })),
      problems: [...unknown].map((r) => `couldn’t ask ${r} about every pinned MCP server`)
    }
  } catch (err) {
    return { items: [], problems: [`couldn’t check the MCP servers — ${reason(err)}`] }
  }
}

/**
 * A plugin the marketplace beside it has moved past. Only the catalogue cloned on
 * this machine is read — the one the agent would install from — so this never
 * reaches the network, and a marketplace with no clone here has nothing to say.
 */
export function pluginUpdates(): Found {
  try {
    const offered = localCatalogVersions()
    const out = new Map<string, UpdateSuggestion>()
    for (const plugin of getExtensions().plugins) {
      const latest = offered.get(plugin.name)
      if (!latest || !plugin.version || !isNewer(latest, plugin.version)) continue
      const had = out.get(plugin.name)
      out.set(plugin.name, {
        kind: 'plugin',
        id: `plugin:${plugin.name}`,
        name: plugin.name,
        agents: [...(had?.agents ?? []), plugin.agent],
        current: plugin.version,
        latest,
        detail: `${plugin.marketplace ?? 'its marketplace'} has ${latest}`
      })
    }
    return { items: [...out.values()], problems: [] }
  } catch (err) {
    return { items: [], problems: [`couldn’t read the plugin catalogues — ${reason(err)}`] }
  }
}

/**
 * What the agents disagree on. Not an update, but the same question — "is anything
 * out of step?" — and the one place that claims to know must not send you elsewhere
 * to find out. Global only: that is where plugins, marketplaces and the agents' own
 * config homes live, and a repo scope's own drift belongs to that repo's view.
 */
export function agentDrift(): Found {
  try {
    return {
      items: getPanel(null)
        .rows.filter((row) => row.drift.length > 0)
        .map((row) => ({
          kind: 'drift' as const,
          id: `drift:${row.id}`,
          name: row.name,
          agents: PROVIDERS.filter((p) => row.drift.includes(p)),
          detail: `${KIND_LABEL[row.kind]} — ${DRIFT_WORD[row.cells[row.drift[0]].state] ?? 'out of step'}`
        })),
      problems: []
    }
  } catch (err) {
    return { items: [], problems: [`couldn’t read the agents’ own config — ${reason(err)}`] }
  }
}

/**
 * Everything that could be brought up to date. Cached; `force` asks again — and a
 * forced ask never rides on a gathering already in flight, which is the one it was
 * asked to go past.
 */
export function updatesDigest(inputs: DigestInputs = {}): Promise<UpdatesDigest> {
  if (inputs.force !== true) {
    if (cached && Date.now() - cached.at < TTL_MS) return Promise.resolve(cached)
    if (inFlight) return inFlight
  }
  const gather = async (): Promise<UpdatesDigest> => {
    const found = [
      appUpdate(inputs.app),
      ...(await Promise.all([cliUpdates(inputs.force === true), mcpUpdates()])),
      pluginUpdates(),
      agentDrift()
    ]
    return {
      items: sortSuggestions(found.flatMap((f) => f.items)),
      at: Date.now(),
      problems: found.flatMap((f) => f.problems)
    }
  }
  inFlight = gather()
    .then((digest) => {
      cached = digest
      return digest
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

/** Something the digest reports on changed — the next ask gathers afresh. */
export function forgetUpdatesDigest(): void {
  cached = null
}
