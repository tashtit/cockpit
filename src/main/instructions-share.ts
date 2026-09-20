import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { ShareResult } from '../shared/types'
import { execText } from './env'
import { getInstructions } from './instructions'
import { allCarryBaseline, foldTargets, instructionTargets, upsertSharedBlock } from './instructions-core'
import { isUnder } from './paths'
import { resolveRepo } from './repos'
import { createPr, createWorkspace, removeWorkspace } from './workspace'

/*
 * Sharing a repo's instructions with the people who work on it.
 *
 * The repo is the medium: the baseline goes into the repo's own CLAUDE.md and
 * AGENTS.md, through a pull request, and teammates receive it the way they
 * receive everything else — by pulling. Cockpit holds no share repo and no
 * subscriptions, and nothing is pushed to anyone's machine.
 *
 * The write happens in a fresh worktree off the default branch, never in the
 * user's checkout: "always worktrees, always PRs".
 */

const BRANCH_PREFIX = 'share-instructions'
const SHARE_COMMIT = 'docs: update shared agent instructions'

async function git(args: readonly string[], cwd: string): Promise<string> {
  const r = await execText('git', args, { cwd, timeoutMs: 120_000 })
  if (!r.ok) throw new Error(r.stderr.trim() || r.stdout.trim() || r.error || 'git failed')
  return r.stdout.trim()
}

/** `origin/main` — symbolic-ref already prints it with the remote, so never re-prefix it. */
async function defaultBranch(repoRoot: string): Promise<string> {
  const head = await execText('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
    cwd: repoRoot
  })
  if (head.ok && head.stdout.trim()) return head.stdout.trim()
  const gh = await execText(
    'gh',
    ['repo', 'view', '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name'],
    { cwd: repoRoot }
  )
  const name = gh.ok ? gh.stdout.trim() : ''
  if (!name) throw new Error("couldn't work out the repo's default branch — is `origin` a GitHub remote?")
  return `origin/${name}`
}

/** One file of a scope, as the base branch has it (null when absent there). */
async function fileAtBase(repoRoot: string, base: string, path: string): Promise<string | null> {
  const rel = relative(repoRoot, path)
  const r = await execText('git', ['show', `${base}:${rel}`], { cwd: repoRoot })
  return r.ok ? r.stdout : null
}

/** An open instructions PR to update, rather than a second one alongside it. */
async function openShareBranch(repoRoot: string): Promise<{ branch: string; url: string } | null> {
  const r = await execText(
    'gh',
    ['pr', 'list', '--state', 'open', '--json', 'headRefName,url', '--limit', '50'],
    { cwd: repoRoot }
  )
  if (!r.ok) return null
  try {
    const prs = JSON.parse(r.stdout) as Array<{ headRefName?: string; url?: string }>
    const found = prs.find((p) => p.headRefName?.startsWith(`cockpit/${BRANCH_PREFIX}`))
    return found?.headRefName && found.url ? { branch: found.headRefName, url: found.url } : null
  } catch {
    return null
  }
}

/**
 * Write the baseline into a worktree's instruction files. Returns the paths it
 * changed — empty when every file already says this.
 *
 * Symlinks are resolved and checked: this very repo ships `CLAUDE.md` as a link
 * to `AGENTS.md`, so the two targets can be one file (write it once), and a link
 * pointing outside the worktree is refused rather than followed. A `CLAUDE.md`
 * that imports `@AGENTS.md` is one file's worth of reading too, and is left alone.
 */
export function writeShareFiles(cwd: string, baseline: string): string[] {
  // resolve the worktree itself too: on macOS it lives under /var/folders, which is
  // a symlink to /private/var, so comparing a resolved file with an unresolved root
  // would read every file in it as pointing somewhere else
  const base = existsSync(cwd) ? realpathSync(cwd) : cwd
  const reads = instructionTargets(cwd).map((target) => {
    const real = existsSync(target.path) ? realpathSync(target.path) : join(base, relative(cwd, target.path))
    if (real === base || !isUnder(real, base)) {
      throw new Error(`${target.path} points outside the worktree — refusing to write through it`)
    }
    return { target, raw: existsSync(real) ? readFileSync(real, 'utf8') : null, real }
  })
  const changed: string[] = []
  for (const { raw, real } of foldTargets(reads)) {
    const next = upsertSharedBlock(raw ?? '', baseline)
    if (next === raw) continue
    writeFileSync(real, next)
    changed.push(real)
  }
  return changed
}

/** Stage and commit the share; false when the files already agreed with the baseline. */
export async function commitShare(cwd: string, baseline: string): Promise<boolean> {
  const changed = writeShareFiles(cwd, baseline)
  if (changed.length === 0) return false
  // absolute, because these are already resolved through any symlink on the way to
  // the worktree — a path relative to the unresolved cwd would climb out of it
  await git(['add', '--', ...changed], cwd)
  // the user's own git identity and hooks apply — a hook that refuses is the
  // repo saying no, and its message is what the user needs to see
  await git(['commit', '-m', SHARE_COMMIT], cwd)
  return true
}

/**
 * Open (or update) a pull request that puts this repo's shared instructions into
 * the repo itself.
 */
export async function shareInstructions(repoRoot: string): Promise<ShareResult> {
  const baseline = getInstructions(repoRoot).baseline
  if (baseline.trim() === '') throw new Error('shared instructions are empty — nothing to share')
  if (!resolveRepo(repoRoot)?.repo.fullName) {
    throw new Error('this repo has no GitHub `origin` remote to open a pull request against')
  }

  await git(['fetch', 'origin'], repoRoot)
  const existing = await openShareBranch(repoRoot)
  const base = existing ? `origin/${existing.branch}` : await defaultBranch(repoRoot)

  // decide "nothing to share" before creating a branch or a worktree, so an
  // already-shared baseline leaves nothing behind to clean up
  const bases = await Promise.all(
    instructionTargets(repoRoot).map(async (target) => ({
      target,
      raw: await fileAtBase(repoRoot, base, target.path),
      // git shows a symlink as its link text, so only imports fold here; a linked
      // CLAUDE.md reads as unmanaged and the worktree write below sorts it out
      real: target.path
    }))
  )
  if (allCarryBaseline(bases, baseline)) {
    return existing ? { status: 'unchanged', url: existing.url } : { status: 'unchanged' }
  }

  const ws = await createWorkspace(repoRoot, `${BRANCH_PREFIX}-${new Date().toISOString().slice(0, 10)}`, {
    base
  })
  try {
    if (!(await commitShare(ws.cwd, baseline))) {
      return existing ? { status: 'unchanged', url: existing.url } : { status: 'unchanged' }
    }
    if (existing) {
      // push onto the open PR's own branch rather than opening a second one —
      // two PRs editing the same two files is the worst possible outcome here
      await git(['push', 'origin', `HEAD:${existing.branch}`], ws.cwd)
      return { status: 'updated', url: existing.url }
    }
    return { status: 'opened', url: await createPr(ws.cwd) }
  } finally {
    // on every path, including a refused push: the branch is what carries the
    // work, and a leftover worktree would only show up later as cleanup
    await removeWorkspace(repoRoot, ws.cwd)
  }
}
