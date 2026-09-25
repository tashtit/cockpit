import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  watch,
  type FSWatcher
} from 'node:fs'
import { writeFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type {
  BusySession,
  Mutable,
  Provider,
  RepoGroup,
  SessionMeta,
  SessionMessage,
  SessionPage,
  SessionQuery,
  SessionSegment,
  SourceDir,
  SourceStats
} from '../shared/types'
import { orderRepos } from '../shared/repo-order'
import { isUnder } from './paths'
import { GENERAL_REPO, branchForCwd, clearRepoCache, resolveRepo } from './repos'
import { isRegularFile, timeSlicer } from './parsers/util'
import { LivenessTracker, type ObservedTurn } from './liveness'
import { ProviderArchivedReader, defaultClaudeStoreDir } from './provider-archived'
import {
  listClaudeSessionFiles,
  listClaudeSessionRoots,
  parseClaudeMeta,
  parseClaudeMessages
} from './parsers/claude'
import {
  codexThreadName,
  listCodexSessionFiles,
  listCodexSessionRoots,
  parseCodexMeta,
  parseCodexMessages,
  readCodexMeta
} from './parsers/codex'
import {
  copilotWorkspaceFile,
  listCopilotSessionFiles,
  listCopilotSessionRoots,
  parseCopilotMeta,
  parseCopilotMessages
} from './parsers/copilot'

const FILE_LISTERS = {
  claude: listClaudeSessionFiles,
  codex: listCodexSessionFiles,
  copilot: listCopilotSessionFiles
} as const

const ROOT_LISTERS = {
  claude: listClaudeSessionRoots,
  codex: listCodexSessionRoots,
  copilot: listCopilotSessionRoots
} as const

const META_PARSERS = {
  claude: parseClaudeMeta,
  codex: parseCodexMeta,
  copilot: parseCopilotMeta
} as const

const MESSAGE_PARSERS = {
  claude: parseClaudeMessages,
  codex: parseCodexMessages,
  copilot: parseCopilotMessages
} as const

export const DEFAULT_PAGE_SIZE = 30
/** Bump when meta-parser output changes so stale disk caches get re-parsed. */
const CACHE_VERSION = 10
/** Yield to the event loop after this much scanning so scans never starve IPC (a frame). */
const SCAN_SLICE_MS = 16
/** Publish partial results during a cold scan so the tree fills in progressively. */
const PUBLISH_EVERY = 300
/** Broadcasts and cache writes are throttled — an active chat appends every second. */
const UPDATE_THROTTLE_MS = 800
const CACHE_SAVE_INTERVAL_MS = 30_000
/** How often to re-check watch roots that didn't exist when sources were set. */
const WATCH_RETRY_INTERVAL_MS = 30_000

/** Floor for re-judging a not-a-session verdict (see knownNonSessions). */
const PROBE_REGROW_BYTES = 4096

/** A changed session file is re-read no later than this after its first write. */
const DIRTY_FLUSH_MS = 500
/** Structural events settle this long before a full rescan… */
const RESCAN_QUIET_MS = 750
/**
 * …but never wait longer than this for the quiet: macOS reports every append to a
 * freshly created file as `rename` for its first seconds, so a new session streaming
 * its opening turn would otherwise hold the rescan off for as long as it writes.
 */
const RESCAN_MAX_WAIT_MS = 3000

let cacheSaveSeq = 0
/**
 * A fixed tmp name races when saves overlap (slow disk, quit flush during an
 * in-flight async save, or two app instances sharing userData): the first
 * rename consumes the tmp file and the second fails with ENOENT. The pid keeps
 * instances apart; the counter keeps saves within a process apart.
 */
function nextCacheTmp(cacheFile: string): string {
  return `${cacheFile}.${process.pid}.${++cacheSaveSeq}.tmp`
}

/** A save's tmp file this old belongs to no save still running, whichever instance wrote it. */
const STALE_CACHE_TMP_MS = 10 * 60_000

/**
 * A save interrupted between its write and its rename — a crash, a force quit — leaves
 * its tmp file behind, a whole copy of the cache, and nothing else ever removes one.
 * Only files named the way nextCacheTmp names them are touched, and only old ones: a
 * second instance sharing userData may be mid-save right now.
 */
function sweepCacheTmps(cacheFile: string): void {
  const dir = dirname(cacheFile)
  const prefix = `${basename(cacheFile)}.`
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return // no userData dir yet
  }
  const cutoff = Date.now() - STALE_CACHE_TMP_MS
  for (const name of names) {
    if (!name.startsWith(prefix) || !/^\d+\.\d+\.tmp$/.test(name.slice(prefix.length))) continue
    const p = join(dir, name)
    try {
      const st = lstatSync(p)
      if (st.isFile() && st.mtimeMs < cutoff) rmSync(p, { force: true })
    } catch {
      // removed by someone else between the listing and here
    }
  }
}

type CacheEntry = {
  readonly mtimeMs: number
  readonly size: number
  /** mtime of copilot's out-of-band name source, workspace.yaml (see auxStamp) */
  readonly aux?: number
  /**
   * Codex: the thread its title was looked up under in session_index.jsonl, and the
   * name found. The index is one file for every rollout, so its mtime cannot stand for
   * any one of them — the entry is stale only when its own thread's name changed.
   */
  readonly threadId?: string | null
  readonly threadName?: string | null
  readonly meta: SessionMeta | null
}

/**
 * Copilot stores the generated session name beside the transcript, so a rename doesn't
 * touch the transcript's (mtime,size). Stamp the side file's mtime into the cache entry
 * so name changes invalidate it. (Codex keeps its names in one shared index instead —
 * see CacheEntry.threadName.)
 */
function auxStamp(file: string, source: SourceDir): number {
  if (source.provider !== 'copilot' || !file.endsWith('events.jsonl')) return 0
  try {
    return statSync(copilotWorkspaceFile(file)).mtimeMs
  } catch {
    return 0
  }
}

/** Is a cached Codex entry still named what its thread is named now? */
function sameThreadName(file: string, entry: CacheEntry): boolean {
  if (!entry.threadId) return true
  return codexThreadName(file, entry.threadId) === (entry.threadName ?? null)
}

/**
 * Provider dirs contain far more than sessions (binaries, clones, DBs) — never watch those.
 * Blacklist by extension/dir-name (not whitelist) so directories with dots in their names
 * (e.g. sanitized cwd paths like "-Users-x-dev-app.web") aren't silently unwatched.
 */
