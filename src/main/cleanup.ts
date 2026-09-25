import { existsSync, lstatSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type {
  CleanupBlock,
  CleanupReport,
  CleanupResult,
  OrphanProcess,
  ProcessTarget,
  Provider,
  SessionMeta,
  StaleSession,
  StaleTable,
  StaleWorktree
} from '../shared/types'
import {
  clampStaleDays,
  isDirty,
  isStale,
  judgeProcesses,
  lastWorktreeActivity,
  mapLimit,
  ownProcessTree,
  parseLsofCwds,
  parsePs,
  parseWorktreeList,
  resolvedOnce,
  sameProcess,
  sessionsByCwd,
  sessionsUnder,
  staleCutoff,
  sumBytes,
  worktreeBlocks,
  worktreeOrigin,
  worktreesWithProcesses,
  type CwdSessions,
  type JudgedProcess,
  type ProcessFacts,
  type WorktreeEntry,
  type WorktreeHome
} from './cleanup-core'
import { processKey, type CleanupReady } from './cleanup-reminder-core'
import { execText } from './env'
import { sessionLogFiles } from './parsers/util'
import { isUnder } from './paths'

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

/** At most this many `du` at once: each one walks a whole checkout, node_modules and all. */
const DU_PARALLEL = 4

/**
 * What sizing every stale worktree may take in all. The pool turns a disk thrashing
 * under every walk at once into a queue, and a queue of big checkouts must not hold
 * the scan: what is still waiting when this runs out reads as unmeasured.
 */
const DU_BUDGET_MS = 30_000

/** Hand the event loop back this often while stat-ing or removing session files. */
const YIELD_EVERY = 200

const yieldToLoop = (): Promise<void> => new Promise((r) => setImmediate(r))

/** Everything the scan needs from the rest of main, injected so tests can drive it. */
/** A roundtable as cleanup needs it: where it runs, and whether it is mid-round. */
export type CleanupTable = {
  readonly id: string
  readonly title: string
  readonly updatedAt: number
  readonly providers: readonly Provider[]
  readonly entryCount: number
  readonly archived: boolean
  readonly running: boolean
  /** The table's shared room, or the worktree it was given */
  readonly cwd: string
  readonly repoRoot: string | null
  readonly repoName: string | null
  readonly branch: string | null
}

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
   * `.claude/worktrees` (Codex's and Copilot's, off their config homes). A
   * worktree-level directory under one of them with no `.git` was a worktree,
   * which is how a process outliving it is recognised.
   */
  readonly worktreeHomes: () => readonly WorktreeHome[]
  /** Cockpit's own pid — its process tree is never offered for stopping */
  readonly selfPid: number
  /** Every roundtable Cockpit keeps, with where it runs and whether a round is live */
  readonly tables: () => readonly CleanupTable[]
  /** Seat sessions, stamped with their table — `sessions()` leaves these out */
  readonly seatSessions: () => SessionMeta[]
  /** `<userData>/roundtables` — the only root a table's own room may be removed from */
  readonly roundtableRoot: string
  /** Drop a table's record once its room and seats are gone (the manager owns the file) */
  readonly forgetTable: (id: string) => void
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

/** The paths deleting this session would remove — every page of a thread kept across several files. */
function deleteTargets(meta: Pick<SessionMeta, 'sourcePath' | 'segments'>): string[] {
  return sessionLogFiles(meta).map((f) => resolve(copilotSessionDir(f) ?? f))
}

/**
 * A Copilot session directory is a handful of files a level or two deep. These bound
 * the walk for one that is not — sizing runs synchronously for every stale session.
 */
const DIR_MAX_DEPTH = 8
const DIR_MAX_ENTRIES = 10_000

/**
 * What removing `dir` would free. Links are counted as themselves and never followed:
 * `rmSync` removes the link, not what it points at, and a link back up the tree would
 * otherwise be walked until the path grew too long. Past the bounds the walk stops,
 * and the answer is what it counted by then.
 */
function dirBytes(dir: string): number {
  let total = 0
  let entries = 0
  const walk = (at: string, depth: number): void => {
    let names: string[]
    try {
      names = readdirSync(at)
    } catch {
      return
    }
    for (const n of names) {
      if (++entries > DIR_MAX_ENTRIES) return
      try {
        const st = lstatSync(join(at, n))
        if (!st.isDirectory()) total += st.size
        else if (depth < DIR_MAX_DEPTH) walk(join(at, n), depth + 1)
      } catch {
        /* a file that vanished mid-scan simply doesn't count */
      }
    }
  }
  walk(dir, 0)
  return total
}

function sessionBytes(meta: Pick<SessionMeta, 'sourcePath' | 'segments'>): number {
  return sessionLogFiles(meta).reduce((n, f) => n + logBytes(f), 0)
}

function logBytes(sourcePath: string): number {
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

type ProcessSnapshot = {
  readonly procs: ProcessFacts[]
  /**
   * False when lsof or ps did not give a full answer — lsof missing, or cut short by
   * its timeout or its buffer, which leaves the processes it never reached out of the
   * list. The scan can show a partial answer; nothing may be removed on one, or a
   * worktree with a dev server still in it reads as empty.
   */
  readonly complete: boolean
}

/** Why a removal was held back when the process check came back partial. */
const UNCHECKED = 'couldn’t check for processes running in it — try again'

/**
 * Every process the user owns that has a working directory, minus Cockpit's own
 * tree. Fails soft to an empty list: without lsof or ps there is simply nothing
 * to report, and the worktree scan must not fail over it — but it says so
 * (`complete`), because removing on an empty list is not failing soft.
 */
async function processSnapshot(deps: CleanupDeps): Promise<ProcessSnapshot> {
  const uid = typeof process.getuid === 'function' ? process.getuid() : null
  const [lsof, ps] = await Promise.all([
    execText('lsof', ['-a', '-d', 'cwd', ...(uid === null ? [] : ['-u', String(uid)]), '-F', 'pn'], {
      timeoutMs: PROCESS_SCAN_TIMEOUT_MS,
      // an app launched from Finder has no LANG, and lsof then escapes non-ASCII
      // bytes in paths (`caf\xc3\xa9`) — a live process would read as removed
      env: { LC_ALL: 'C.UTF-8' }
    }),
    execText('ps', ['-Ao', 'pid=,ppid=,etime=,command='], { timeoutMs: PROCESS_SCAN_TIMEOUT_MS })
  ])
  // lsof exits 1 when some process could not be read, with the readable ones on
  // stdout — the output is what counts, not the status. Unless it was cut short.
  const complete = ps.ok && !lsof.cutShort && lsof.stdout !== ''
  if (!lsof.stdout || !ps.ok) return { procs: [], complete }
  const cwds = parseLsofCwds(lsof.stdout)
  const rows = parsePs(ps.stdout, Date.now())
  const own = ownProcessTree(rows, deps.selfPid)
  const out: ProcessFacts[] = []
  for (const r of rows) {
    const cwd = cwds.get(r.pid)
    if (!cwd || own.has(r.pid) || cwd === '/') continue
    out.push({ ...r, cwd })
  }
  return { procs: out, complete }
}

/* ---------- worktrees ---------- */

/**
 * At most this many git processes at once. A survey runs a few per worktree; a
 * hundred worktrees' worth at once would starve the agents working in them.
 */
const GIT_PARALLEL = 4

/**
 * Every git call cleanup makes to *read* goes through here; what changes a repository
 * (`worktree remove`, `branch -d`) is spelled out where it happens. Without
 * `--no-optional-locks`, `git status` refreshes a stale index and writes it back under
 * `index.lock` — in worktrees agents are working in, whose own `git commit` then fails
 * on the lock this scan holds. fsmonitor is off because a survey must not start a
 * watcher daemon in every repository it looks at; it only ever speeds status up, so
 * the answer is the same without it.
 */
async function gitRead(dir: string, args: readonly string[]): Promise<string | null> {
  const r = await execText(
    'git',
    ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', dir, ...args],
    { timeoutMs: 20_000 }
  )
  return r.ok ? r.stdout : null
}

/**
 * True when HEAD is detached on commits nothing else holds — no branch, tag or
 * remote. Removing the worktree would drop its reflog, the last thing pointing at
 * them. A git call that fails answers true: unsure is not safe to remove.
 */
async function unanchoredCommits(dir: string): Promise<boolean> {
  if ((await gitRead(dir, ['symbolic-ref', '-q', 'HEAD'])) !== null) return false
  const out = await gitRead(dir, ['rev-list', '--count', 'HEAD', '--not', '--branches', '--tags', '--remotes'])
  return out === null || Number(out.trim()) > 0
}

/** `du -sk` in bytes; null when it fails or takes too long to be worth waiting for. */
async function measureDir(path: string, timeoutMs = DU_TIMEOUT_MS): Promise<number | null> {
  if (timeoutMs <= 0) return null
  const r = await execText('du', ['-sk', path], { timeoutMs: Math.min(timeoutMs, DU_TIMEOUT_MS) })
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

/** `realish` for one survey or one action: each distinct path resolved once, then remembered. */
type Resolve = (path: string) => string

function dirMtime(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/** A worktree as git lists it, before anything is asked inside it. */
type ListedWorktree = {
  /** The repo root whose listing produced it — where its git commands run */
  readonly root: string
  readonly entry: WorktreeEntry
  /** Resolved, as every path it is compared with is */
  readonly path: string
  /** The repository's own checkout: the listing's first record */
  readonly isMain: boolean
  /** Registered, but its directory is gone */
  readonly missing: boolean
}

/**
 * Every worktree of every known repository, each once — a worktree two roots both
 * list is the first one's. One `git worktree list` per repository, a few at a time.
 */
async function listWorktrees(deps: CleanupDeps, resolve: Resolve): Promise<ListedWorktree[]> {
  const roots = deps.repoRoots()
  const listings = await mapLimit(
    roots,
    (root) => gitRead(root, ['worktree', 'list', '--porcelain']),
    GIT_PARALLEL
  )
  const out: ListedWorktree[] = []
  const seen = new Set<string>()
  for (const [r, root] of roots.entries()) {
    const listing = listings[r]
    if (listing === null) continue
    for (const [i, entry] of parseWorktreeList(listing).entries()) {
      const path = resolve(entry.path)
      if (seen.has(path)) continue
      seen.add(path)
      // bare repos have no working tree to clean at all
      if (entry.bare) continue
      out.push({ root, entry, path, isMain: i === 0, missing: entry.prunable || !existsSync(path) })
    }
  }
  return out
}

/** A listed worktree, with when it was last used. */
type AgedWorktree = ListedWorktree & {
  /**
   * Newest of its branch tip, the sessions indexed in it and its directory's mtime.
   * Exact for a stale worktree; for a fresh one it may stop at the first signal that
   * proves it fresh, since a fresh worktree's age is never shown.
   */
  readonly lastActivity: number
  /** Sessions indexed in it or below it */
  readonly sessionIds: readonly string[]
}

/**
 * How long a worktree has been idle. The branch tip costs a git process, so it is
 * asked only when the sessions and the directory have not already shown the worktree
 * used since `cutoff` — whatever the tip says then, it cannot make the worktree stale.
 */
async function ageWorktree(
  w: ListedWorktree,
  input: { readonly groups: readonly CwdSessions[]; readonly cutoff: number }
): Promise<AgedWorktree> {
  const inside = sessionsUnder(input.groups, w.path)
  const seen = lastWorktreeActivity([inside.newest, w.missing ? 0 : dirMtime(w.path)])
  const settled = w.missing || !isStale(seen, input.cutoff)
  const tip = settled ? null : await gitRead(w.path, ['log', '-1', '--format=%ct', 'HEAD'])
  const tipMs = tip === null ? 0 : Number(tip.trim()) * 1000
  return {
    ...w,
    lastActivity: lastWorktreeActivity([seen, Number.isFinite(tipMs) ? tipMs : 0]),
    sessionIds: inside.ids
  }
}

/** What every inspection in one survey or one action shares. */
type InspectContext = {
  readonly deps: CleanupDeps
  /** Resolved cwds of the sessions with a turn running */
  readonly busyCwds: readonly string[]
  /** Worktrees a process outside Cockpit is still running in */
  readonly processIn: ReadonlySet<string>
}

function inspectContext(
  deps: CleanupDeps,
  input: {
    readonly resolve: Resolve
    readonly sessions: readonly SessionMeta[]
    readonly busy: ReadonlySet<string>
    readonly listed: readonly ListedWorktree[]
    readonly procs: readonly ProcessFacts[]
  }
): InspectContext {
  return {
    deps,
    busyCwds: input.sessions
      .filter((s) => input.busy.has(s.id) && s.cwd)
      .map((s) => input.resolve(s.cwd as string)),
    processIn: worktreesWithProcesses(input.listed.map((w) => w.path), input.procs)
  }
}

/** What stands between a worktree and its removal, with what only git inside it can tell. */
type Inspection = {
  readonly blocks: CleanupBlock[]
  /** Commits on HEAD that no remote has — informational */
  readonly unpushed: number
}

/**
 * The git battery — status, unpushed commits, whether a detached HEAD's commits are
 * held anywhere else — run only for worktrees whose answer can matter: the stale ones
 * a survey lists, the ones picked for removal, the ones a session delete would take.
 * `status` walks the whole checkout, so it is skipped where no answer could lift a
 * block already there: the repository's own checkout, a worktree an agent is running
 * in, a table's room.
 */
async function inspectWorktree(w: ListedWorktree, ctx: InspectContext): Promise<Inspection> {
  const { entry, path, missing, isMain } = w
  const busy = !missing && ctx.busyCwds.some((c) => isUnder(c, path))
  const roundtable = ctx.deps.tableForCwd(path) !== null
  const settled = missing || isMain || busy || roundtable
  const dirty = settled ? false : isDirty(await gitRead(path, ['status', '--porcelain']))
  const unpushed =
    missing || isMain ? null : await gitRead(path, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])
  // a registration whose directory is gone has nothing left to protect — the
  // disk-derived facts are all false. git's own lock still counts: it is how a
  // worktree on a drive that comes and goes says it will be back
  const blocks = worktreeBlocks({
    isMain,
    locked: entry.locked,
    dirty,
    busy,
    roundtable,
    // nothing is left to protect in a directory that is already gone
    processes: !missing && ctx.processIn.has(path),
    unanchored: !missing && !isMain && entry.detached && (await unanchoredCommits(path))
  })
  return { blocks, unpushed: unpushed === null ? 0 : Number(unpushed.trim()) || 0 }
}

/** One stale worktree, fully judged — what the survey lists. */
type JudgedWorktree = StaleWorktree & { readonly repoRootForGit: string }

async function judgeWorktree(
  w: AgedWorktree,
  ctx: InspectContext,
  cockpitRoot: string
): Promise<JudgedWorktree> {
  const { blocks, unpushed } = await inspectWorktree(w, ctx)
  return {
    path: w.path,
    repoRoot: w.root,
    repoRootForGit: w.root,
    repoName: basename(w.root),
    branch: w.entry.branch,
    origin: worktreeOrigin(w.path, cockpitRoot),
    lastActivity: w.lastActivity,
    sessionCount: w.sessionIds.length,
    missing: w.missing,
    unpushed,
    bytes: null,
    blocks
  }
}

/**
 * What each worktree occupies, a few `du` at a time: started all at once, the walks
 * fought each other for the disk and most ran into their timeout. The step as a whole
 * keeps to `DU_BUDGET_MS`.
 */
async function sizeWorktrees(
  trees: readonly JudgedWorktree[]
): Promise<ReadonlyMap<string, number | null>> {
  const deadline = Date.now() + DU_BUDGET_MS
  const sizes = await mapLimit(
    trees,
    async (w) => (w.missing ? 0 : await measureDir(w.path, deadline - Date.now())),
    DU_PARALLEL
  )
  return new Map(trees.map((w, i) => [w.path, sizes[i]]))
}

/** Where worktrees get cut: Cockpit's root, each repo's `.claude/worktrees`, the extras. */
function worktreeHomes(deps: CleanupDeps): WorktreeHome[] {
  // Cockpit cuts `<root>/<repo>/<name>` (workspace.ts)
  const homes: WorktreeHome[] = [
    { path: realish(deps.cockpitWorktreeRoot), repoName: null, depth: 2 }
  ]
  for (const root of deps.repoRoots()) {
    homes.push({
      path: realish(join(root, '.claude', 'worktrees')),
      repoName: basename(root),
      depth: 1
    })
  }
  for (const extra of deps.worktreeHomes()) homes.push({ ...extra, path: realish(extra.path) })
  return homes
}

/**
 * The processes left behind in old worktrees, judged against a fresh listing. Only
 * where each worktree is and how long it has been idle decide it — none of the git
 * battery, which is why stopping processes never runs it.
 */
function orphanProcesses(
  deps: CleanupDeps,
  input: {
    readonly trees: readonly AgedWorktree[]
    readonly procs: readonly ProcessFacts[]
    readonly cutoff: number
  }
): JudgedProcess[] {
  return judgeProcesses({
    processes: input.procs,
    worktrees: input.trees.map((w) => ({
      path: w.path,
      repoName: basename(w.root),
      branch: w.entry.branch,
      isMain: w.isMain,
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
  here: string | null,
  cutoff: number
): JudgedWorktree | null {
  if (!here) return null
  for (const w of trees) {
    if (w.blocks.length > 0 || w.missing) continue
    if (!isStale(w.lastActivity, cutoff)) continue
    if (isUnder(here, w.path)) return w
  }
  return null
}

/** A scan's two readings: the report the view shows, and what could go right now. */
export type CleanupSurvey = {
  readonly report: CleanupReport
  /** Uncapped — the report's rows stop at the oldest 500, and the newest are the news */
  readonly ready: CleanupReady
}

export async function scanCleanup(deps: CleanupDeps, staleDays: number): Promise<CleanupReport> {
  return (await surveyCleanup(deps, staleDays)).report
}

/**
 * Surveys in flight, by what makes two asks the same question: the same Cockpit (its
 * roots and pid) and the same threshold. The view's scan and the daily reminder can
 * land together, and a second full survey beside the first doubles every git, lsof and
 * du for the same answer.
 */
const surveys = new Map<string, Promise<CleanupSurvey>>()

/**
 * A cleanup action that, once it ends, forgets every survey still in flight: begun
 * before the end, one may show what the action has just removed — and the view
 * rescans the moment an action returns.
 */
function retiringSurveys<A extends readonly unknown[], R>(
  action: (...args: A) => Promise<R>
): (...args: A) => Promise<R> {
  return async (...args) => {
    try {
      return await action(...args)
    } finally {
      surveys.clear()
    }
  }
}

/** One survey at a time per question: a second ask while one runs gets that one's answer. */
export function surveyCleanup(deps: CleanupDeps, staleDays: number): Promise<CleanupSurvey> {
  const days = clampStaleDays(staleDays)
  const key = [deps.cockpitWorktreeRoot, deps.roundtableRoot, deps.selfPid, days].join('\0')
  const running = surveys.get(key)
  if (running) return running
  const survey = runSurvey(deps, days).finally(() => {
    if (surveys.get(key) === survey) surveys.delete(key)
  })
  surveys.set(key, survey)
  return survey
}

async function runSurvey(deps: CleanupDeps, days: number): Promise<CleanupSurvey> {
  const scannedAt = Date.now()
  const cutoff = staleCutoff(days, scannedAt)
  const all = deps.sessions()
  const busy = deps.busyIds()
  const resolve = resolvedOnce(realish)
  const groups = sessionsByCwd(all, resolve)

  const [{ procs }, listed] = await Promise.all([processSnapshot(deps), listWorktrees(deps, resolve)])
  // how long each has been idle comes first, and cheaply: only a stale worktree is
  // ever shown, so only those go on to the git battery
  const aged = await mapLimit(listed, (w) => ageWorktree(w, { groups, cutoff }), GIT_PARALLEL)
  const linked = aged.filter((w) => !w.isMain)
  const ctx = inspectContext(deps, { resolve, sessions: all, busy, listed, procs })
  const cockpitRoot = resolve(deps.cockpitWorktreeRoot)
  const staleTrees = (
    await mapLimit(
      linked.filter((w) => isStale(w.lastActivity, cutoff)),
      (w) => judgeWorktree(w, ctx, cockpitRoot),
      GIT_PARALLEL
    )
  ).sort((a, b) => a.lastActivity - b.lastActivity)
  // only stale worktrees are sized: walking every checkout in every repo would
  // cost far more than the answer is worth
  const sizes = await sizeWorktrees(staleTrees)

  const staleMetas = all
    .filter((s) => isStale(s.updatedAt, cutoff))
    .sort((a, b) => a.updatedAt - b.updatedAt)
  const sessions: StaleSession[] = []
  let n = 0
  for (const s of staleMetas) {
    if (++n % YIELD_EVERY === 0) await yieldToLoop()
    const w = worktreeForCwd(staleTrees, s.cwd ? resolve(s.cwd) : null, cutoff)
    sessions.push({
      id: s.id,
      provider: s.provider,
      title: s.title,
      repoName: s.repo?.name ?? null,
      cwd: s.cwd,
      updatedAt: s.updatedAt,
      bytes: sessionBytes(s),
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

  const allTables = deps.tables()
  const seats = deps.seatSessions()
  const staleTables: StaleTable[] = []
  // archived means "I am done with this", so it is listed without waiting out the
  // threshold — unlike a session, a table is archived one at a time, by hand
  const listable = allTables
    .filter((t) => t.archived || isStale(t.updatedAt, cutoff))
    .sort((a, b) => a.updatedAt - b.updatedAt)
  for (const t of listable) {
    const mine = seats.filter((s) => s.roundtableId === t.id)
    const dirBytes = (await measureDir(t.cwd)) ?? null
    const logBytes = mine.reduce((n, s) => n + sessionBytes(s), 0)
    const w = staleTrees.find((tree) => tree.path === resolve(t.cwd))
    staleTables.push({
      id: t.id,
      title: t.title,
      providers: t.providers,
      repoName: t.repoName,
      cwd: t.cwd,
      updatedAt: t.updatedAt,
      entryCount: t.entryCount,
      seatCount: mine.length,
      bytes: dirBytes === null ? null : dirBytes + logBytes,
      archived: t.archived,
      worktree: w ? { path: w.path, branch: w.branch, bytes: sizes.get(w.path) ?? null, sessionCount: w.sessionCount } : null,
      blocks: t.running ? ['busy'] : []
    })
  }
  const tableRows = staleTables.slice(0, CLEANUP_ROW_CAP)

  const rows = sessions.slice(0, CLEANUP_ROW_CAP)
  // a worktree a listed session will take with it is not also listed on its own —
  // every worktree appears exactly once across the report
  const claimed = new Set(
    [...rows, ...tableRows].map((r) => r.worktree?.path).filter((p): p is string => !!p)
  )
  const orphans: StaleWorktree[] = staleTrees
    .filter((w) => !claimed.has(w.path))
    .slice(0, CLEANUP_ROW_CAP)
    .map(({ repoRootForGit: _drop, ...w }) => ({ ...w, bytes: sizes.get(w.path) ?? null }))

  const left = orphanProcesses(deps, { trees: aged, procs, cutoff })
  const processes: OrphanProcess[] = left
    .slice(0, CLEANUP_ROW_CAP)
    .map(({ ppid: _ppid, ...p }) => p)

  // what could go right now, uncapped: blocked rows are the person's to resolve first.
  // A session's worktree goes with it, so it is sized once and not listed again
  const readySessions = sessions.filter((s) => s.blocks.length === 0)
  const readyTrees = staleTrees.filter((w) => w.blocks.length === 0)
  const readyTables = staleTables.filter((t) => t.blocks.length === 0)
  const takenWith = new Set(readySessions.map((s) => s.worktree?.path).filter((p): p is string => !!p))
  const ready: CleanupReady = {
    staleDays: days,
    sessions: readySessions.map((s) => s.id),
    worktrees: readyTrees.filter((w) => !takenWith.has(w.path)).map((w) => w.path),
    tables: readyTables.map((t) => t.id),
    processes: left.map(processKey),
    bytes:
      sumBytes(readySessions) +
      readyTrees.reduce((n, w) => n + (sizes.get(w.path) ?? 0), 0) +
      sumBytes(readyTables)
  }

  const report: CleanupReport = {
    staleDays: days,
    scannedAt,
    sessions: rows,
    staleSessionCount: sessions.length,
    staleSessionBytes: sessions.reduce((n, s) => n + s.bytes, 0),
    worktrees: orphans,
    staleWorktreeCount: staleTrees.length,
    tables: tableRows,
    staleTableCount: staleTables.length,
    totalTables: allTables.length,
    processes,
    totalSessions: all.length,
    totalWorktrees: linked.length
  }
  return { report, ready }
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
 * `git branch -d`, never -D: git's own merged check is the safety net for the commits
 * worktree removal deliberately leaves behind. The name is read from git, and a ref
 * made with plumbing can start with `-` — after `--` it can only ever be a name, never
 * `-D` or `--force`.
 */
async function deleteMergedBranch(repoRoot: string, branch: string): Promise<boolean> {
  return (await execText('git', ['-C', repoRoot, 'branch', '-d', '--', branch])).ok
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
export const deleteSessions = retiringSurveys(async function deleteSessions(
  deps: CleanupDeps,
  ids: readonly string[],
  staleDays: number
): Promise<CleanupResult & { readonly deletedIds: readonly string[] }> {
  const all = deps.sessions()
  const byId = new Map(all.map((s) => [s.id, s]))
  const roots = deps.sourceDirs().map((d) => resolve(d))
  const busy = deps.busyIds()
  const failed: { target: string; reason: string }[] = []
  const branchesDeleted: string[] = []
  const deleted = new Set<string>()
  let cleaned = 0
  let freedBytes = 0
  const cutoff = staleCutoff(staleDays, Date.now())

  let n = 0
  for (const raw of ids) {
    // a selection can run to thousands of logs, each a synchronous rm — IPC must not
    // wait on all of them
    if (++n % YIELD_EVERY === 0) await yieldToLoop()
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
    // Only stale sessions are listed. One used since the scan — resumed in a
    // terminal, sitting at its prompt, so not "busy" — is live work again, and its
    // transcript is no longer the one the user chose to delete.
    if (!isStale(meta.updatedAt, cutoff)) {
      failed.push({ target: meta.title || id, reason: 'it was used again since the scan' })
      continue
    }
    const targets = deleteTargets(meta)
    const outside = targets.find((t) => !roots.some((r) => isUnder(t, r)))
    if (outside) {
      audit(`refused session ${id}: ${outside} is outside every configured source`)
      failed.push({ target: meta.title || id, reason: 'outside every configured source' })
      continue
    }
    const bytes = sessionBytes(meta)
    try {
      // earlier pages first: a failure part-way leaves the session listed on its
      // newest file, never an old page left behind to pose as the whole thread
      for (const target of targets) rmSync(target, { recursive: true, force: false })
      cleaned++
      deleted.add(id)
      freedBytes += bytes
      audit(`removed session ${id}: ${targets.join(', ')} (${bytes} bytes)`)
    } catch (err) {
      failed.push({
        target: meta.title || id,
        reason: err instanceof Error ? err.message : String(err)
      })
    }
  }

  if (deleted.size > 0) {
    const cascade = await takeWorktreesWith(deps, { sessions: all, deleted, cutoff })
    freedBytes += cascade.freedBytes
    failed.push(...cascade.failed)
    branchesDeleted.push(...cascade.branchesDeleted)
  }

  return { cleaned, freedBytes, failed, branchesDeleted, deletedIds: [...deleted] }
})

/**
 * The worktrees going with `deleted`: each only when every session indexed in it is
 * among them, and only when it is stale and unblocked. The cheap test runs first, so
 * the process table and the git battery are read only for the worktrees that pass it —
 * usually a handful, often none.
 */
async function takeWorktreesWith(
  deps: CleanupDeps,
  input: {
    /** Every session indexed before the deletion, the deleted ones included */
    readonly sessions: readonly SessionMeta[]
    readonly deleted: ReadonlySet<string>
    readonly cutoff: number
  }
): Promise<{
  readonly freedBytes: number
  readonly failed: readonly { readonly target: string; readonly reason: string }[]
  readonly branchesDeleted: readonly string[]
}> {
  const resolve = resolvedOnce(realish)
  const groups = sessionsByCwd(input.sessions, resolve)
  const listed = await listWorktrees(deps, resolve)
  const going = listed.filter((w) => {
    if (w.isMain || w.missing) return false
    const inside = sessionsUnder(groups, w.path).ids
    // no session of its own is not this action's business — that is an orphan,
    // and orphans are cleaned from the worktrees list, deliberately by hand
    return inside.length > 0 && inside.every((id) => input.deleted.has(id))
  })
  const failed: { target: string; reason: string }[] = []
  const branchesDeleted: string[] = []
  let freedBytes = 0
  if (going.length === 0) return { freedBytes, failed, branchesDeleted }
  const snapshot = await processSnapshot(deps)
  const ctx = inspectContext(deps, {
    resolve,
    sessions: input.sessions,
    busy: deps.busyIds(),
    listed,
    procs: snapshot.procs
  })
  for (const listedTree of going) {
    const w = await ageWorktree(listedTree, { groups, cutoff: input.cutoff })
    if (!isStale(w.lastActivity, input.cutoff)) continue
    if ((await inspectWorktree(w, ctx)).blocks.length > 0) continue
    if (!snapshot.complete) {
      failed.push({ target: w.path, reason: UNCHECKED })
      continue
    }
    const bytes = (await measureDir(w.path)) ?? 0
    const removed = await execText('git', ['-C', w.root, 'worktree', 'remove', w.path], {
      timeoutMs: 60_000
    })
    if (!removed.ok) {
      failed.push({
        target: w.path,
        reason: removed.stderr.trim() || 'git refused to remove the worktree'
      })
      continue
    }
    freedBytes += bytes
    audit(`removed worktree ${w.path} (${bytes} bytes)`)
    const branch = w.entry.branch
    if (branch && (await deleteMergedBranch(w.root, branch))) {
      branchesDeleted.push(branch)
      audit(`deleted branch ${branch} in ${w.root}`)
    }
  }
  return { freedBytes, failed, branchesDeleted }
}

/**
 * Delete whole roundtables. The unit is the table, so one deletion takes, in order:
 * every seat session's log (re-validated against the configured sources, exactly as
 * deleteSessions does), then the directory the table ran in — its own room under
 * `<userData>/roundtables`, or its worktree through git, with the branch when git
 * says it is fully merged — and finally the table record. A table mid-round is
 * refused; so is a room outside the roundtable root, and a worktree git will not
 * give up (never --force). A table's room is only ever removed *with* its table,
 * which is why the worktrees list keeps refusing it on its own.
 */
export const deleteRoundtables = retiringSurveys(async function deleteRoundtables(
  deps: CleanupDeps,
  ids: readonly string[],
  staleDays: number
): Promise<CleanupResult & { readonly deletedIds: readonly string[] }> {
  const byId = new Map(deps.tables().map((t) => [t.id, t]))
  const seats = deps.seatSessions()
  const sourceRoots = deps.sourceDirs().map((d) => resolve(d))
  const roomRoot = realish(deps.roundtableRoot)
  const failed: { target: string; reason: string }[] = []
  const branchesDeleted: string[] = []
  let cleaned = 0
  let freedBytes = 0
  const deletedIds: string[] = []
  const cutoff = staleCutoff(staleDays, Date.now())

  for (const raw of ids) {
    const id = String(raw)
    const t = byId.get(id)
    if (!t) {
      failed.push({ target: id, reason: 'no longer a roundtable Cockpit keeps' })
      continue
    }
    const name = t.title || id
    if (t.running) {
      failed.push({ target: name, reason: 'a round is running — stop it first' })
      continue
    }
    // the same rule the scan listed it by: archived, or idle past the threshold
    if (!t.archived && !isStale(t.updatedAt, cutoff)) {
      failed.push({ target: name, reason: 'it was used again since the scan' })
      continue
    }

    // A room git will refuse to remove is checked before anything goes: the seat
    // logs used to be unlinked first, and a dirty room then kept the table, its
    // record and its worktree — with transcripts its seats can no longer resume.
    const room = realish(t.cwd)
    if (t.repoRoot && existsSync(room)) {
      if (isDirty(await gitRead(room, ['status', '--porcelain']))) {
        failed.push({ target: name, reason: 'its worktree has uncommitted changes' })
        continue
      }
      if (await unanchoredCommits(room)) {
        failed.push({ target: name, reason: 'its worktree’s detached HEAD has commits no branch holds' })
        continue
      }
    }

    // the seats first: their logs are provider files like any other session's
    let seatTrouble: string | null = null
    for (const s of seats.filter((s) => s.roundtableId === id)) {
      const targets = deleteTargets(s)
      const outside = targets.find((t) => !sourceRoots.some((r) => isUnder(t, r)))
      if (outside) {
        audit(`refused seat ${s.id} of table ${id}: ${outside} is outside every configured source`)
        seatTrouble = 'a seat session sits outside every configured source'
        break
      }
      const bytes = sessionBytes(s)
      try {
        for (const target of targets) rmSync(target, { recursive: true, force: false })
        freedBytes += bytes
        audit(`removed seat ${s.id} of table ${id}: ${targets.join(', ')} (${bytes} bytes)`)
      } catch (err) {
        seatTrouble = err instanceof Error ? err.message : String(err)
        break
      }
    }
    if (seatTrouble) {
      failed.push({ target: name, reason: seatTrouble })
      continue
    }

    // then the directory the table ran in
    const dir = room
    const bytes = (await measureDir(dir)) ?? 0
    if (t.repoRoot) {
      const removed = await execText('git', ['-C', t.repoRoot, 'worktree', 'remove', dir], {
        timeoutMs: 60_000
      })
      if (!removed.ok && existsSync(dir)) {
        failed.push({
          target: name,
          reason: removed.stderr.trim() || 'git refused to remove the table’s worktree'
        })
        continue
      }
      freedBytes += bytes
      audit(`removed table worktree ${dir} (${bytes} bytes)`)
      if (t.branch && (await deleteMergedBranch(t.repoRoot, t.branch))) {
        branchesDeleted.push(t.branch)
        audit(`deleted branch ${t.branch} in ${t.repoRoot}`)
      }
    } else {
      // a scratch room: main derived the path, and it must still sit under the root
      if (!isUnder(dir, roomRoot)) {
        audit(`refused table ${id}: ${dir} is outside ${roomRoot}`)
        failed.push({ target: name, reason: 'its room sits outside the roundtable directory' })
        continue
      }
      try {
        rmSync(dir, { recursive: true, force: true })
        freedBytes += bytes
        audit(`removed table room ${dir} (${bytes} bytes)`)
      } catch (err) {
        failed.push({ target: name, reason: err instanceof Error ? err.message : String(err) })
        continue
      }
    }

    try {
      deps.forgetTable(id)
    } catch (err) {
      // a round started since the check above: the table stays, the rest go on
      failed.push({ target: name, reason: err instanceof Error ? err.message : String(err) })
      continue
    }
    cleaned++
    deletedIds.push(id)
    audit(`removed table ${id} (${name})`)
  }

  return { cleaned, freedBytes, failed, branchesDeleted, deletedIds }
})

/**
 * The registration `repoRoot` holds at `path` (resolved), whether or not its directory
 * is still there; undefined when git could not list its worktrees at all.
 */
async function registrationAt(repoRoot: string, path: string): Promise<WorktreeEntry | null | undefined> {
  const listing = await gitRead(repoRoot, ['worktree', 'list', '--porcelain'])
  if (listing === null) return undefined
  return parseWorktreeList(listing).find((e) => realish(e.path) === path) ?? null
}

/**
 * Clear the registration of one worktree whose directory is gone — that one alone.
 * `git worktree prune` would drop every registration whose directory is missing, a
 * worktree on a drive that is only unmounted among them, picked or not. Only a
 * registration git itself calls prunable, and nothing has locked, is asked for; the
 * listing is read again afterwards, because one still there is a failure whatever
 * git's exit status said. Resolves with why it was kept, or null once it is gone.
 */
async function dropRegistration(repoRoot: string, path: string): Promise<string | null> {
  const held = await registrationAt(repoRoot, path)
  if (held === null) return null
  if (held === undefined) return 'git could not list the repository’s worktrees — try again'
  if (held.locked) return blockReason(['locked'])
  if (!held.prunable || existsSync(path)) return 'git still sees its directory — rescan'
  const removed = await execText('git', ['-C', repoRoot, 'worktree', 'remove', held.path], {
    timeoutMs: 60_000
  })
  if ((await registrationAt(repoRoot, path)) === null) return null
  return removed.stderr.trim() || 'git kept the worktree’s registration'
}

/**
 * `git worktree remove` each path, then drop the branch when git says it is fully
 * merged. Deliberately never passes --force: the listing is re-derived here, and a
 * worktree that has picked up a block since the scan is refused rather than forced.
 * Only the picked worktrees are inspected, each just before it goes.
 */
export const removeWorktrees = retiringSurveys(async function removeWorktrees(
  deps: CleanupDeps,
  paths: readonly string[]
): Promise<CleanupResult> {
  const resolve = resolvedOnce(realish)
  const snapshot = await processSnapshot(deps)
  const listed = await listWorktrees(deps, resolve)
  const byPath = new Map(listed.map((w) => [w.path, w]))
  const ctx = inspectContext(deps, {
    resolve,
    sessions: deps.sessions(),
    busy: deps.busyIds(),
    listed,
    procs: snapshot.procs
  })
  const failed: { target: string; reason: string }[] = []
  const branchesDeleted: string[] = []
  let cleaned = 0
  let freedBytes = 0
  // a path picked twice is one worktree: the second ask would only meet it gone
  for (const path of new Set(paths.map((raw) => resolve(String(raw))))) {
    const w = byPath.get(path)
    if (!w) {
      failed.push({ target: path, reason: 'not a worktree of any known repository' })
      continue
    }
    const { blocks } = await inspectWorktree(w, ctx)
    if (blocks.length > 0) {
      failed.push({ target: path, reason: blockReason(blocks) })
      continue
    }
    if (!w.missing && !snapshot.complete) {
      failed.push({ target: path, reason: UNCHECKED })
      continue
    }
    if (w.missing) {
      // nothing on disk: the registration is the only thing left to clear
      const kept = await dropRegistration(w.root, path)
      if (kept) {
        failed.push({ target: path, reason: kept })
        continue
      }
      audit(`cleared the registration of missing worktree ${path} from ${w.root}`)
      cleaned++
      continue
    }
    const bytes = (await measureDir(path)) ?? 0
    const removed = await execText('git', ['-C', w.root, 'worktree', 'remove', path], {
      timeoutMs: 60_000
    })
    if (!removed.ok) {
      failed.push({ target: path, reason: removed.stderr.trim() || 'git refused to remove it' })
      continue
    }
    cleaned++
    freedBytes += bytes
    audit(`removed worktree ${path} (${bytes} bytes)`)
    const branch = w.entry.branch
    if (branch && (await deleteMergedBranch(w.root, branch))) {
      branchesDeleted.push(branch)
      audit(`deleted branch ${branch} in ${w.root}`)
    }
  }
  return { cleaned, freedBytes, failed, branchesDeleted }
})

/** The first block is the one worth showing — they are ordered by weight. */
function blockReason(blocks: readonly CleanupBlock[]): string {
  const REASONS: Record<CleanupBlock, string> = {
    main: 'this is the repository’s own checkout',
    roundtable: 'it is a roundtable’s shared room',
    busy: 'an agent is running in it',
    process: 'a process is still running in it — stop it first',
    dirty: 'it has uncommitted changes',
    detached: 'its detached HEAD has commits no branch holds — branch them first',
    locked: 'the worktree is locked'
  }
  return REASONS[blocks[0]] ?? 'it cannot be removed'
}

/**
 * SIGTERM each process, then give them a moment to exit. The targets are renderer
 * input, so the whole judgement is re-derived first and only a pid that is still
 * a process left in an old worktree — same cwd judgement, and not Cockpit's own
 * tree — is signalled. A pid is only a number the OS hands out again, so the
 * process must also still be the one that was picked: the same command line,
 * started at the same moment. Never SIGKILL: a process that ignores the polite
 * signal is reported, not forced.
 */
export const stopProcesses = retiringSurveys(async function stopProcesses(
  deps: CleanupDeps,
  targets: readonly ProcessTarget[],
  staleDays: number
): Promise<CleanupResult> {
  // the worktree walk first, so the process table is read as close to the signal as
  // it can be. Which processes are left behind turns on each worktree's place and
  // age alone, so the walk is the listing and the ages — none of the git battery.
  const resolve = resolvedOnce(realish)
  const cutoff = staleCutoff(staleDays, Date.now())
  const groups = sessionsByCwd(deps.sessions(), resolve)
  const trees = await mapLimit(
    await listWorktrees(deps, resolve),
    (w) => ageWorktree(w, { groups, cutoff }),
    GIT_PARALLEL
  )
  const { procs } = await processSnapshot(deps)
  const orphans = new Map(orphanProcesses(deps, { trees, procs, cutoff }).map((p) => [p.pid, p]))
  const failed: { target: string; reason: string }[] = []
  const signalled: JudgedProcess[] = []
  const picked = new Map(targets.map((t) => [t.pid, t]))
  for (const t of picked.values()) {
    const p = orphans.get(t.pid)
    if (!p) {
      failed.push({ target: `pid ${t.pid}`, reason: 'no longer a process left in an old worktree' })
      continue
    }
    if (!sameProcess(p, t)) {
      audit(`refused pid ${p.pid}: now "${p.command}" started ${p.startedAt}, picked ${t.startedAt}`)
      failed.push({ target: label(p), reason: 'the pid now belongs to a different process — rescan' })
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
})

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
