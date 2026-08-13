import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { RepoInfo } from '../shared/types'

export const GENERAL_REPO: RepoInfo = { key: 'general', name: 'General', fullName: null, root: null }

export type ResolvedRepo = {
  readonly repo: RepoInfo
  readonly isWorktree: boolean
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

/** Split a git remote into host + trailing owner/repo, for both URL and scp-like forms. */
function parseRemoteUrl(url: string): { host: string; fullName: string } | null {
  const trimmed = url.trim()
  // scheme://[user@]host[:port]/path — tried first, since the scp pattern below
  // would otherwise read "https" as the host
  const withScheme = trimmed.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/)
  // [user@]host:path
  const scp = trimmed.match(/^(?:[^@/]+@)?([^/:]+):(.+)$/)
  const m = withScheme ?? scp
  if (!m) return null
  const parts = m[2]
    .replace(/\/+$/, '') // trailing slash first, so a ".git/" suffix still strips
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean)
  if (parts.length < 2) return null
  return { host: m[1].toLowerCase(), fullName: `${parts.at(-2)}/${parts.at(-1)}` }
}

/**
 * The GitHub `owner/repo` identity, or null for anything else.
 *
 * Only github.com qualifies: the `gh:owner/repo` group key asserts "the same
 * GitHub repository", and `gh` operations are keyed off it. Accepting any host
 * meant a GitLab (or bare local-path) remote was branded with a GitHub identity
 * and merged into the group of a real GitHub repo with the same owner/repo.
 * Everything else groups by local root instead.
 */
/**
 * github.com, plus the `Host github.com-work` style aliases people define in
 * ~/.ssh/config to juggle several GitHub accounts — those resolve to github.com,
 * so the repos behind them are the same repos. The alias suffix deliberately
 * excludes dots, so a real domain like `github.com-evil.com` is not swept in.
 */
function isGitHubHost(host: string): boolean {
  return /^(www\.)?github\.com(-[a-z0-9_-]+)?$/.test(host)
}

export function fullNameFromUrl(url: string): string | null {
  const parsed = parseRemoteUrl(url)
  return parsed && isGitHubHost(parsed.host) ? parsed.fullName : null
}