function watchIgnored(p: string): boolean {
  // subagents/**: sidechain transcripts the listers exclude — without this,
  // every agent append would fall through markDirty into a full rescan
  if (/\/(checkpoints|files|research|logs|subagents)(\/|$)/.test(p)) return true
  return /\.(db|db-wal|db-shm|sqlite|log|md|txt|png|jpe?g|gif|svg|zip|gz|tar|lock)$/i.test(p)
}

/**
 * `<projects>/<proj>/<session-id>/subagents/agent-x.jsonl` → `claude:<session-id>`.
 * Subagent transcripts are never sessions (the listers skip them), but a Claude parent
 * log goes silent while its subagent works — a write there is the parent's heartbeat.
 */
export function subagentParent(path: string): string | null {
  const m = path.match(/\/([^/]+)\/subagents\/[^/]+\.jsonl$/)
  return m ? `claude:${m[1]}` : null
}

/** Add one file's meta to the files already found for its session id; returns them all. */
function collect(files: Map<string, SessionMeta[]>, meta: SessionMeta): SessionMeta[] {
  const found = files.get(meta.id)
  if (found) {
    found.push(meta)
    return found
  }
  const fresh = [meta]
  files.set(meta.id, fresh)
  return fresh
}

/**
 * One session from every file that carries its id. Usually that is one file, or the
 * same log found under two sources — the most recently updated copy wins. A Codex
 * thread paginated into a new rollout (`historyBase`) is several files: they fold
 * into one session on the newest file (what liveness tails and a resume continues),
 * with the earlier ones as `segments` so its start, title, count and transcript are
 * the whole thread's.
 */
export function foldThread(metas: readonly SessionMeta[]): SessionMeta {
  const newest = metas.reduce((a, b) => (b.updatedAt >= a.updatedAt ? b : a))
  if (metas.length === 1 || !metas.some((m) => m.historyBase)) return newest
  const order = [...metas].sort((a, b) => a.startedAt - b.startedAt || a.updatedAt - b.updatedAt)
  const tip = order[order.length - 1]
  const chain = [tip]
  const segments: SessionSegment[] = []
  for (let i = order.length - 2; i >= 0; i--) {
    const base = chain[0].historyBase
    if (!base) break
    const prev = order[i]
    // the same rollout found under a second source is a copy, not an earlier page
    if (prev.startedAt === chain[0].startedAt) continue
    segments.unshift({ path: prev.sourcePath, endByte: base.endByte })
    chain.unshift(prev)
  }
  if (segments.length === 0) return newest
  const first = chain[0]
  return {
    ...tip,
    // a named thread names every page alike; unnamed, the first prompt is on page one
    title: first.title !== '(untitled)' ? first.title : tip.title,
    startedAt: first.startedAt,
    updatedAt: Math.max(...chain.map((m) => m.updatedAt)),
    messageCount: chain.reduce((n, m) => n + m.messageCount, 0),
    segments
  }
}

/** A watch we want installed; kept pending while its directory doesn't exist yet. */
type WatchSpec = {
  readonly dir: string
  readonly recursive?: boolean
  readonly handler: (event: string, filename: string | Buffer | null) => void
}

export class SessionIndexer {
  private sessions = new Map<string, SessionMeta>()
  /** file path → parse result keyed on (mtime,size); only changed files get re-read */
  private fileCache = new Map<string, CacheEntry>()
  private fileSource = new Map<string, SourceDir>()
  private watchers: FSWatcher[] = []
  /** Watch dirs that didn't exist yet (provider installed later) — retried on a timer */
  private pendingWatches: WatchSpec[] = []
  private watchRetryTimer: NodeJS.Timeout | null = null
  private watchRetryMs: number
  private dirty = new Set<string>()
  private dirtyTimer: NodeJS.Timeout | null = null
  private rescanTimer: NodeJS.Timeout | null = null
  /** When the pending rescan must start however busy the watcher is (RESCAN_MAX_WAIT_MS) */
  private rescanDeadline = 0
  /**
   * Session-shaped files whose parse came back null (e.g. codex subagent rollouts,
   * which live in the same sessions/YYYY/MM/DD dirs as real rollouts). They stream
   * appends for minutes — without this verdict cache every append would debounce
   * into a full rescan. Cleared on rescan so the truth is re-derived.
   *
   * Keyed to the size at verdict time: a file can also parse as null merely because
   * it had no messages *yet*, so the verdict is re-derived once the file grows
   * substantially (see PROBE_REGROW_FACTOR) rather than being final.
   */
  private knownNonSessions = new Map<string, number>()
  private updateTimer: NodeJS.Timeout | null = null
  private saveTimer: NodeJS.Timeout | null = null
  private cacheDirty = false
  /** In-flight cache save — later saves chain onto it (see saveCacheAsync) */
  private savingCache: Promise<void> = Promise.resolve()
  private scanning = false
  /** Settles when the first full scan finishes (or fails) — see whenScanned */
  private readonly firstScan: Promise<void>
  private markScanned: () => void = () => {}
  private scanQueued = false
  private sources: SourceDir[] = []
  private archived = new Set<string>()
  /** Handoff lineage (session id → source session id) from cockpit config */
  private lineage = new Map<string, string>()
  /** Archived or deleted in the provider's own app — excluded everywhere (see provider-archived.ts) */
  private providerArchived = new Set<string>()
  private providerArchivedTimer: NodeJS.Timeout | null = null
  /** Repo keys the user chose not to display */
  private hiddenRepos = new Set<string>()
  /** Repo keys in the user's drag order (repo-order.ts); empty = A→Z */
  private repoOrder: string[] = []
  /** Days of history to display — sessions idle longer are hidden; 0 = all */
  private historyDays = 0
  private onUpdate: () => void
  private cacheFile: string | null
  /** undefined → the real desktop-app store; null → disabled (tests) */
  private claudeStoreDir: string | null
  /** Reads the providers' own archived state, remembering what it read (see its docstring). */
  private archivedReader: ProviderArchivedReader
  /**
   * Sessions whose logs show a turn in progress (liveness.ts). Fed from the one place
   * a changed file is re-parsed, so the watcher's debouncing and the scan's yielding
   * are its pacing too; it reads a bounded tail of fresh files only.
   */
  private liveness: LivenessTracker
  /** knownRepoRoots(), until the next emitUpdate */
  private repoRoots: ReadonlySet<string> | null = null

