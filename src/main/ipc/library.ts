import { ipcMain } from 'electron'
import type { PanelTarget, Provider } from '../../shared/types'
import { CH } from '../../shared/contract'
import {
  getPanel,
  keepPanelDifference,
  matchPanelEntry,
  mcpVersionsFor,
  removePanelEntry,
  restorePanelEntry,
  setMcpVersion,
  setPanelSwitch
} from '../library'
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

/** The Agents view: extensions, the per-scope panel, and shared instructions. */
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
    setMcpVersion(asTarget(target), String(version))
  )

  ipcMain.handle(CH.panelGet, (_e, repoRoot: string | null) => getPanel(asScope(repoRoot)))
  ipcMain.handle(CH.panelSetSwitch, (_e, target: PanelTarget, agent: Provider, on: boolean) =>
    setPanelSwitch(asTarget(target), asProvider(agent), Boolean(on))
  )
  ipcMain.handle(CH.panelMatch, (_e, target: PanelTarget, source: Provider) =>
    matchPanelEntry(asTarget(target), asProvider(source))
  )
  ipcMain.handle(CH.panelKeep, (_e, target: PanelTarget, keep: boolean) =>
    keepPanelDifference(asTarget(target), Boolean(keep))
  )
  ipcMain.handle(CH.panelRemove, (_e, target: PanelTarget) => removePanelEntry(asTarget(target)))
  ipcMain.handle(CH.panelRestore, (_e, target: PanelTarget) => restorePanelEntry(asTarget(target)))

  // instruction scopes come from the renderer — null = global, else a repo the
  // indexer itself derived (never an arbitrary path)
  const instructionScope = (repoRoot: unknown): string | null =>
    repoRoot === null ? null : assertKnownRepoRoot(indexer, repoRoot)
  ipcMain.handle(CH.instructionsGet, (_e, repoRoot: string | null) =>
    getInstructions(instructionScope(repoRoot))
  )
  ipcMain.handle(CH.instructionsSaveBaseline, (_e, repoRoot: string | null, baseline: string) =>
    saveBaseline(instructionScope(repoRoot), String(baseline))
  )
  ipcMain.handle(CH.instructionsApply, (_e, repoRoot: string | null, onlyPath?: string) =>
    applyInstructions(instructionScope(repoRoot), onlyPath ? String(onlyPath) : undefined)
  )
  ipcMain.handle(
    CH.instructionsSaveFile,
    (_e, repoRoot: string | null, path: string, content: string) =>
      saveInstructionFile(instructionScope(repoRoot), String(path), String(content))
  )
  ipcMain.handle(CH.instructionsAdoptFile, (_e, repoRoot: string | null, path: string) =>
    adoptInstructionsFrom(instructionScope(repoRoot), String(path))
  )
  ipcMain.handle(CH.instructionsShare, (_e, repoRoot: string) =>
    shareInstructions(assertKnownRepoRoot(indexer, repoRoot), branchPrefix())
  )
}
