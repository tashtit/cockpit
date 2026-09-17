import { existsSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type {
  CleanupBlock,
  CleanupReport,
  CleanupResult,
  OrphanProcess,
  SessionMeta,
  StaleSession,
  StaleWorktree
} from '../shared/types'
import {
  clampStaleDays,
  isStale,
  isUnder,
  judgeProcesses,
  lastWorktreeActivity,
  ownProcessTree,
  parseLsofCwds,
  parsePs,
  parseWorktreeList,
  staleCutoff,
  worktreeBlocks,
  worktreeOrigin,
  type JudgedProcess,
  type ProcessFacts,
  type WorktreeEntry,
  type WorktreeHome
} from './cleanup-core'
import { execText } from './env'

/**
 * Cross-agent cleanup: the one place that answers "what has gone stale, across
 * every agent and every repository, and what can safely go?"
 *
 * Two kinds of thing, two very different risk profiles:
 *
 *   sessions   — provider transcripts. Archiving is Cockpit-side and reversible;
 *                deleting removes the provider's own log file, so every path is
 *                re-validated here against the index *and* the configured source
 *                dirs before anything is unlinked.
 *   worktrees  — discovered by asking git itself, per known repo root, so
 *                worktrees Cockpit never created (Claude Code's `.claude/worktrees`,
 *                hand-made ones) are found and cleanable too. Removal goes through
 *                `git worktree remove` without --force: anything git objects to is
 *                reported, never overridden.
 *   processes  — whatever is still running with its cwd inside a stale worktree, or
 *                inside one already removed from under it (the dev server nobody
 *                stopped). Found with `lsof`, stopped with SIGTERM only, and a
 *                worktree with one inside is blocked until it is gone.
 *
 * Nothing here trusts a renderer-supplied path. `removeWorktrees` re-derives the
 * whole listing before acting, and only paths that listing produced are touched.
 */

/**
 * Rows shipped to the renderer per group. The full index is never sent to the UI
 * (an indexer invariant); totals stay exact while the list stays bounded, and the
 * view says so when it is showing a window onto something larger.
 */
export const CLEANUP_ROW_CAP = 500

/** Sizing a worktree walks a whole checkout — give up rather than stall the scan. */
const DU_TIMEOUT_MS = 10_000

/** Hand the event loop back this often while stat-ing session files. */
const YIELD_EVERY = 200

const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r))

/** Everything the scan needs from the rest of main, injected so tests can drive it. */
export type CleanupDeps = {
  /** Sessions Cockpit owns — archived included, roundtable seats already excluded */
  readonly sessions: () => SessionMeta[]
  /** Main repo roots the indexer derived (never renderer input) */
  readonly repoRoots: () => string[]
  /** `<userData>/worktrees` — what makes a worktree Cockpit's own */
  readonly cockpitWorktreeRoot: string
  /** Session ids with a provider turn running right now */
  readonly busyIds: () => Set<string>
  /** cwd → roundtable id when that directory is a table's shared room */
  readonly tableForCwd: (cwd: string) => string | null
  /** Configured source dirs — the only roots a session file may be deleted from */
  readonly sourceDirs: () => string[]
  /**
   * Directories worktrees are cut under beyond Cockpit's own root and each repo's
   * `.claude/worktrees` (Codex's `~/.codex/worktrees`). A deleted directory under
   * one of them was a worktree, which is how a process outliving it is recognised.
   */
  readonly worktreeHomes: () => string[]
  /** Cockpit's own pid — its process tree is never offered for stopping */
  readonly selfPid: number
}

/* ---------- sessions ---------- */

/**
 * What a session actually occupies on disk. Copilot keeps each session as a
 * directory (`session-state/<id>/events.jsonl` plus siblings); Claude and Codex
 * are one file. `copilotSessionDir` is the same judgement used for deletion, so
 * what is measured and what is removed can never drift apart.
 */
function copilotSessionDir(sourcePath: string): string | null {
  const dir = dirname(sourcePath)
  return basename(sourcePath) === 'events.jsonl' && basename(dirname(dir)) === 'session-state'
    ? dir
    : null
}

/** The path(s) deleting this session would remove. */
function deleteTarget(sourcePath: string): string {
  return copilotSessionDir(sourcePath) ?? sourcePath
}