  constructor(
    onUpdate: () => void,
    opts?: {
      cacheFile?: string
      watchRetryMs?: number
      claudeStoreDir?: string | null
      /** The observed busy set changed — a turn started, ended or expired in some log */
      onLiveChange?: (sessions: BusySession[]) => void
      /** An observed turn started, stopped to ask, or wrote its ending record (never an expiry) */
      onLiveTurn?: (ev: ObservedTurn) => void
      liveWindowMs?: number
    }
  ) {
    this.onUpdate = onUpdate
    this.cacheFile = opts?.cacheFile ?? null
    this.watchRetryMs = opts?.watchRetryMs ?? WATCH_RETRY_INTERVAL_MS
    this.claudeStoreDir = opts?.claudeStoreDir === undefined ? defaultClaudeStoreDir() : opts.claudeStoreDir
    this.archivedReader = new ProviderArchivedReader(this.claudeStoreDir)
    this.liveness = new LivenessTracker(opts?.onLiveChange ?? (() => {}), {
      windowMs: opts?.liveWindowMs,
      onTurn: opts?.onLiveTurn
    })
    this.firstScan = new Promise((resolve) => (this.markScanned = resolve))
    this.loadCache()
  }

  /**
   * Resolves once a full scan has finished. Until then an empty repo list means
   * "not read yet", not "nothing there" — the first-run setup card waits on this so
   * it never flashes at someone whose sessions are still being read.
   */
  whenScanned(): Promise<void> {
    return this.firstScan
  }

  /** Sessions whose logs show a turn in progress right now — the observed half of the busy set. */
  liveSessions(): BusySession[] {
    return this.liveness.sessions()
  }

  /** Applied at query time so toggling archive never re-parses anything. */
  setArchived(ids: string[]): void {
    this.archived = new Set(ids)
    this.emitUpdate()
  }

  /** Applied at query time like archived — lineage lives in cockpit config, not provider logs. */
  setLineage(map: Record<string, string>): void {
    this.lineage = new Map(Object.entries(map))
    this.emitUpdate()
  }

  /** Applied at query time; repo groups stay listed (flagged hidden) for the chooser UI. */
  setHiddenRepos(keys: string[]): void {
    this.hiddenRepos = new Set(keys)
    this.emitUpdate()
  }

  /** Applied at query time; only the project order changes, never what is listed. */
  setRepoOrder(keys: string[]): void {
    this.repoOrder = [...keys]
    this.emitUpdate()
  }

  /** Applied at query time so changing the window never re-parses anything. */
  setHistoryDays(days: number): void {
    this.historyDays = days > 0 ? days : 0
    this.emitUpdate()
  }

  /** Epoch ms floor for displayed sessions; 0 = no floor (all history). */
  private historyCutoff(): number {
    return this.historyDays > 0 ? Date.now() - this.historyDays * 86_400_000 : 0
  }

  /**
   * Show last run's index straight away, before the first scan has read anything.
   *
   * The stat cache already holds a parsed meta for every file that hasn't changed,
   * so the window can open on the tree it closed on instead of on an empty rail
   * while the scan enumerates, sweeps the providers' archived state and re-annotates.
   * The scan that follows replaces this map wholesale, so seeding only decides how
   * soon the tree appears, never what it ends up saying — a session deleted while
   * Cockpit was shut is listed until that scan lands, which is the same staleness
   * the cache already carries.
   */
  private seedFromCache(): void {
    if (this.sessions.size > 0 || this.fileCache.size === 0) return
    const seeded = new Map<string, SessionMeta>()
    const files = new Map<string, SessionMeta[]>()
    const source = new Map<string, SourceDir>()
    for (const [file, entry] of this.fileCache) {
      if (!entry.meta) continue
      // `resolve` here, not in `isUnder`: a source path comes from config, which a
      // hand edit can leave unnormalized, while `file` is already the indexer's own
      const from = this.sources.find((s) => isUnder(file, resolve(s.path)))
      // a source removed since last run: its cached files are not ours to show
      if (!from) continue
      source.set(file, from)
      seeded.set(entry.meta.id, foldThread(collect(files, entry.meta)))
    }
    if (seeded.size === 0) return
    this.sessions = seeded
    this.fileSource = source
    this.emitUpdate()
  }

  private async refreshProviderArchived(): Promise<void> {
    const next = await this.archivedReader.list(this.sources, this.providerArchived)
    const changed =
      next.size !== this.providerArchived.size ||
      [...next].some((id) => !this.providerArchived.has(id))
    this.providerArchived = next
    if (changed) {
      this.emitUpdate()
      // Persisted with the stat cache (and seeded back in loadCache) so a failed
      // first sweep after launch can't flash provider-archived sessions into the tree.
      this.cacheDirty = true
      this.scheduleSaveCache()
    }
  }

  private scheduleProviderArchivedRefresh(): void {
    if (this.providerArchivedTimer) return
    this.providerArchivedTimer = setTimeout(() => {
      this.providerArchivedTimer = null
      void this.refreshProviderArchived()
    }, 2000)
  }

  setSources(sources: SourceDir[]): Promise<void> {
    // Sources are kept even when their dir doesn't exist yet (a provider installed
    // after launch): scans tolerate missing dirs, and the watch retries below pick
    // the dir up when it appears.
    this.sources = [...sources]
    this.stopWatchers()
    this.seedFromCache()
    const scan = this.rescan()
    // claude's archive flags live in the desktop app's store, outside every source —
    // one recursive watch there picks up archive toggles made in the Claude app.
    // ensureWatch keeps retrying while the store doesn't exist yet (desktop app
    // installed after launch), so toggles go live without waiting for a rescan.
    if (this.claudeStoreDir && this.sources.some((s) => s.provider === 'claude')) {
      this.ensureWatch({
        dir: this.claudeStoreDir,
        recursive: true,
        handler: () => this.scheduleProviderArchivedRefresh()
      })
    }
    for (const s of this.sources) {
      for (const root of ROOT_LISTERS[s.provider](s.path)) {
        this.ensureWatch({
          dir: root,
          recursive: true,
          handler: (event, filename) => this.sessionRootEvent(root, event, filename)
        })
      }
      // Codex thread names live in <CODEX_HOME>/session_index.jsonl, outside the sessions
      // root. Watch the home dir non-recursively and react to just that file — by
      // re-judging this source's rollouts, of which only a renamed one re-parses.
      if (s.provider === 'codex') {
        this.ensureWatch({
          dir: s.path,
          handler: (_event, filename) => {
            if (filename?.toString() === 'session_index.jsonl') this.markSourceDirty(s)
          }
        })
      }
      // copilot's archive flag lives in <home>/data.db, outside the session roots —
      // a shallow watch on the home dir picks up archive toggles made in the app
      if (s.provider === 'copilot') {
        this.ensureWatch({
          dir: s.path,
          handler: (_event, filename) => {
            if (filename && !filename.toString().startsWith('data.db')) return
            this.scheduleProviderArchivedRefresh()
          }
        })
      }
    }
    return scan
  }

