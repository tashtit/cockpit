import { mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { WorkspaceInfo } from '../shared/types'
import { execText } from './env'
import { userDataDir } from './config'

async function run(cmd: string, args: string[], cwd: string): Promise<string> {
  const r = await execText(cmd, args, { cwd, timeoutMs: 120_000 })
  if (!r.ok) throw new Error(r.stderr.trim() || r.stdout.trim() || r.error || `${cmd} failed`)
  return r.stdout.trim()
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

/**
 * Every new session gets its own linked worktree + branch (cockpit/<slug>), kept
 * outside the repo (under userData) so checkouts stay clean and nothing needs ignoring.
 */
export async function createWorkspace(
  repoRoot: string,
  name?: string,
  opts: { readonly base?: string } = {}
): Promise<WorkspaceInfo> {
  const baseSlug = (name && slugify(name)) || `ws-${Date.now().toString(36)}`
  const parent = join(userDataDir(), 'worktrees', slugify(basename(repoRoot)) || 'repo')
  mkdirSync(parent, { recursive: true })
  // clear stale registrations from manually deleted worktree dirs
  await run('git', ['worktree', 'prune'], repoRoot).catch(() => '')
  let lastErr: Error | null = null
  for (const slug of [baseSlug, `${baseSlug}-${Date.now().toString(36).slice(-4)}`]) {
    const branch = `cockpit/${slug}`
    const dest = join(parent, slug)
    try {
      // --no-track: branching off origin/<default> would otherwise adopt it as the
      // upstream, and a later `git push` would aim at the wrong ref
      const from = opts.base ? ['--no-track', dest, opts.base] : [dest]
      await run('git', ['worktree', 'add', '-b', branch, ...from], repoRoot)
      return { cwd: dest, branch }
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      if (!/already exists/i.test(lastErr.message)) break
    }
  }
  throw lastErr ?? new Error('worktree creation failed')
}

/**
 * Drop a worktree Cockpit made for one short-lived job. Best-effort and forced:
 * this is a directory created seconds ago holding only what Cockpit wrote, and
 * the alternative to forcing is litter under userData that the cleanup view then
 * has to explain. (Cleanup's own removals stay unforced — those are the user's.)
 */
export async function removeWorkspace(repoRoot: string, cwd: string): Promise<void> {
  await run('git', ['worktree', 'remove', '--force', cwd], repoRoot).catch(() => '')
}

/** Push the workspace branch and open a PR; returns the PR URL. */
export async function createPr(cwd: string): Promise<string> {
  const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
  if (branch === 'HEAD') throw new Error('Detached HEAD — cannot create a PR from here.')
  const dirty = await run('git', ['status', '--porcelain'], cwd)
  if (dirty) throw new Error('Uncommitted changes in the worktree — ask the agent to commit first.')
  await run('git', ['push', '-u', 'origin', branch], cwd)
  const out = await run('gh', ['pr', 'create', '--fill', '--head', branch], cwd)
  const url = out.match(/https:\/\/\S+/)?.[0]
  if (!url) throw new Error(`PR created but no URL in output:\n${out}`)
  return url
}