function dirBytes(dir: string): number {
  let total = 0
  let names: string[] = []
  try {
    names = readdirSync(dir)
  } catch {
    return 0
  }
  for (const n of names) {
    try {
      const st = statSync(join(dir, n))
      total += st.isDirectory() ? dirBytes(join(dir, n)) : st.size
    } catch {
      /* a file that vanished mid-scan simply doesn't count */
    }
  }
  return total
}

function sessionBytes(sourcePath: string): number {
  const dir = copilotSessionDir(sourcePath)
  if (dir) return dirBytes(dir)
  try {
    return statSync(sourcePath).size
  } catch {
    return 0
  }
}

/* ---------- processes ---------- */

/** lsof walks every process the user owns — well under a second, but never unbounded. */
const PROCESS_SCAN_TIMEOUT_MS = 10_000

/** How long a stopped process gets to exit before it is reported as still running. */
const STOP_GRACE_MS = 2_000

/**
 * Every process the user owns that has a working directory, minus Cockpit's own
 * tree. Fails soft to an empty list: without lsof or ps there is simply nothing
 * to report, and the worktree scan must not fail over it.
 */
async function processSnapshot(deps: CleanupDeps): Promise<ProcessFacts[]> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  const [lsof, ps] = await Promise.all([
    execText('lsof', ['-a', '-d', 'cwd', ...(uid === null ? [] : ['-u', String(uid)]), '-F', 'pn'], {
      timeoutMs: PROCESS_SCAN_TIMEOUT_MS
    }),
    execText('ps', ['-Ao', 'pid=,ppid=,etime=,command='], { timeoutMs: PROCESS_SCAN_TIMEOUT_MS })
  ])
  // lsof exits 1 when some process could not be read, with the readable ones on
  // stdout — the output is what counts, not the status
  if (!lsof.stdout || !ps.ok) return []
  const cwds = parseLsofCwds(lsof.stdout)
  const rows = parsePs(ps.stdout, Date.now())
  const own = ownProcessTree(rows, deps.selfPid)
  const out: ProcessFacts[] = []
  for (const r of rows) {
    const cwd = cwds.get(r.pid)
    if (!cwd || own.has(r.pid) || cwd === '/') continue
    out.push({ ...r, cwd })
  }
  return out
}

/* ---------- worktrees ---------- */

async function git(repoRoot: string, args: readonly string[]): Promise<string | null> {
  const r = await execText('git', ['-C', repoRoot, ...args], { timeoutMs: 20_000 })
  return r.ok ? r.stdout : null
}

/** `du -sk` in bytes; null when it fails or takes too long to be worth waiting for. */
async function measureDir(path: string): Promise<number | null> {
  const r = await execText('du', ['-sk', path], { timeoutMs: DU_TIMEOUT_MS })
  if (!r.ok) return null
  const kb = Number(r.stdout.trim().split(/\s+/)[0])
  return Number.isFinite(kb) ? kb * 1024 : null
}

/**
 * git reports worktrees by their real path, while a session's recorded cwd and the
 * app's own userData path may still run through a symlink (`/var` → `/private/var`
 * on macOS is the common one). Compare both sides resolved, or a worktree and the
 * sessions inside it never match.
 */