  private ensureWatch(spec: WatchSpec): void {
    if (existsSync(spec.dir)) {
      this.tryWatch(spec)
      return
    }
    // Dir doesn't exist yet (e.g. the Claude desktop store before the desktop app is
    // installed) — keep the spec and retry so it gets watched when it appears.
    this.pendingWatches.push(spec)
    this.startWatchRetry()
  }

  private tryWatch(spec: WatchSpec): boolean {
    // node's recursive fs.watch rides FSEvents on macOS — no native-module dependency,
    // no per-directory file descriptors
    try {
      const w = spec.recursive
        ? watch(spec.dir, { recursive: true }, spec.handler)
        : watch(spec.dir, spec.handler)
      w.on('error', (err) => console.error(`[indexer] watcher error for ${spec.dir}:`, err))
      this.watchers.push(w)
      return true
    } catch (err) {
      console.error(`[indexer] cannot watch ${spec.dir}:`, err)
      return false
    }
  }

  private startWatchRetry(): void {
    if (this.watchRetryTimer) return
    this.watchRetryTimer = setInterval(() => {
      const still: WatchSpec[] = []
      let appeared = false
      for (const spec of this.pendingWatches) {
        if (!existsSync(spec.dir)) {
          still.push(spec)
          continue
        }
        if (this.tryWatch(spec)) appeared = true
      }
      this.pendingWatches = still
      if (still.length === 0 && this.watchRetryTimer) {
        clearInterval(this.watchRetryTimer)
        this.watchRetryTimer = null
      }
      // the dir appeared with content we never enumerated — index it now
      if (appeared) this.scheduleRescan()
    }, this.watchRetryMs)
  }

  /**
   * One event from a session root's recursive watch. Subagent transcripts are the one
   * ignored path that still matters: never indexed, but a write there keeps the
   * parent session's observed turn alive (see subagentParent) — no read, no rescan.
   */
  private sessionRootEvent(root: string, event: string, filename: string | Buffer | null): void {
    if (!filename) {
      this.scheduleRescan()
      return
    }
    const full = join(root, filename.toString())
    const parent = subagentParent(full)
    if (parent) {
      this.liveness.heartbeat(parent)
      return
    }
    if (watchIgnored(full)) return
    this.markDirty(event, full)
  }

  /**
   * Watcher events touch exactly one file — re-stat/parse just that file instead of
   * re-enumerating ~2000 sessions. Structural events (adds in unseen dirs, unlinks)
   * fall back to a full rescan.
   */
  private markDirty(event: string, path: string): void {
    // Copilot writes the generated session name to workspace.yaml, not the transcript —
    // treat it as a change to the sibling events.jsonl so the title refreshes.
    if (path.endsWith('/workspace.yaml')) {
      const sibling = join(dirname(path), 'events.jsonl')
      if (this.fileSource.has(sibling)) path = sibling
      else return
      event = 'change'
    }
    // 'rename' on a file already indexed and still there: macOS reports every append to
    // a freshly created file as a rename for its first seconds, and an atomic replace is
    // one too — either way that one file changed, not the structure around it
    if (event === 'rename' && this.fileSource.has(path) && isRegularFile(path)) event = 'change'
    if (event === 'change') {
      // A file already judged not-a-session (codex subagent rollout) streaming appends —
      // ignore until it grows enough to be worth re-judging, or the next full rescan.
      const verdictSize = this.knownNonSessions.get(path)
      if (verdictSize !== undefined) {
        if (!this.outgrewVerdict(path, verdictSize)) return
        this.knownNonSessions.delete(path)
      }
      // 'change' on a known session file → cheap single-file refresh
      if (this.fileSource.has(path)) {
        if (this.rescanTimer) return // a pending full rescan already covers it
        this.dirty.add(path)
        this.scheduleDirtyFlush()
        return
      }
      // 'change' on a session-shaped file we never enumerated: probe just that file
      // instead of re-enumerating everything. Subagent rollouts can't be told apart
      // by path — only the parser's verdict (null) identifies them.
      if (/\.(jsonl|json)$/.test(path)) {
        const source = this.sourceForFile(path)
        if (source) {
          const meta = this.metaFor(path, source)
          if (meta) {
            // a real session born after the last enumeration — index it in place
            this.fileSource.set(path, source)
            this.sessions.set(meta.id, this.foldFiles(meta.id) ?? meta)
            this.emitUpdate()
            this.scheduleSaveCache()
          } else {
            let size = 0
            try {
              size = lstatSync(path).size
            } catch {
              /* vanished mid-probe — record 0 so any later content re-probes */
            }
            this.knownNonSessions.set(path, size)
          }
          return
        }
      }
    }
    // 'rename' (created/deleted) or unknown file → structure changed, re-enumerate.
    // Only session-shaped files matter; other churn was already filtered by watchIgnored.
    if (/\.(jsonl|json)$/.test(path) || event === 'rename') this.scheduleRescan()
  }

  /**
   * Has a not-a-session file grown enough to be worth re-parsing? Doubling (with a
   * small floor) means a rollout that was merely empty when first probed is picked
   * up within a few appends, while a genuine non-session that streams for minutes
   * is only re-parsed O(log n) times instead of on every append.
   */
  private outgrewVerdict(path: string, verdictSize: number): boolean {
    try {
      return lstatSync(path).size >= Math.max(verdictSize * 2, verdictSize + PROBE_REGROW_BYTES)
    } catch {
      return false
    }
  }

  /** The source whose session roots contain this path — watcher events carry no source. */
  private sourceForFile(path: string): SourceDir | null {
    for (const s of this.sources) {
      for (const root of ROOT_LISTERS[s.provider](s.path)) {
        if (isUnder(path, root)) return s
      }
    }
    return null
  }

