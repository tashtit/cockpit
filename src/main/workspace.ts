import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { WorkspaceInfo } from '../shared/types'
import { parseWorktreeList, type WorktreeEntry } from './cleanup-core'
import { execText, type ExecResult } from './env'
import { userDataDir } from './config'

const TIMEOUT_MS = 120_000
/** A hook that fails mid-install can print pages; the reason is at the end. */
const HOOK_OUTPUT_LINES = 20

function failureText(cmd: string, r: ExecResult): string {
  return r.stderr.trim() || r.stdout.trim() || r.error || `${cmd} failed`
}

async function run(cmd: string, args: string[], cwd: string): Promise<string> {
  const r = await execText(cmd, args, { cwd, timeoutMs: TIMEOUT_MS })
  if (!r.ok) throw new Error(failureText(cmd, r))
  return r.stdout.trim()
}

/** The commit `ref` names, or null when it names none. */
async function commitOf(repoRoot: string, ref: string): Promise<string | null> {
  const r = await execText('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    cwd: repoRoot
  })
  return (r.ok && r.stdout.trim()) || null
}

/**
 * git lists worktrees by real path, and userData can sit behind a symlink (the
 * macOS tmpdir always does). Resolve the parent rather than the path itself,
 * which may not exist — a registration outlives its directory.
 */
function canonical(path: string): string {
  try {
    return join(realpathSync(dirname(path)), basename(path))
  } catch {
    return resolve(path)
  }
}

/** The worktree git has registered at `path`, whether or not its directory is still there. */
async function registeredAt(repoRoot: string, path: string): Promise<WorktreeEntry | null> {
  const r = await execText('git', ['worktree', 'list', '--porcelain'], { cwd: repoRoot })
  if (!r.ok) return null
  const want = canonical(path)
  return parseWorktreeList(r.stdout).find((e) => canonical(e.path) === want) ?? null
}

type Target = { readonly dest: string; readonly branch: string }

/**
 * Checked before git is asked, not read off its error: `worktree add -b` creates
 * the branch *before* it looks at the path, so an add onto a taken directory
 * fails with a new branch already left behind. The one thing cleared here is a
 * registration whose directory was deleted by hand — git refuses to add at a
 * registered path — and only at `dest`: `git worktree prune` would drop every
 * registration whose directory is missing, a worktree on a drive that is only
 * unmounted among them.
 */
async function nameTaken(repoRoot: string, { dest, branch }: Target): Promise<boolean> {
  if (await commitOf(repoRoot, `refs/heads/${branch}`)) return true
  const held = await registeredAt(repoRoot, dest)
  if (held && held.prunable && !held.locked && !existsSync(dest)) {
    await execText('git', ['worktree', 'remove', dest], { cwd: repoRoot })
    return (await registeredAt(repoRoot, dest)) !== null
  }
  return held !== null || existsSync(dest)
}

/**
 * Undo what a failed add made. The name was free before it ran (`nameTaken`), so
 * a worktree now registered at `dest`, and `branch`, can only be this add's. The
 * branch goes only while it still points at the commit it was cut from — nothing
 * has been committed on it — and git itself refuses to delete one a worktree has
 * checked out.
 */
async function discard(
  repoRoot: string,
  target: Target & { readonly baseCommit: string | null }
): Promise<void> {
  if (await registeredAt(repoRoot, target.dest)) {
    // forced twice: git locks a worktree while it is being made, and one whose
    // add was killed partway (the timeout) stays locked
    await execText('git', ['worktree', 'remove', '--force', '--force', target.dest], {
      cwd: repoRoot
    })
  }
  const head = await commitOf(repoRoot, `refs/heads/${target.branch}`)
  if (target.baseCommit && head === target.baseCommit) {
    await execText('git', ['branch', '-D', target.branch], { cwd: repoRoot })
  }
}

async function addWorktree(
  repoRoot: string,
  target: Target & { readonly base?: string; readonly baseCommit: string | null }
): Promise<WorkspaceInfo> {
  const { dest, branch, base } = target
  // --no-track: branching off origin/<default> would otherwise adopt it as the
  // upstream, and a later `git push` would aim at the wrong ref. --quiet leaves
  // stderr to the post-checkout hook alone.
  const from = base ? ['--no-track', dest, base] : [dest]
  const r = await execText('git', ['worktree', 'add', '--quiet', '-b', branch, ...from], {
    cwd: repoRoot,
    timeoutMs: TIMEOUT_MS
  })
  if (r.ok) return { cwd: dest, branch }
  // git runs post-checkout only once the worktree is complete and unlocked, then
  // exits with the hook's status (husky with no node on the GUI PATH: 127). A
  // finished worktree on the new branch is that case — keep it, and say what the
  // hook printed, since whatever it sets up (installs, generated files) is missing.
  const made = await registeredAt(repoRoot, dest)
  if (made && made.branch === branch && !made.locked && !made.prunable) {
    const said = r.stderr.trim().split('\n').slice(-HOOK_OUTPUT_LINES).join('\n')
    return {
      cwd: dest,
      branch,
      warning: `The repository's post-checkout hook failed, so whatever it sets up is missing from this worktree${said ? `:\n${said}` : '.'}`
    }
  }
  await discard(repoRoot, target)
  throw new Error(failureText('git', r))
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}

type WorkspaceOptions = { readonly base?: string }

// One at a time: what a failed add left behind is told apart from what was
// already there by looking before and after, which holds only while nothing
// else here is creating worktrees in between.
let creating: Promise<unknown> = Promise.resolve()

/**
 * Every new session gets its own linked worktree + branch (cockpit/<slug>), kept
 * outside the repo (under userData) so checkouts stay clean and nothing needs ignoring.
 */
export function createWorkspace(
  repoRoot: string,
  name?: string,
  opts: WorkspaceOptions = {}
): Promise<WorkspaceInfo> {
  const job = creating.then(() => create(repoRoot, name, opts))
  creating = job.catch(() => undefined)
  return job
}

async function create(
  repoRoot: string,
  name: string | undefined,
  opts: WorkspaceOptions
): Promise<WorkspaceInfo> {
  const baseSlug = (name && slugify(name)) || `ws-${Date.now().toString(36)}`
  const parent = join(userDataDir(), 'worktrees', slugify(basename(repoRoot)) || 'repo')
  mkdirSync(parent, { recursive: true })
  const baseCommit = await commitOf(repoRoot, opts.base ?? 'HEAD')
  for (const slug of [baseSlug, `${baseSlug}-${Date.now().toString(36).slice(-4)}`]) {
    const target = { dest: join(parent, slug), branch: `cockpit/${slug}` }
    if (await nameTaken(repoRoot, target)) continue
    return addWorktree(repoRoot, { ...target, base: opts.base, baseCommit })
  }
  throw new Error(`cockpit/${baseSlug} is taken in ${repoRoot}, and so is its fallback name.`)
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
