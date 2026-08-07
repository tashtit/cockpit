import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RepoInfo } from '../shared/types'

export const GENERAL_REPO: RepoInfo = { key: 'general', name: 'General', fullName: null, root: null }

export interface ResolvedRepo {
  repo: RepoInfo
  isWorktree: boolean
}

/** cwd → resolution cache. Session cwds repeat heavily; resolution is pure fs reads. */
const cwdCache = new Map<string, ResolvedRepo | null>()
/** main repo root → RepoInfo (so worktrees share one object) */
const rootCache = new Map<string, RepoInfo>()

export function clearRepoCache(): void {
  cwdCache.clear()
  rootCache.clear()
}

/**
 * Resolve the git repository a session cwd belongs to. Worktree cwds resolve to the
 * main repo so all worktrees group under one repository. Tolerates deleted cwds
 * (e.g. removed worktrees) by walking ancestors that still exist.
 */
export function resolveRepo(cwd: string | null): ResolvedRepo | null {
  if (!cwd || !cwd.startsWith('/')) return null
  const cached = cwdCache.get(cwd)
  if (cached !== undefined) return cached
  const res = resolveUncached(resolve(cwd))
  cwdCache.set(cwd, res)
  return res
}

function resolveUncached(cwd: string): ResolvedRepo | null {
  let dir = cwd
  while (true) {
    const gitPath = join(dir, '.git')
    if (existsSync(gitPath)) {
      const res = fromGitPath(dir, gitPath)
      if (res) return res
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function fromGitPath(workRoot: string, gitPath: string): ResolvedRepo | null {
  try {
    if (statSync(gitPath).isDirectory()) {
      return { repo: repoInfoFor(workRoot, join(gitPath, 'config')), isWorktree: false }
    }
    // .git file: "gitdir: /path/to/main/.git/worktrees/<name>"
    const m = readFileSync(gitPath, 'utf8').match(/^gitdir:\s*(.+)\s*$/m)
    if (!m) return null
    const gitdir = resolve(dirname(gitPath), m[1].trim())
    const wt = gitdir.match(/^(.*)\/\.git\/worktrees\/[^/]+$/)
    if (wt) {
      const mainRoot = wt[1]
      return { repo: repoInfoFor(mainRoot, join(mainRoot, '.git', 'config')), isWorktree: true }
    }
    // submodule or detached gitdir — treat this checkout as its own repo
    return { repo: repoInfoFor(workRoot, join(gitdir, 'config')), isWorktree: false }
  } catch {
    return null
  }
}

function repoInfoFor(root: string, configPath: string): RepoInfo {
  const cached = rootCache.get(root)
  if (cached) return cached
  const info: RepoInfo = {
    key: root,
    name: basename(root),
    fullName: parseOriginFullName(configPath),
    root
  }
  rootCache.set(root, info)
  return info
}

/** Parse owner/repo out of the [remote "origin"] url in a git config file. */
export function parseOriginFullName(configPath: string): string | null {
  let raw: string
  try {
    raw = readFileSync(configPath, 'utf8')
  } catch {
    return null
  }
  const section = raw.match(/\[remote "origin"\]([^[]*)/)
  const url = section?.[1].match(/^\s*url\s*=\s*(.+)\s*$/m)?.[1].trim()
  if (!url) return null
  return fullNameFromUrl(url)
}

export function fullNameFromUrl(url: string): string | null {
  // git@github.com:owner/repo.git | https://github.com/owner/repo.git | ssh://git@github.com/owner/repo
  const m =
    url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/) ??
    url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/)
  if (!m) return null
  return `${m[1]}/${m[2]}`
}