  /**
   * A throttle, not a debounce: restarted on every write, the timer never fired while
   * several agents wrote at once — their combined rate beats any quiet period — and the
   * index, live status and turn-ended news all froze with it.
   */
  private scheduleDirtyFlush(): void {
    if (this.dirtyTimer) return
    this.dirtyTimer = setTimeout(() => {
      this.dirtyTimer = null
      this.applyDirty()
    }, DIRTY_FLUSH_MS)
  }

  /**
   * Something every file of a source depends on changed (Codex's name index): re-judge
   * them all through the stat cache, which re-parses only the ones it no longer holds.
   */
  private markSourceDirty(source: SourceDir): void {
    if (this.rescanTimer) return // a pending full rescan already covers it
    for (const [file, s] of this.fileSource) {
      if (s.provider === source.provider && s.path === source.path) this.dirty.add(file)
    }
    if (this.dirty.size > 0) this.scheduleDirtyFlush()
  }

  private applyDirty(): void {
    const paths = [...this.dirty]
    this.dirty.clear()
    let changed = false
    for (const file of paths) {
      const source = this.fileSource.get(file)
      if (!source) continue
      const before = this.fileCache.get(file)?.meta ?? null
      const after = this.metaFor(file, source)
      if (before === after) continue
      changed = true
      // re-fold every session this file was or is part of — a thread kept across
      // several files is all of them, never just the one that moved
      for (const id of new Set([before?.id, after?.id])) {
        if (!id) continue
        const folded = this.foldFiles(id)
        if (folded) this.sessions.set(id, folded)
        else this.sessions.delete(id)
      }
    }
    if (changed) {
      this.emitUpdate()
      this.scheduleSaveCache()
    }
  }

  private scheduleRescan(): void {
    // a full rescan supersedes any pending single-file refreshes
    if (this.dirtyTimer) {
      clearTimeout(this.dirtyTimer)
      this.dirtyTimer = null
    }
    this.dirty.clear()
    const now = Date.now()
    if (this.rescanTimer) clearTimeout(this.rescanTimer)
    else this.rescanDeadline = now + RESCAN_MAX_WAIT_MS
    // debounced for the quiet a burst of structural events ends in, up to the deadline
    this.rescanTimer = setTimeout(
      () => {
        this.rescanTimer = null
        void this.rescan()
      },
      Math.max(0, Math.min(RESCAN_QUIET_MS, this.rescanDeadline - now))
    )
  }

  /**
   * Enumerate + stat is cheap; full parse happens only for new/changed files, and the
   * loop yields to the event loop so IPC stays responsive even on a cold first scan.
   */
  async rescan(): Promise<void> {
    if (this.scanning) {
      this.scanQueued = true
      return
    }
    this.scanning = true
    try {
      // watcher-probe verdicts go stale the moment we re-enumerate — re-derive them
      this.knownNonSessions.clear()
      await this.refreshProviderArchived()
      // repo remotes can change between scans — resolution is cheap cached fs reads
      clearRepoCache()
      const next = new Map<string, SessionMeta>()
      const nextFiles = new Map<string, SessionMeta[]>()
      const nextSource = new Map<string, SourceDir>()
      const seenFiles = new Set<string>()
      const pace = timeSlicer(SCAN_SLICE_MS)
      let processed = 0
      for (const s of this.sources) {
        let files: string[]
        try {
          files = FILE_LISTERS[s.provider](s.path)
        } catch (err) {
          console.error(`[indexer] scan failed for ${s.path}:`, err)
          continue
        }
        for (const file of files) {
          seenFiles.add(file)
          nextSource.set(file, s)
          const meta = this.metaFor(file, s)
          if (meta) next.set(meta.id, foldThread(collect(nextFiles, meta)))
          processed++
          await pace()
          if (processed % PUBLISH_EVERY === 0) {
            this.sessions = new Map(next)
            this.emitUpdate()
          }
        }
      }
      for (const file of this.fileCache.keys()) {
        if (!seenFiles.has(file)) this.fileCache.delete(file)
      }
      this.sessions = next
      this.fileSource = nextSource
      this.emitUpdate()
      this.scheduleSaveCache()
    } catch (err) {
      // every caller fires rescan without awaiting — an escaped throw would be an
      // unhandled rejection that silently leaves a half-published index behind
      console.error('[indexer] rescan failed:', err)
    } finally {
      this.scanning = false
      // a failed scan settles it too: the setup card may show, it must never hang
      this.markScanned()
      if (this.scanQueued) {
        this.scanQueued = false
        void this.rescan()
      }
    }
  }

  /** The session `id` is, from every indexed file that says it is part of it. */
  private foldFiles(id: string): SessionMeta | null {
    const metas: SessionMeta[] = []
    for (const [file, e] of this.fileCache) {
      if (e.meta?.id === id && this.fileSource.has(file)) metas.push(e.meta)
    }
    return metas.length > 0 ? foldThread(metas) : null
  }

