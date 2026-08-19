import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync, renameSync, rmSync, watch, type FSWatcher } from 'node:fs'
import { writeFile, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import type {
  Mutable,
  Provider,
  RepoGroup,
  SessionMeta,
  SessionMessage,
  SessionPage,
  SessionQuery,
  SourceDir,
  SourceStats
} from '../shared/types'
import { GENERAL_REPO, clearRepoCache, resolveRepo } from './repos'
import { defaultClaudeStoreDir, listProviderArchivedIds } from './provider-archived'
import {
  listClaudeSessionFiles,
  listClaudeSessionRoots,
  parseClaudeMeta,
  parseClaudeMessages
} from './parsers/claude'
import {
  codexIndexFile,
  listCodexSessionFiles,
  listCodexSessionRoots,
  parseCodexMeta,
  parseCodexMessages
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
const CACHE_VERSION = 5
/** Yield to the event loop every N files so scans never starve IPC. */
const YIELD_EVERY = 50
/** Publish partial results during a cold scan so the tree fills in progressively. */
const PUBLISH_EVERY = 300
/** Broadcasts and cache writes are throttled — an active chat appends every second. */
const UPDATE_THROTTLE_MS = 800
const CACHE_SAVE_INTERVAL_MS = 30_000
/** How often to re-check watch roots that didn't exist when sources were set. */
const WATCH_RETRY_INTERVAL_MS = 30_000
/** Floor for re-judging a not-a-session verdict (see knownNonSessions). */
const PROBE_REGROW_BYTES = 4096

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

type CacheEntry = {
  readonly mtimeMs: number
  readonly size: number
  /** mtime of the out-of-band name source (codex session_index / copilot workspace.yaml) */
  readonly aux?: number
  readonly meta: SessionMeta | null
}

/**
 * Codex and Copilot store generated session names outside the transcript file, so a
 * rename doesn't touch the transcript's (mtime,size). Stamp the side file's mtime into
 * the cache entry so name changes invalidate it.
 */
function auxStamp(file: string, source: SourceDir): number {
  let p: string | null = null
  if (source.provider === 'codex') p = codexIndexFile(source.path)
  else if (source.provider === 'copilot' && file.endsWith('events.jsonl'))
    p = copilotWorkspaceFile(file)
  if (!p) return 0
  try {
    return statSync(p).mtimeMs
  } catch {
    return 0
  }
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
  /** Days of history to display — sessions idle longer are hidden; 0 = all */
  private historyDays = 0
  private onUpdate: () => void
  private cacheFile: string | null
  /** undefined → the real desktop-app store; null → disabled (tests) */
  private claudeStoreDir: string | null

  constructor(
    onUpdate: () => void,
    opts?: { cacheFile?: string; watchRetryMs?: number; claudeStoreDir?: string | null }
  ) {
    this.onUpdate = onUpdate
    this.cacheFile = opts?.cacheFile ?? null
    this.watchRetryMs = opts?.watchRetryMs ?? WATCH_RETRY_INTERVAL_MS
    this.claudeStoreDir = opts?.claudeStoreDir === undefined ? defaultClaudeStoreDir() : opts.claudeStoreDir
    this.loadCache()
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

  /** Applied at query time so changing the window never re-parses anything. */
  setHistoryDays(days: number): void {
    this.historyDays = days > 0 ? days : 0
    this.emitUpdate()
  }

  /** Epoch ms floor for displayed sessions; 0 = no floor (all history). */
  private historyCutoff(): number {
    return this.historyDays > 0 ? Date.now() - this.historyDays * 86_400_000 : 0
  }

  private async refreshProviderArchived(): Promise<void> {
    const next = await listProviderArchivedIds(this.sources, this.providerArchived, {
      claudeStoreDir: this.claudeStoreDir
    })
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
          handler: (event, filename) => {
            if (!filename) return this.scheduleRescan()
            const full = join(root, filename.toString())
            if (watchIgnored(full)) return
            this.markDirty(event, full)
          }
        })
      }
      // Codex thread names live in <CODEX_HOME>/session_index.jsonl, outside the sessions
      // root. Watch the home dir non-recursively and react to just that file.
      if (s.provider === 'codex') {
        this.ensureWatch({
          dir: s.path,
          handler: (_event, filename) => {
            if (filename?.toString() === 'session_index.jsonl') this.scheduleRescan()
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
        if (this.dirtyTimer) clearTimeout(this.dirtyTimer)
        this.dirtyTimer = setTimeout(() => {
          this.dirtyTimer = null
          this.applyDirty()
        }, 500)
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
            const existing = this.sessions.get(meta.id)
            if (!existing || meta.updatedAt >= existing.updatedAt) this.sessions.set(meta.id, meta)
            this.emitUpdate()
            this.scheduleSaveCache()
          } else {
            let size = 0
            try {
              size = statSync(path).size
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
      return statSync(path).size >= Math.max(verdictSize * 2, verdictSize + PROBE_REGROW_BYTES)
    } catch {
      return false
    }
  }

  /** The source whose session roots contain this path — watcher events carry no source. */
  private sourceForFile(path: string): SourceDir | null {
    for (const s of this.sources) {
      for (const root of ROOT_LISTERS[s.provider](s.path)) {
        if (path.startsWith(root + sep)) return s
      }
    }
    return null
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
      if (before && before.id !== after?.id) this.sessions.delete(before.id)
      if (after) this.sessions.set(after.id, after)
      else if (before) this.sessions.delete(before.id)
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
    if (this.rescanTimer) clearTimeout(this.rescanTimer)
    this.rescanTimer = setTimeout(() => {
      this.rescanTimer = null
      void this.rescan()
    }, 750)
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
      const nextSource = new Map<string, SourceDir>()
      const seenFiles = new Set<string>()
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
          if (meta) {
            const existing = next.get(meta.id)
            // same session id in two sources: keep the most recently updated copy
            if (!existing || meta.updatedAt >= existing.updatedAt) next.set(meta.id, meta)
          }
          processed++
          if (processed % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r))
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
      if (this.scanQueued) {
        this.scanQueued = false
        void this.rescan()
      }
    }
  }

  private metaFor(file: string, source: SourceDir): SessionMeta | null {
    let st
    try {
      st = statSync(file)
    } catch {
      return null
    }
    const aux = auxStamp(file, source)
    const cached = this.fileCache.get(file)
    if (
      cached &&
      cached.mtimeMs === st.mtimeMs &&
      cached.size === st.size &&
      (cached.aux ?? 0) === aux
    ) {
      // the session file is unchanged, but its repo identity may not be (a renamed
      // origin remote) — re-resolve, which is what clearRepoCache() each rescan is
      // for. resolveRepo caches per cwd, so the real cost is one ancestor walk +
      // git-config read per distinct cwd per scan, not per session.
      if (cached.meta) this.annotateRepo(cached.meta)
      return cached.meta
    }
    let meta: SessionMeta | null = null
    try {
      meta = META_PARSERS[source.provider](file, source.label)
    } catch (err) {
      console.error(`[indexer] parse failed for ${file}:`, err)
    }
    if (meta) this.annotateRepo(meta)
    this.fileCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, aux, meta })
    this.cacheDirty = true
    return meta
  }

  /** GitHub-first grouping: owner/repo is the identity when known; local root is the fallback. */
  private annotateRepo(meta: SessionMeta): void {
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
  }

  private emitUpdate(): void {
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
    return [...groups.values()].sort((a, b) => {
      if ((a.key === 'general') !== (b.key === 'general')) return a.key === 'general' ? 1 : -1
      return b.lastActivity - a.lastActivity
    })
  }

  /** Roots the app may spawn git/gh in — IPC handlers validate against this. */
  knownRepoRoots(): Set<string> {
    const roots = new Set<string>()
    for (const g of this.listRepos()) if (g.root) roots.add(g.root)
    return roots
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

  page(query: SessionQuery): SessionPage {
    const cutoff = this.historyCutoff()
    let all = [...this.sessions.values()]
    all = all.filter((s) => !this.providerArchived.has(s.id) && s.updatedAt >= cutoff)
    all = all.filter((s) => this.archived.has(s.id) === !!query.archived)
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
    all = this.groupChains(all)
    const offset = Math.max(0, query.offset ?? 0)
    const limit = Math.max(1, Math.min(1000, query.limit ?? DEFAULT_PAGE_SIZE))
    return {
      total: all.length,
      items: all.slice(offset, offset + limit).map((s) => ({
        ...s,
        archived: this.archived.has(s.id),
        continuedFrom: this.lineage.get(s.id)
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

  /** One session by id, stamped like a page row; null when unknown. */
  getSession(id: string): SessionMeta | null {
    const s = this.sessions.get(id)
    if (!s) return null
    return { ...s, archived: this.archived.has(s.id), continuedFrom: this.lineage.get(s.id) }
  }

  getMessages(id: string): SessionMessage[] {
    const meta = this.sessions.get(id)
    if (!meta) return []
    try {
      return MESSAGE_PARSERS[meta.provider](meta.sourcePath)
    } catch (err) {
      console.error(`[indexer] message parse failed for ${id}:`, err)
      return []
    }
  }

  /**
   * Disk-persisted stat cache: app restarts only re-parse files that changed.
   * Repo annotation is stripped on save and recomputed on load — a renamed git
   * remote must not be frozen into the cache.
   */
  private loadCache(): void {
    if (!this.cacheFile) return
    try {
      const raw = JSON.parse(readFileSync(this.cacheFile, 'utf8'))
      if (raw?.v !== CACHE_VERSION || !Array.isArray(raw.entries)) return
      for (const [path, entry] of raw.entries) {
        if (typeof path === 'string' && entry && typeof entry.mtimeMs === 'number') {
          if (entry.meta) this.annotateRepo(entry.meta)
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

function isHiddenPath(p: string): boolean {
  return /\/\./.test(p)
}