function realish(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** Newest `updatedAt` among sessions running in (or under) a directory, plus how many. */
function sessionActivityIn(
  sessions: readonly SessionMeta[],
  path: string
): { readonly newest: number; readonly count: number } {
  let newest = 0
  let count = 0
  for (const s of sessions) {
    if (!s.cwd || !isUnder(realish(s.cwd), path)) continue
    count++
    if (s.updatedAt > newest) newest = s.updatedAt
  }
  return { newest, count }
}

function dirMtime(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/** One worktree, fully judged — shared by the scan and by removal's re-derivation. */
type JudgedWorktree = StaleWorktree & { readonly repoRootForGit: string }

async function judgeWorktrees(
  deps: CleanupDeps,
  procs: readonly ProcessFacts[]
): Promise<JudgedWorktree[]> {
  const sessions = deps.sessions()
  const busy = deps.busyIds()
  const busyCwds = new Set(
    sessions.filter((s) => busy.has(s.id) && s.cwd).map((s) => realish(s.cwd as string))
  )
  const cockpitRoot = realish(deps.cockpitWorktreeRoot)
  const out: JudgedWorktree[] = []
  const listed: { root: string; entry: WorktreeEntry; path: string; isMain: boolean }[] = []
  const seen = new Set<string>()
  for (const root of deps.repoRoots()) {
    const listing = await git(root, ['worktree', 'list', '--porcelain'])
    if (listing === null) continue
    for (const [i, entry] of parseWorktreeList(listing).entries()) {
      const path = realish(entry.path)
      if (seen.has(path)) continue
      seen.add(path)
      // the first record is the repository's own checkout; bare repos have no
      // working tree to clean at all
      if (!entry.bare) listed.push({ root, entry, path, isMain: i === 0 })
    }
  }
  // a process belongs to the deepest worktree around it, so one running in a
  // `.claude/worktrees/*` checkout never counts against the repository holding it
  const processIn = new Set<string>()
  for (const p of procs) {
    let best: string | null = null
    for (const l of listed) {
      if (isUnder(p.cwd, l.path) && (!best || l.path.length > best.length)) best = l.path
    }
    if (best) processIn.add(best)
  }
  for (const { root, entry, path, isMain } of listed) {
    const missing = entry.prunable || !existsSync(path)
    const activity = sessionActivityIn(sessions, path)
    const tip = missing ? null : await git(path, ['log', '-1', '--format=%ct', 'HEAD'])
    const tipMs = tip === null ? 0 : Number(tip.trim()) * 1000
    const dirty = missing
      ? false
      : ((await git(path, ['status', '--porcelain'])) ?? '').trim().length > 0
    const unpushedOut = missing
      ? null
      : await git(path, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])
    // a registration whose directory is gone has nothing left to protect —
    // the disk-derived facts are all false, so only `main` can still block it
    const blocks = worktreeBlocks({
      isMain,
      locked: entry.locked && !missing,
      dirty,
      busy: !missing && [...busyCwds].some((c) => isUnder(c, path)),
      roundtable: deps.tableForCwd(path) !== null,
      // nothing is left to protect in a directory that is already gone
      processes: !missing && processIn.has(path)
    })
    out.push({
      path,
      repoRoot: root,
      repoRootForGit: root,
      repoName: basename(root),
      branch: entry.branch,
      origin: worktreeOrigin(path, cockpitRoot),
      lastActivity: lastWorktreeActivity([
        Number.isFinite(tipMs) ? tipMs : 0,
        activity.newest,
        missing ? 0 : dirMtime(path)
      ]),
      sessionCount: activity.count,
      missing,
      unpushed: unpushedOut === null ? 0 : Number(unpushedOut.trim()) || 0,
      bytes: null,
      blocks
    })
  }
  return out
}

/** Where worktrees get cut: Cockpit's root, each repo's `.claude/worktrees`, the extras. */
function worktreeHomes(deps: CleanupDeps): WorktreeHome[] {
  const homes: WorktreeHome[] = [{ path: realish(deps.cockpitWorktreeRoot), repoName: null }]
  for (const root of deps.repoRoots()) {
    homes.push({ path: realish(join(root, '.claude', 'worktrees')), repoName: basename(root) })
  }
  for (const extra of deps.worktreeHomes()) homes.push({ path: realish(extra), repoName: null })
  return homes
}

/** The processes left behind in old worktrees, judged against a fresh listing. */
function orphanProcesses(
  deps: CleanupDeps,
  input: {
    readonly trees: readonly JudgedWorktree[]
    readonly procs: readonly ProcessFacts[]
    readonly cutoff: number
  }
): JudgedProcess[] {
  return judgeProcesses({
    processes: input.procs,
    worktrees: input.trees.map((w) => ({
      path: w.path,
      repoName: w.repoName,
      branch: w.branch,
      isMain: w.blocks.includes('main'),
      stale: isStale(w.lastActivity, input.cutoff),
      missing: w.missing
    })),
    homes: worktreeHomes(deps),
    exists: existsSync
  })
}

/* ---------- the scan ---------- */

/**
 * The removable worktree a session ran in. A session and its worktree are one
 * piece of work, so the worktree rides on the session rather than being listed
 * twice — and only ever when it is itself stale and unblocked, so deleting can
 * never take a checkout the scan didn't show as disposable.
 */
function worktreeForCwd(
  trees: readonly JudgedWorktree[],
  cwd: string | null,
  cutoff: number
): JudgedWorktree | null {
  if (!cwd) return null
  const here = realish(cwd)
  for (const w of trees) {
    if (w.blocks.length > 0 || w.missing) continue
    if (!isStale(w.lastActivity, cutoff)) continue
    if (isUnder(here, w.path)) return w
  }
  return null
}

export async function scanCleanup(deps: CleanupDeps, staleDays: number): Promise<CleanupReport> {
  const days = clampStaleDays(staleDays)
  const scannedAt = Date.now()
  const cutoff = staleCutoff(days, scannedAt)
  const all = deps.sessions()
  const busy = deps.busyIds()

  const procs = await processSnapshot(deps)
  const judged = await judgeWorktrees(deps, procs)
  const linked = judged.filter((w) => !w.blocks.includes('main'))
  const staleTrees = linked
    .filter((w) => isStale(w.lastActivity, cutoff))
    .sort((a, b) => a.lastActivity - b.lastActivity)
  // only stale worktrees are sized: walking every checkout in every repo would
  // cost far more than the answer is worth
  const sizes = new Map<string, number | null>(
    await Promise.all(
      staleTrees.map(
        async (w) => [w.path, w.missing ? 0 : await measureDir(w.path)] as [string, number | null]
      )
    )
  )

  const staleMetas = all
    .filter((s) => isStale(s.updatedAt, cutoff))
    .sort((a, b) => a.updatedAt - b.updatedAt)
  const sessions: StaleSession[] = []
  let n = 0
  for (const s of staleMetas) {
    if (++n % YIELD_EVERY === 0) await yieldToLoop()
    const w = worktreeForCwd(staleTrees, s.cwd, cutoff)
    sessions.push({
      id: s.id,
      provider: s.provider,
      title: s.title,
      repoName: s.repo?.name ?? null,
      cwd: s.cwd,
      updatedAt: s.updatedAt,
      bytes: sessionBytes(s.sourcePath),
      archived: s.archived === true,
      worktree: w
        ? {
            path: w.path,
            branch: w.branch,
            bytes: sizes.get(w.path) ?? null,
            sessionCount: w.sessionCount
          }
        : null,
      blocks: busy.has(s.id) ? ['busy'] : []
    })
  }

  const rows = sessions.slice(0, CLEANUP_ROW_CAP)
  // a worktree a listed session will take with it is not also listed on its own —
  // every worktree appears exactly once across the report
  const claimed = new Set(rows.map((r) => r.worktree?.path).filter((p): p is string => !!p))
  const orphans: StaleWorktree[] = staleTrees
    .filter((w) => !claimed.has(w.path))
    .slice(0, CLEANUP_ROW_CAP)
    .map(({ repoRootForGit: _drop, ...w }) => ({ ...w, bytes: sizes.get(w.path) ?? null }))

  const processes: OrphanProcess[] = orphanProcesses(deps, { trees: judged, procs, cutoff })
    .slice(0, CLEANUP_ROW_CAP)
    .map(({ ppid: _ppid, ...p }) => p)

  return {
    staleDays: days,
    scannedAt,
    sessions: rows,
    staleSessionCount: sessions.length,
    staleSessionBytes: sessions.reduce((n, s) => n + s.bytes, 0),
    worktrees: orphans,
    staleWorktreeCount: staleTrees.length,
    processes,
    totalSessions: all.length,
    totalWorktrees: linked.length
  }
}

/* ---------- cleaning ---------- */

/**
 * The audit trail for everything this module removes: one line per deletion or
 * refusal on the main-process console, so "what did cleanup take?" has an answer.
 */
function audit(line: string): void {
  console.info(`[cleanup] ${line}`)
}

/**
 * Delete the provider's own log files for these sessions, and the worktrees they
 * ran in. A session and its checkout are one piece of work — cleaning the log but
 * leaving a 400MB abandoned worktree behind is not a cleanup.
 *
 * Two independent gates before a log file is unlinked: the id must be one the
 * indexer knows, and the file it names must sit inside a configured source
 * directory. A renderer that asks for anything else gets a refusal in `failed`,
 * not an unlink.
 *
 * The worktree cascade is deliberately conservative. A worktree goes only when
 * *every* session indexed inside it is in this deletion — worktrees routinely host
 * several, and one survivor is reason enough to keep the checkout — and only when
 * it is stale and unblocked, which is exactly the set the scan showed attached to
 * these rows. The listing is re-derived here rather than trusted from the scan.
 */
export async function deleteSessions(
  deps: CleanupDeps,
  ids: readonly string[],
  staleDays: number
): Promise<CleanupResult> {
  const all = deps.sessions()
  const byId = new Map(all.map((s) => [s.id, s]))
  const roots = deps.sourceDirs().map((d) => resolve(d))
  const busy = deps.busyIds()
  const failed: { target: string; reason: string }[] = []
  const branchesDeleted: string[] = []
  const deleted = new Set<string>()
  let cleaned = 0
  let freedBytes = 0

  for (const raw of ids) {
    const id = String(raw)
    const meta = byId.get(id)
    if (!meta) {
      failed.push({ target: id, reason: 'no longer indexed' })
      continue
    }
    if (busy.has(id)) {
      failed.push({ target: meta.title || id, reason: 'an agent is running in it' })
      continue
    }
    const target = resolve(deleteTarget(meta.sourcePath))
    if (!roots.some((r) => isUnder(target, r))) {
      audit(`refused session ${id}: ${target} is outside every configured source`)
      failed.push({ target: meta.title || id, reason: 'outside every configured source' })
      continue
    }
    const bytes = sessionBytes(meta.sourcePath)
    try {
      rmSync(target, { recursive: true, force: false })
      cleaned++
      deleted.add(id)
      freedBytes += bytes
      audit(`removed session ${id}: ${target} (${bytes} bytes)`)
    } catch (err) {
      failed.push({
        target: meta.title || id,
        reason: err instanceof Error ? err.message : String(err)
      })
    }
  }

  if (deleted.size > 0) {
    const cutoff = staleCutoff(staleDays, Date.now())
    for (const w of await judgeWorktrees(deps, await processSnapshot(deps))) {
      if (w.blocks.length > 0 || w.missing) continue
      if (!isStale(w.lastActivity, cutoff)) continue
      const inside = all.filter((s) => s.cwd && isUnder(realish(s.cwd), w.path))
      // no session of its own is not this action's business — that is an orphan,
      // and orphans are cleaned from the worktrees list, deliberately by hand
      if (inside.length === 0) continue
      if (!inside.every((s) => deleted.has(s.id))) continue
      const bytes = (await measureDir(w.path)) ?? 0
      const removed = await execText(
        'git',
        ['-C', w.repoRootForGit, 'worktree', 'remove', w.path],
        { timeoutMs: 60_000 }
      )
      if (!removed.ok) {
        failed.push({
          target: w.path,
          reason: removed.stderr.trim() || 'git refused to remove the worktree'
        })
        continue
      }
      freedBytes += bytes
      audit(`removed worktree ${w.path} (${bytes} bytes)`)
      if (w.branch) {
        const gone = await execText('git', ['-C', w.repoRootForGit, 'branch', '-d', w.branch])
        if (gone.ok) {
          branchesDeleted.push(w.branch)
          audit(`deleted branch ${w.branch} in ${w.repoRootForGit}`)
        }
      }
    }
  }

  return { cleaned, freedBytes, failed, branchesDeleted }
}

/**
 * `git worktree remove` each path, then drop the branch when git says it is fully
 * merged. Deliberately never passes --force: the listing is re-derived here, and a
 * worktree that has picked up a block since the scan is refused rather than forced.
 */
export async function removeWorktrees(
  deps: CleanupDeps,
  paths: readonly string[]
): Promise<CleanupResult> {
  const judged = new Map(
    (await judgeWorktrees(deps, await processSnapshot(deps))).map((w) => [w.path, w])
  )
  const failed: { target: string; reason: string }[] = []
  const branchesDeleted: string[] = []
  const pruned = new Set<string>()
  let cleaned = 0
  let freedBytes = 0
  for (const raw of paths) {
    const path = realish(String(raw))
    const w = judged.get(path)
    if (!w) {
      failed.push({ target: path, reason: 'not a worktree of any known repository' })
      continue
    }
    if (w.blocks.length > 0) {
      failed.push({ target: path, reason: blockReason(w.blocks) })
      continue
    }
    if (w.missing) {
      // nothing on disk: the registration is the only thing left to clear
      if (!pruned.has(w.repoRootForGit)) {
        await git(w.repoRootForGit, ['worktree', 'prune'])
        pruned.add(w.repoRootForGit)
      }
      audit(`pruned missing worktree ${path} from ${w.repoRootForGit}`)
      cleaned++
      continue
    }
    const bytes = (await measureDir(path)) ?? 0
    const removed = await execText('git', ['-C', w.repoRootForGit, 'worktree', 'remove', path], {
      timeoutMs: 60_000
    })
    if (!removed.ok) {
      failed.push({ target: path, reason: removed.stderr.trim() || 'git refused to remove it' })
      continue
    }
    cleaned++
    freedBytes += bytes
    audit(`removed worktree ${path} (${bytes} bytes)`)
    // -d, never -D: git's own merged check is the safety net for the commits that
    // worktree removal deliberately left behind
    if (w.branch) {
      const gone = await execText('git', ['-C', w.repoRootForGit, 'branch', '-d', w.branch])
      if (gone.ok) {
        branchesDeleted.push(w.branch)
        audit(`deleted branch ${w.branch} in ${w.repoRootForGit}`)
      }
    }
  }
  return { cleaned, freedBytes, failed, branchesDeleted }
}

/** The first block is the one worth showing — they are ordered by weight. */
function blockReason(blocks: readonly CleanupBlock[]): string {
  const REASONS: Record<CleanupBlock, string> = {
    main: 'this is the repository’s own checkout',
    roundtable: 'it is a roundtable’s shared room',
    busy: 'an agent is running in it',
    process: 'a process is still running in it — stop it first',
    dirty: 'it has uncommitted changes',
    locked: 'the worktree is locked'
  }
  return REASONS[blocks[0]] ?? 'it cannot be removed'
}

/**
 * SIGTERM each process, then give them a moment to exit. The pids are renderer
 * input, so the whole judgement is re-derived first and only a pid that is still
 * a process left in an old worktree — same cwd judgement, and not Cockpit's own
 * tree — is signalled; a pid reused since the scan by something else is refused.
 * Never SIGKILL: a process that ignores the polite signal is reported, not forced.
 */
export async function stopProcesses(
  deps: CleanupDeps,
  pids: readonly number[],
  staleDays: number
): Promise<CleanupResult> {
  const procs = await processSnapshot(deps)
  const trees = await judgeWorktrees(deps, procs)
  const orphans = new Map(
    orphanProcesses(deps, { trees, procs, cutoff: staleCutoff(staleDays, Date.now()) }).map((p) => [
      p.pid,
      p
    ])
  )
  const failed: { target: string; reason: string }[] = []
  const signalled: JudgedProcess[] = []
  for (const raw of new Set(pids.map((p) => Math.floor(Number(p))))) {
    const p = orphans.get(raw)
    if (!p) {
      failed.push({ target: `pid ${raw}`, reason: 'no longer a process left in an old worktree' })
      continue
    }
    try {
      process.kill(p.pid, 'SIGTERM')
      signalled.push(p)
      audit(`sent SIGTERM to ${p.pid} (${p.command}) in ${p.cwd}`)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ESRCH') signalled.push(p)
      else failed.push({ target: label(p), reason: code === 'EPERM' ? 'not permitted' : String(err) })
    }
  }
  const deadline = Date.now() + STOP_GRACE_MS
  let alive = signalled
  while (alive.length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100))
    alive = alive.filter((p) => isAlive(p.pid))
  }
  for (const p of alive) {
    failed.push({ target: label(p), reason: 'still running — it did not exit on SIGTERM' })
  }
  return { cleaned: signalled.length - alive.length, freedBytes: 0, failed }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function label(p: JudgedProcess): string {
  return `${basename(p.command.split(' ')[0] ?? '') || 'process'} (pid ${p.pid})`
}