  private metaFor(file: string, source: SourceDir): SessionMeta | null {
    let st
    try {
      // the file itself, never through a link: the listers only ever name regular files,
      // but the watcher's probe names whatever appeared (see openRegular in parsers/util)
      st = lstatSync(file)
    } catch {
      return null
    }
    if (!st.isFile()) {
      this.fileCache.delete(file)
      return null
    }
    const aux = auxStamp(file, source)
    const cached = this.fileCache.get(file)
    if (
      cached &&
      cached.mtimeMs === st.mtimeMs &&
      cached.size === st.size &&
      (cached.aux ?? 0) === aux &&
      sameThreadName(file, cached)
    ) {
      // the session file is unchanged, but its repo identity may not be (a renamed
      // origin remote) and neither may its branch (the worktree moved) — re-resolve,
      // which is what clearRepoCache() each rescan is for. resolveRepo caches per
      // cwd, so the real cost is one ancestor walk + git-config + HEAD read per
      // distinct cwd per scan, not per session.
      if (cached.meta) this.annotate(cached.meta)
      return cached.meta
    }
    let meta: SessionMeta | null = null
    let naming: Pick<CacheEntry, 'threadId' | 'threadName'> = {}
    try {
      if (source.provider === 'codex') {
        const read = readCodexMeta(file, source.label)
        meta = read.meta
        if (read.threadId) naming = { threadId: read.threadId, threadName: read.threadName }
      } else {
        meta = META_PARSERS[source.provider](file, source.label)
      }
      // inside the try: a throw here escaped as far as the scan, which then failed
      // the same way on every rescan — and out of a watcher callback, uncaught
      if (meta) this.annotate(meta)
    } catch (err) {
      console.error(`[indexer] parse failed for ${file}:`, err)
      meta = null
    }
    this.fileCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, aux, ...naming, meta })
    this.cacheDirty = true
    // a fresh parse means the file changed — the only time its tail can say something new
    if (meta) {
      try {
        this.liveness.observe(file, meta, st.mtimeMs)
      } catch (err) {
        console.error(`[indexer] live status failed for ${file}:`, err)
      }
    }
    return meta
  }

  /**
   * Everything about a session that comes from the checkout rather than the log:
   * GitHub-first grouping (owner/repo is the identity when known, local root the
   * fallback) and the branch.
   */
  private annotate(meta: SessionMeta): void {
    const res = resolveRepo(meta.cwd)
    const fullName = meta.repoFullName ?? res?.repo.fullName ?? null
    if (fullName) {
      meta.repo = {
        key: `gh:${fullName.toLowerCase()}`,
        name: fullName.split('/')[1] ?? fullName,
        fullName,
        root: res?.repo.root ?? null
      }
    } else {
      meta.repo = res?.repo ?? null
    }
    meta.isWorktree = res?.isWorktree ?? false
    // The provider's log is the first authority, but two of the three don't record a
    // branch any more (see SessionMeta.logBranch), so read the checkout's own HEAD
    // when it doesn't. Derived from logBranch every time, never from the last value
    // this wrote — otherwise a branch caught mid-rebase would freeze onto the session.
    // A cwd that's gone (deleted worktree) keeps whatever the log remembered.
    meta.gitBranch = meta.logBranch ?? branchForCwd(meta.cwd)
  }

  private emitUpdate(): void {
    // every change to what listRepos() is derived from announces itself here
    this.repoRoots = null
    if (this.updateTimer) return
    this.updateTimer = setTimeout(() => {
      this.updateTimer = null
      this.onUpdate()
    }, UPDATE_THROTTLE_MS)
  }

  /** Per-source health for Settings. Takes the config's source list (the config is
   *  authoritative); a source whose directory is gone still shows, flagged missing,
   *  so the user can see and remove the dead entry. */
  sourceStats(sources: SourceDir[]): SourceStats[] {
    const by = new Map<string, { count: number; last: number | null }>()
    for (const s of this.sessions.values()) {
      if (this.providerArchived.has(s.id)) continue
      const key = `${s.provider}:${s.source}`
      const e = by.get(key) ?? { count: 0, last: null }
      e.count++
      if (e.last === null || s.updatedAt > e.last) e.last = s.updatedAt
      by.set(key, e)
    }
    return sources.map((src) => {
      const e = by.get(`${src.provider}:${src.label}`)
      return {
        ...src,
        count: e?.count ?? 0,
        lastUpdatedAt: e?.last ?? null,
        missing: !existsSync(src.path)
      }
    })
  }

  listRepos(): RepoGroup[] {
    const cutoff = this.historyCutoff()
    // per-repo aggregation accumulators, mutated while summing — hence Mutable
    const groups = new Map<string, Mutable<RepoGroup>>()
    for (const s of this.sessions.values()) {
      if (this.providerArchived.has(s.id)) continue
      if (s.updatedAt < cutoff) continue
      // roundtable seat-sessions never count as a group's work — they page (and are
      // counted) only under their table
      if (s.cwd !== null && this.roundtableForCwd(s.cwd) !== null) continue
      const info = s.repo ?? GENERAL_REPO
      let g = groups.get(info.key)
      if (!g) {
        g = {
          ...info,
          sessionCount: 0,
          archivedCount: 0,
          lastActivity: 0,
          providers: [],
          hidden: this.hiddenRepos.has(info.key)
        }
        groups.set(info.key, g)
      }
      if (this.archived.has(s.id)) g.archivedCount++
      else {
        g.sessionCount++
        if (s.updatedAt > g.lastActivity) g.lastActivity = s.updatedAt
      }
      if (!g.providers.includes(s.provider)) g.providers.push(s.provider)
      // Prefer a visible checkout (e.g. ~/dev/foo) over a provider-internal clone (~/.copilot/repos/foo)
      if (info.root && (!g.root || (isHiddenPath(g.root) && !isHiddenPath(info.root)))) {
        g.root = info.root
      }
    }
    // projects hold still: A→Z or the user's own order, never by activity
    return orderRepos([...groups.values()], this.repoOrder)
  }

  /**
   * Roots the app may spawn git/gh in — IPC handlers validate against this. Asked on
   * every PR badge and repo operation, so it is kept until the index next changes
   * rather than rebuilt from a full listRepos() each time (a session ageing out of the
   * history window takes its root with it at the next change, not the minute it does).
   */
  knownRepoRoots(): ReadonlySet<string> {
    if (!this.repoRoots) {
      const roots = new Set<string>()
      for (const g of this.listRepos()) if (g.root) roots.add(g.root)
      this.repoRoots = roots
    }
    return this.repoRoots
  }

  /**
   * Working directories the app has seen a session run in — chat:send validates
   * against this. Archived sessions are included on purpose: the sidebar can
   * still open them, and resuming one must not be refused as an unknown path.
   */
  knownSessionCwds(): Set<string> {
    const cwds = new Set<string>()
    for (const s of this.sessions.values()) if (s.cwd) cwds.add(resolve(s.cwd))
    return cwds
  }

  /** Wired by index.ts to the roundtable manager: cwd → owning table id, if any. */
  private roundtableForCwd: (cwd: string) => string | null = () => null

  setRoundtableResolver(fn: (cwd: string) => string | null): void {
    this.roundtableForCwd = fn
    this.repoRoots = null
  }

  /**
   * What a transcript search may read: the sessions a plain (non-archived) page over
   * the same scope would list, newest first, so a capped search keeps the most recent
   * matches. The `sourcePath`s inside are the trust boundary — transcript-search.ts
   * never takes a path from the renderer, only from here. Mirrors page()'s
   * visibility rules: provider-archived, archived, roundtable seats and sessions past
   * the history window stay out; hidden repos are skipped only on unscoped queries.
   */
  transcriptCandidates(scope: {
    readonly repoKey?: string
    readonly providers?: readonly Provider[]
  }): SessionMeta[] {
    const cutoff = this.historyCutoff()
    const providers = scope.providers?.length ? new Set<Provider>(scope.providers) : null
    const out: SessionMeta[] = []
    for (const s of this.sessions.values()) {
      if (this.providerArchived.has(s.id) || this.archived.has(s.id)) continue
      if (s.updatedAt < cutoff) continue
      if (s.cwd !== null && this.roundtableForCwd(s.cwd) !== null) continue
      const key = s.repo?.key ?? 'general'
      if (scope.repoKey ? key !== scope.repoKey : this.hiddenRepos.has(key)) continue
      if (providers && !providers.has(s.provider)) continue
      out.push(s)
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  page(query: SessionQuery): SessionPage {
    const cutoff = this.historyCutoff()
    let all = [...this.sessions.values()]
    all = all.filter((s) => !this.providerArchived.has(s.id) && s.updatedAt >= cutoff)
    all = all.filter((s) => this.archived.has(s.id) === !!query.archived)
    // roundtable seat-sessions are not independent work: they page only under their
    // own table (query.roundtableId) and stay out of the tree/board/search entirely
    if (query.roundtableId) {
      const id = query.roundtableId
      all = all.filter((s) => s.cwd !== null && this.roundtableForCwd(s.cwd) === id)
    } else {
      all = all.filter((s) => s.cwd === null || this.roundtableForCwd(s.cwd) === null)
    }
    if (query.repoKey) {
      all = all.filter((s) => (s.repo?.key ?? 'general') === query.repoKey)
    } else {
      // global queries (search) skip repos the user chose not to display
      all = all.filter((s) => !this.hiddenRepos.has(s.repo?.key ?? 'general'))
    }
    if (query.providers?.length) {
      const set = new Set<Provider>(query.providers)
      all = all.filter((s) => set.has(s.provider))
    }
    if (query.search) {
      const q = query.search.toLowerCase()
      all = all.filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          (s.gitBranch ?? '').toLowerCase().includes(q) ||
          (s.cwd ?? '').toLowerCase().includes(q) ||
          s.nativeId.toLowerCase().includes(q)
      )
    }
    all.sort((a, b) => b.updatedAt - a.updatedAt)
    all = this.groupChains(groupFamilies(all))
    const offset = Math.max(0, query.offset ?? 0)
    const limit = Math.max(1, Math.min(1000, query.limit ?? DEFAULT_PAGE_SIZE))
    return {
      total: all.length,
      items: all.slice(offset, offset + limit).map((s) => ({
        ...s,
        archived: this.archived.has(s.id),
        continuedFrom: this.lineage.get(s.id),
        // stamped so the renderer knows to open these read-only
        ...(query.roundtableId ? { roundtableId: query.roundtableId } : {})
      }))
    }
  }

  /**
   * Handoff chains render as one thread: members are pulled together under the
   * chain's newest session, which keeps the sorted position it already had.
   * Must happen here — the renderer only ever sees pages, never the full list.
   * Lineage edges only count when both ends survived the query's filters.
   */
  private groupChains(sorted: SessionMeta[]): SessionMeta[] {
    if (this.lineage.size === 0) return sorted
    const present = new Set(sorted.map((s) => s.id))
    // config is hand-editable: cap the walk and track visits so a cycle can't hang
    const rootOf = (id: string): string => {
      let cur = id
      const seen = new Set([cur])
      for (let i = 0; i < 32; i++) {
        const parent = this.lineage.get(cur)
        if (!parent || !present.has(parent) || seen.has(parent)) return cur
        seen.add(parent)
        cur = parent
      }
      return cur
    }
    const roots = new Map<string, string>()
    for (const s of sorted) roots.set(s.id, rootOf(s.id))
    const groups = new Map<string, SessionMeta[]>()
    let chained = false
    for (const s of sorted) {
      const root = roots.get(s.id) as string
      const g = groups.get(root)
      if (g) {
        g.push(s)
        chained = true
      } else groups.set(root, [s])
    }
    if (!chained) return sorted
    // walking in recency order and emitting each group at its first (= newest)
    // member keeps chains sorted by head recency, ancestors directly underneath
    const out: SessionMeta[] = []
    const emitted = new Set<string>()
    for (const s of sorted) {
      const root = roots.get(s.id) as string
      if (emitted.has(root)) continue
      emitted.add(root)
      out.push(...(groups.get(root) as SessionMeta[]))
    }
    return out
  }

  /**
   * Every session the user still owns, for aggregate stats (see profile.ts).
   * Deliberately ignores `historyDays` and `hiddenRepos` — those are display
   * filters for the tree, while a profile is the long view over all history.
   * Provider-archived and user-archived sessions stay excluded: those were
   * explicitly thrown away.
   */
  allSessions(): SessionMeta[] {
    const out: SessionMeta[] = []
    for (const s of this.sessions.values()) {
      if (this.providerArchived.has(s.id) || this.archived.has(s.id)) continue
      out.push(s)
    }
    return out
  }

  /**
   * Cleanup candidates: everything still on disk that Cockpit owns. Archived
   * sessions are included on purpose — archiving is cleanup's reversible first
   * tier, so deleting the files is the tier that has to be able to see them.
   * Roundtable seats stay out: they belong to their table, not to the user's own
   * work, and removing one would strand the table's transcript.
   */
  /**
   * Seat sessions — the ones cleanupSessions leaves out — stamped with their table.
   * Deleting a roundtable takes these with it; nothing else may.
   */
  roundtableSessions(): SessionMeta[] {
    const out: SessionMeta[] = []
    for (const s of this.sessions.values()) {
      if (this.providerArchived.has(s.id)) continue
      const roundtableId = s.cwd === null ? null : this.roundtableForCwd(s.cwd)
      if (roundtableId === null) continue
      out.push({ ...s, roundtableId })
    }
    return out
  }

  cleanupSessions(): SessionMeta[] {
    const out: SessionMeta[] = []
    for (const s of this.sessions.values()) {
      if (this.providerArchived.has(s.id)) continue
      if (s.cwd !== null && this.roundtableForCwd(s.cwd) !== null) continue
      out.push({ ...s, archived: this.archived.has(s.id) })
    }
    return out
  }

  /** One session by id, stamped like a page row; null when unknown. */
  getSession(id: string): SessionMeta | null {
    const s = this.sessions.get(id)
    if (!s) return null
    // a seat-session must read as one however it was reached (lineage chip, palette),
    // not only when paged under its table — the renderer keys read-only off this
    const roundtableId = s.cwd === null ? null : this.roundtableForCwd(s.cwd)
    return {
      ...s,
      archived: this.archived.has(s.id),
      continuedFrom: this.lineage.get(s.id),
      ...(roundtableId ? { roundtableId } : {})
    }
  }

  getMessages(id: string): SessionMessage[] {
    const meta = this.sessions.get(id)
    if (!meta) return []
    try {
      return meta.provider === 'codex'
        ? parseCodexMessages(meta.sourcePath, meta.segments)
        : MESSAGE_PARSERS[meta.provider](meta.sourcePath)
    } catch (err) {
      console.error(`[indexer] message parse failed for ${id}:`, err)
      return []
    }
  }

  /**
   * Disk-persisted stat cache: app restarts only re-parse files that changed.
   * Everything `annotate` derives from the checkout is stripped on save and
   * recomputed on load — a renamed git remote, or a worktree that has since moved
   * to another branch, must not be frozen into the cache.
   */
  private loadCache(): void {
    if (!this.cacheFile) return
    sweepCacheTmps(this.cacheFile)
    try {
      const raw = JSON.parse(readFileSync(this.cacheFile, 'utf8'))
      if (raw?.v !== CACHE_VERSION || !Array.isArray(raw.entries)) return
      for (const [path, entry] of raw.entries) {
        if (typeof path === 'string' && entry && typeof entry.mtimeMs === 'number') {
          if (entry.meta) this.annotate(entry.meta)
          this.fileCache.set(path, entry)
        }
      }
      // Last-known provider-archived ids: refreshProviderArchived keeps these when a
      // sweep fails, so a locked copilot db at launch can't unhide archived sessions.
      if (Array.isArray(raw.providerArchived)) {
        this.providerArchived = new Set(
          raw.providerArchived.filter((id: unknown): id is string => typeof id === 'string')
        )
      }
    } catch {
      /* no cache yet */
    }
  }

  private scheduleSaveCache(): void {
    if (!this.cacheFile || this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.saveCacheAsync()
    }, CACHE_SAVE_INTERVAL_MS)
  }

  private serializeCache(): string {
    const entries = [...this.fileCache.entries()].map(([path, e]) => [
      path,
      e.meta
        ? {
            ...e,
            meta: {
              ...e.meta,
              repo: undefined,
              isWorktree: undefined,
              gitBranch: undefined,
              archived: undefined,
              continuedFrom: undefined
            }
          }
        : e
    ])
    return JSON.stringify({
      v: CACHE_VERSION,
      entries,
      providerArchived: [...this.providerArchived]
    })
  }

  private saveCacheAsync(): Promise<void> {
    // Chain onto any in-flight save so write/rename pairs never interleave.
    this.savingCache = this.savingCache.then(() => this.writeCacheFile())
    return this.savingCache
  }

  private async writeCacheFile(): Promise<void> {
    if (!this.cacheFile || !this.cacheDirty) return
    this.cacheDirty = false
    const tmp = nextCacheTmp(this.cacheFile)
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true })
      await writeFile(tmp, this.serializeCache())
      await rename(tmp, this.cacheFile)
    } catch (err) {
      console.error('[indexer] cache save failed:', err)
      await rm(tmp, { force: true }).catch(() => {})
    }
  }

  /** Synchronous flush for app quit. */
  saveCache(): void {
    if (!this.cacheFile) return
    const tmp = nextCacheTmp(this.cacheFile)
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true })
      writeFileSync(tmp, this.serializeCache())
      renameSync(tmp, this.cacheFile)
    } catch (err) {
      console.error('[indexer] cache save failed:', err)
      try {
        rmSync(tmp, { force: true })
      } catch {
        /* best-effort cleanup */
      }
    }
  }

  stopWatchers(): void {
    for (const w of this.watchers) void w.close()
    this.watchers = []
    this.pendingWatches = []
    // no watcher, no writes: what the tracker holds would only ever go stale
    this.liveness.stop()
    if (this.watchRetryTimer) {
      clearInterval(this.watchRetryTimer)
      this.watchRetryTimer = null
    }
    if (this.dirtyTimer) {
      clearTimeout(this.dirtyTimer)
      this.dirtyTimer = null
    }
    if (this.rescanTimer) {
      clearTimeout(this.rescanTimer)
      this.rescanTimer = null
    }
    this.dirty.clear()
    if (this.providerArchivedTimer) {
      clearTimeout(this.providerArchivedTimer)
      this.providerArchivedTimer = null
    }
  }
}

