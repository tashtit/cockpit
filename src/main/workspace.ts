import { app } from 'electron'
import { execFile } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { WorkspaceInfo } from '../shared/types'
import { cliEnv } from './env'

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((res, rej) => {
    execFile(cmd, args, { cwd, env: cliEnv(), timeout: 120_000 }, (err, stdout, stderr) => {
      if (err) rej(new Error(stderr.trim() || stdout.trim() || String(err)))
      else res(stdout.trim())
    })
  })
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
export async function createWorkspace(repoRoot: string, name?: string): Promise<WorkspaceInfo> {
  const baseSlug = (name && slugify(name)) || `ws-${Date.now().toString(36)}`
  const parent = join(app.getPath('userData'), 'worktrees', slugify(basename(repoRoot)) || 'repo')
  mkdirSync(parent, { recursive: true })
  // clear stale registrations from manually deleted worktree dirs
  await run('git', ['worktree', 'prune'], repoRoot).catch(() => '')
  let lastErr: Error | null = null
  for (const slug of [baseSlug, `${baseSlug}-${Date.now().toString(36).slice(-4)}`]) {
    const branch = `cockpit/${slug}`
    const dest = join(parent, slug)
    try {
      await run('git', ['worktree', 'add', '-b', branch, dest], repoRoot)
      return { cwd: dest, branch }
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err))
      if (!/already exists/i.test(lastErr.message)) break
    }
  }
  throw lastErr ?? new Error('worktree creation failed')
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
