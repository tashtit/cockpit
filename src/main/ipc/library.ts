import { ipcMain } from 'electron'
import type { PanelTarget, Provider } from '../../shared/types'
import { CH } from '../../shared/contract'
import {
  addFromCatalog,
  getPanel,
  keepPanelDifference,
  leavePanelOff,
  matchPanelEntry,
  mcpVersionsFor,
  removePanelEntry,
  restorePanelEntry,
  setMcpVersion,
  setPanelSwitch,
  updatePlugin
} from '../library'
import { listCatalogs, lookupCatalog } from '../marketplace'
import { addFromRegistry, searchRegistry } from '../mcp-registry'
import { forgetUpdatesDigest, pluginUpdates } from '../updates-digest'
import { assertClaudeProjectServer, getExtensions, getMcpConfig } from '../extensions'
import { loginMcp, probeMcp } from '../mcp'
import {
  adoptInstructionsFrom,
  applyInstructions,
  getInstructions,
  saveBaseline,
  saveInstructionFile
} from '../instructions'
import { shareInstructions } from '../instructions-share'
import { branchPrefix } from '../config'
import type { Services } from '../services'
import { asPanelKind, asProvider, assertKnownRepoRoot } from './guards'

/**
 * A write the home's updates list reports on. That list is gathered on demand and
 * cached, so anything settled here has to forget it — otherwise fixing drift in the
 * Agents view leaves the home claiming it for another quarter of an hour.
 */
async function settled<T>(work: T | Promise<T>): Promise<T> {
  const done = await work
  forgetUpdatesDigest()
  return done
}