/**
 * Sessions another session started (`SessionMeta.parentId`) render under it: a family
 * is pulled together where its most recently active member already sorted, the parent
 * first and each child followed by its own children, siblings by recency. Done here
 * for the same reason as chains — the renderer only ever sees pages. Parent edges
 * only count when both ends survived the query's filters; a child whose parent did
 * not stays where recency put it.
 */
export function groupFamilies(sorted: SessionMeta[]): SessionMeta[] {
  const present = new Map(sorted.map((s) => [s.id, s]))
  const children = new Map<string, SessionMeta[]>()
  for (const s of sorted) {
    if (!s.parentId || s.parentId === s.id || !present.has(s.parentId)) continue
    const siblings = children.get(s.parentId)
    if (siblings) siblings.push(s)
    else children.set(s.parentId, [s])
  }
  if (children.size === 0) return sorted
  // the edges come from logs: cap the walk and track visits so a cycle can't hang
  const rootOf = (s: SessionMeta): SessionMeta => {
    let cur = s
    const seen = new Set([cur.id])
    for (let i = 0; i < 32; i++) {
      const parent = cur.parentId ? present.get(cur.parentId) : undefined
      if (!parent || seen.has(parent.id)) return cur
      seen.add(parent.id)
      cur = parent
    }
    return cur
  }
  const out: SessionMeta[] = []
  const emitted = new Set<string>()
  const emit = (s: SessionMeta): void => {
    if (emitted.has(s.id)) return
    emitted.add(s.id)
    out.push(s)
    for (const child of children.get(s.id) ?? []) emit(child)
  }
  for (const s of sorted) emit(rootOf(s))
  return out
}

function isHiddenPath(p: string): boolean {
  return /\/\./.test(p)
}
