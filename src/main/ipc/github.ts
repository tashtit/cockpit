import { ipcMain } from 'electron'
import { resolve } from 'node:path'
import { CH } from '../../shared/contract'
import { branchPrefix, setBranchPrefix } from '../config'
import { isUnder, spelledOnDisk } from '../paths'
import { getDefaultBranch, getPrs } from '../github'
import { branchPrefixClashAmong, createPr, createWorkspace, worktreesDir } from '../workspace'
import { DEFAULT_BRANCH_PREFIX, branchPrefixRefusal, normalizeBranchPrefix } from '../../shared/branch-prefix'
import { asDiffScope, getWorkspaceDiff } from '../diff'
import { asPrNumber, getPrFeedback, getPrFixBriefing } from '../pr-feedback'
import type { Services } from '../services'
import { assertKnownCwd, assertKnownRepoRoot } from './guards'

/** Worktrees, their review, and GitHub: PR badges, a PR's feedback, opening one. */
export function registerGithubHandlers(s: Services): void {
  const { indexer } = s

  ipcMain.handle(CH.githubPrs, async (_e, repoRoot: string) => {
    const root = assertKnownRepoRoot(indexer, repoRoot)
    const prs = await getPrs(root)
    // the badges' own refresh is the only time GitHub is asked — a red PR on a session's
    // branch is handed to the desk from it, never polled for
    s.desk.prsUpdated(root, prs, (pr) => s.prCarrier(root, pr))
    return prs
  })
  ipcMain.handle(CH.githubDefaultBranch, (_e, repoRoot: string) =>
    getDefaultBranch(assertKnownRepoRoot(indexer, repoRoot))
  )
  // an open PR's feedback and its fix prompt: the root is one the indexer derived,
  // and the number is renderer input that only ever reaches gh as a positive integer
  ipcMain.handle(CH.githubPrFeedback, (_e, repoRoot: string, n: unknown) =>
    getPrFeedback(assertKnownRepoRoot(indexer, repoRoot), asPrNumber(n))
  )
  ipcMain.handle(CH.githubPrFix, (_e, repoRoot: string, n: unknown) =>
    getPrFixBriefing(assertKnownRepoRoot(indexer, repoRoot), asPrNumber(n))
  )

  ipcMain.handle(CH.workspaceCreate, (_e, repoRoot: string, name?: string) =>
    createWorkspace(assertKnownRepoRoot(indexer, repoRoot), name, { prefix: branchPrefix() })
  )
  ipcMain.handle(CH.workspaceBranchPrefix, () => branchPrefix())
  // renderer input: normalized and checked in main against the same rule the form shows,
  // then against the branches of every repository Cockpit knows — `main/` where there is
  // a `main` would fail every new session there
  ipcMain.handle(CH.workspaceSetBranchPrefix, async (_e, prefix: unknown) => {
    const raw = String(prefix ?? '')
    const next = normalizeBranchPrefix(raw)
    // the default is what an empty prefix means, so refusing it would leave nothing to go back to
    if (next !== '' && next !== DEFAULT_BRANCH_PREFIX && branchPrefixRefusal(next) === null) {
      const clash = await branchPrefixClashAmong([...indexer.knownRepoRoots()], next)
      if (clash) throw new Error(clash)
    }
    return setBranchPrefix(raw)
  })
  ipcMain.handle(CH.workspacePr, (_e, cwd: string) => {
    const c = resolve(String(cwd))
    // the worktrees dir itself is not a workspace — only something cut inside it. Both as
    // the disk spells them: a session's agent may have written the folder in another case
    // than Cockpit made it in, and on macOS that is the same folder
    const root = spelledOnDisk(worktreesDir())
    const at = spelledOnDisk(c)
    const underWorktrees = at !== root && isUnder(at, root)
    const underKnownRoot = [...indexer.knownRepoRoots()].some((r) => isUnder(c, r))
    if (!underWorktrees && !underKnownRoot) throw new Error(`unknown workspace: ${c}`)
    return createPr(c)
  })
  // review before landing: the diff is read-only, so any dir a chat may run in is
  // fair to inspect; the scope is renderer input and is re-checked before it
  // selects git arguments
  ipcMain.handle(CH.workspaceDiff, (_e, cwd: string, scope: unknown) =>
    getWorkspaceDiff(assertKnownCwd(indexer, cwd), asDiffScope(scope))
  )
}