/** The Agents view: extensions, the per-scope panel, browsing, and shared instructions. */
export function registerLibraryHandlers(s: Services): void {
  const { indexer } = s

  /*
   * The panel: Cockpit's own config for one scope. A scope is either global or a
   * repo root the indexer itself derived — never an arbitrary renderer path, since
   * these handlers write config files and run agent CLIs inside it.
   */
  const asScope = (repoRoot: unknown): string | null =>
    repoRoot === null || repoRoot === undefined ? null : assertKnownRepoRoot(indexer, repoRoot)
  const asTarget = (t: PanelTarget): PanelTarget => ({
    repoRoot: asScope(t?.repoRoot),
    kind: asPanelKind(t?.kind),
    name: String(t?.name ?? '')
  })

  ipcMain.handle(CH.extensionsGet, () => getExtensions())
  ipcMain.handle(CH.extensionsCheckMcp, (_e, name: string) => probeMcp(getMcpConfig(String(name))))
  // agent comes from the renderer and becomes a spawned command — only the three known providers
  ipcMain.handle(CH.extensionsLoginMcp, (_e, name: string, agent: Provider, projectPath?: string) => {
    const provider = asProvider(agent)
    // projectPath is renderer input — only trust it once it matches a claude
    // project entry read from ~/.claude.json itself
    const cwd =
      provider === 'claude' && projectPath
        ? assertClaudeProjectServer(String(name), String(projectPath))
        : undefined
    return loginMcp(String(name), provider, { cwd })
  })
  ipcMain.handle(CH.extensionsMcpVersions, (_e, repoRoot: string | null) =>
    mcpVersionsFor(asScope(repoRoot))
  )
  ipcMain.handle(CH.extensionsSetMcpVersion, (_e, target: PanelTarget, version: string) =>
    settled(setMcpVersion(asTarget(target), String(version)))
  )

  ipcMain.handle(CH.panelGet, (_e, repoRoot: string | null) => getPanel(asScope(repoRoot)))
  ipcMain.handle(CH.panelSetSwitch, (_e, target: PanelTarget, agent: Provider, on: boolean) =>
    settled(setPanelSwitch(asTarget(target), asProvider(agent), Boolean(on)))
  )
  ipcMain.handle(CH.panelMatch, (_e, target: PanelTarget, source: Provider) =>
    settled(matchPanelEntry(asTarget(target), asProvider(source)))
  )
  ipcMain.handle(CH.panelKeep, (_e, target: PanelTarget, keep: boolean) =>
    settled(keepPanelDifference(asTarget(target), Boolean(keep)))
  )
  ipcMain.handle(CH.panelLeaveOff, (_e, target: PanelTarget, agent: Provider) =>
    settled(leavePanelOff(asTarget(target), asProvider(agent)))
  )
  ipcMain.handle(CH.panelRemove, (_e, target: PanelTarget) => settled(removePanelEntry(asTarget(target))))
  ipcMain.handle(CH.panelRestore, (_e, target: PanelTarget) => settled(restorePanelEntry(asTarget(target))))

  /*
   * Browsing: what the marketplaces hold, and adding one of them. The listing reads
   * the clones on this machine and never the network; a lookup is the one call that
   * does, and only ever from a click. `source` is renderer input on its way into a
   * URL and an agent's command line — `lookupCatalog` takes GitHub's `owner/repo`
   * alone, and `addFromCatalog` refuses a source no agent could be pointed at.
   */
  ipcMain.handle(CH.marketplacesList, () => listCatalogs())
  ipcMain.handle(CH.marketplacesLookup, (_e, source: unknown) => lookupCatalog(String(source ?? '')))
  ipcMain.handle(CH.marketplacesAdd, (_e, item: unknown, agent: unknown) => {
    const asked = (item ?? {}) as { kind?: unknown; name?: unknown; source?: unknown }
    if (asked.kind !== 'marketplace' && asked.kind !== 'plugin') throw new Error('unknown kind')
    return settled(
      addFromCatalog(
        {
          kind: asked.kind,
          name: String(asked.name ?? ''),
          ...(typeof asked.source === 'string' ? { source: asked.source } : {})
        },
        asProvider(agent)
      )
    )
  })

  /*
   * The MCP Registry: a search is the one call that fetches, and only from a submit.
   * An add names a registry server and carries what was typed for its inputs — main
   * rebuilds the definition from the registry's own entry, so no command ever arrives
   * from the renderer.
   */
  ipcMain.handle(CH.mcpRegistrySearch, (_e, query: unknown, cursor: unknown) =>
    searchRegistry(String(query ?? ''), typeof cursor === 'string' ? cursor : undefined)
  )
  ipcMain.handle(CH.mcpRegistryAdd, (_e, req: unknown) => {
    const asked = (req ?? {}) as { id?: unknown; version?: unknown; agent?: unknown; values?: unknown }
    const values: Record<string, string> = {}
    if (asked.values && typeof asked.values === 'object') {
      for (const [k, v] of Object.entries(asked.values as Record<string, unknown>).slice(0, 50)) {
        if (typeof v === 'string') values[String(k).slice(0, 64)] = v
      }
    }
    return settled(
      addFromRegistry({
        id: String(asked.id ?? '').slice(0, 200),
        version: String(asked.version ?? '').slice(0, 64),
        agent: asProvider(asked.agent),
        values
      })
    )
  })

  // plugins a clone here has moved past — local reads only, the Agents panel asks on open
  ipcMain.handle(CH.pluginsOutdated, () => pluginUpdates().items)
  ipcMain.handle(CH.pluginsUpdate, (_e, id: unknown) => settled(updatePlugin(String(id ?? ''))))

  // instruction scopes come from the renderer — null = global, else a repo the
  // indexer itself derived (never an arbitrary path)
  const instructionScope = (repoRoot: unknown): string | null =>
    repoRoot === null ? null : assertKnownRepoRoot(indexer, repoRoot)
  ipcMain.handle(CH.instructionsGet, (_e, repoRoot: string | null) =>
    getInstructions(instructionScope(repoRoot))
  )
  // each of these can settle (or open) a drift the home's updates list reports
  ipcMain.handle(CH.instructionsSaveBaseline, (_e, repoRoot: string | null, baseline: string) =>
    settled(saveBaseline(instructionScope(repoRoot), String(baseline)))
  )
  ipcMain.handle(CH.instructionsApply, (_e, repoRoot: string | null, onlyPath?: string) =>
    settled(applyInstructions(instructionScope(repoRoot), onlyPath ? String(onlyPath) : undefined))
  )
  ipcMain.handle(
    CH.instructionsSaveFile,
    (_e, repoRoot: string | null, path: string, content: string) =>
      settled(saveInstructionFile(instructionScope(repoRoot), String(path), String(content)))
  )
  ipcMain.handle(CH.instructionsAdoptFile, (_e, repoRoot: string | null, path: string) =>
    settled(adoptInstructionsFrom(instructionScope(repoRoot), String(path)))
  )
  ipcMain.handle(CH.instructionsShare, (_e, repoRoot: string) =>
    shareInstructions(assertKnownRepoRoot(indexer, repoRoot), branchPrefix())
  )
}
