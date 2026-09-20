import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { DiffFile, DiffScope, WorkspaceDiff } from '../shared/types'
import {
  DEFAULT_CAPS,
  parseAheadBehind,
  parseNumstat,
  parseStatus,
  parseUnifiedDiff,
  pickBase,
  untrackedFile,
  withNumstat
} from './diff-core'
import { execText } from './env'
import { isUnder } from './paths'

/**
 * IO around diff-core: the git calls that describe a worktree's changes and the
 * bounded reads that turn untracked files into additions. Read-only throughout —
 * nothing here touches the index, the working tree or the remote.
 */

/** A vendored tree can be enormous; the patch is read up to this, then refused. */
const PATCH_MAX_BYTES = 24 * 1024 * 1024
const UNTRACKED_MAX_FILES = 100
const UNTRACKED_MAX_BYTES = 256 * 1024

const BASE_CANDIDATES = [
  'refs/remotes/origin/main',
  'refs/remotes/origin/master',
  'refs/heads/main',
  'refs/heads/master'
]

const DIFF_ARGS = ['--no-color', '--no-ext-diff', '-M']

/** The scope is renderer input: only the three known values select git arguments. */
export function asDiffScope(scope: unknown): DiffScope {
  if (scope === 'branch' || scope === 'staged' || scope === 'unstaged') return scope
  throw new Error('unknown diff scope')
}

async function git(cwd: string, args: readonly string[], maxBuffer?: number): Promise<string | null> {
  const r = await execText('git', args, { cwd, timeoutMs: 20_000, ...(maxBuffer ? { maxBuffer } : {}) })
  return r.ok ? r.stdout : null
}

async function findBase(cwd: string): Promise<string | null> {
  const originHead = (await git(cwd, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']))?.trim()
  const listed = await git(cwd, ['for-each-ref', '--format=%(refname:short)', ...BASE_CANDIDATES])
  const existing = (listed ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
  return pickBase(originHead || null, existing)
}

/** Bounded read: the first `UNTRACKED_MAX_BYTES` of a file and whether that was all of it. */
function readHead(path: string): { bytes: Uint8Array; truncated: boolean } | null {
  try {
    const size = statSync(path).size
    const fd = openSync(path, 'r')
    try {
      const buf = Buffer.alloc(Math.min(size, UNTRACKED_MAX_BYTES))
      const n = readSync(fd, buf, 0, buf.length, 0)
      return { bytes: buf.subarray(0, n), truncated: size > buf.length }
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
}

function untrackedFiles(cwd: string, paths: readonly string[]): DiffFile[] {
  const out: DiffFile[] = []
  for (const rel of paths.slice(0, UNTRACKED_MAX_FILES)) {
    // git reports paths relative to the worktree and never escapes it; the check
    // is belt-and-braces against a status line the parser misread
    const abs = resolve(join(cwd, rel))
    if (abs === cwd || !isUnder(abs, cwd)) continue
    const head = readHead(abs)
    if (!head) continue
    out.push(untrackedFile(rel, head.bytes, { truncated: head.truncated }))
  }
  return out
}

/**
 * The worktree's changes under one scope. Throws only when git itself cannot
 * answer (not a repository, patch too large) — those are the errors the
 * reviewer needs to read; an unknown base just makes the branch scope fall
 * back to HEAD, reported through `base: null`.
 */
export async function getWorkspaceDiff(cwd: string, scope: DiffScope): Promise<WorkspaceDiff> {
  const c = resolve(cwd)
  if ((await git(c, ['rev-parse', '--is-inside-work-tree']))?.trim() !== 'true') {
    throw new Error('Not a git repository — nothing to review here.')
  }
  const branchOut = (await git(c, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim()
  const branch = branchOut && branchOut !== 'HEAD' ? branchOut : null

  let base: string | null = null
  let ahead = 0
  let behind = 0
  let mergeBase: string | null = null
  if (scope === 'branch') {
    base = await findBase(c)
    if (base) {
      mergeBase = (await git(c, ['merge-base', base, 'HEAD']))?.trim() || null
      if (!mergeBase) base = null
      else {
        const counts = await git(c, ['rev-list', '--left-right', '--count', `${base}...HEAD`])
        ;({ ahead, behind } = parseAheadBehind(counts ?? ''))
      }
    }
  }

  const status = parseStatus((await git(c, ['status', '--porcelain', '-z', '--untracked-files=all'])) ?? '')

  // branch: working tree against where the branch left the base (falls back to
  // HEAD when there is no base); staged / unstaged: the index's two sides
  const target =
    scope === 'staged' ? ['--cached'] : scope === 'unstaged' ? [] : [mergeBase ?? 'HEAD']
  const patch = await execText('git', ['diff', ...DIFF_ARGS, ...target, '--'], {
    cwd: c,
    timeoutMs: 30_000,
    maxBuffer: PATCH_MAX_BYTES
  })
  if (!patch.ok) {
    const reason = patch.stderr.trim() || patch.error || 'git diff failed'
    throw new Error(/maxBuffer/i.test(reason) ? 'The diff is too large to show here.' : reason)
  }
  const numstat = await git(c, ['diff', '--numstat', '-z', ...DIFF_ARGS, ...target, '--'], PATCH_MAX_BYTES)

  const parsed = parseUnifiedDiff(patch.stdout, DEFAULT_CAPS)
  let files = withNumstat(parsed.files, parseNumstat(numstat ?? ''))
  let droppedFiles = parsed.droppedFiles
  if (scope !== 'staged') {
    const extra = untrackedFiles(c, status.untracked)
    const room = Math.max(0, DEFAULT_CAPS.maxFiles - files.length)
    files = [...files, ...extra.slice(0, room)]
    droppedFiles += extra.length - Math.min(extra.length, room) + Math.max(0, status.untracked.length - UNTRACKED_MAX_FILES)
  }

  let added = 0
  let removed = 0
  for (const f of files) {
    added += f.added
    removed += f.removed
  }
  return { cwd: c, scope, branch, base, ahead, behind, dirty: status.dirty, files, added, removed, droppedFiles }
}
