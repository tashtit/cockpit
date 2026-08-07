import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync, renameSync, watch, type FSWatcher } from 'node:fs'
import { writeFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  Provider,
  RepoGroup,
  SessionMeta,
  SessionMessage,
  SessionPage,
  SessionQuery,
  SourceDir
} from '../shared/types'
import { GENERAL_REPO, clearRepoCache, resolveRepo } from './repos'
import {
  listClaudeSessionFiles,
  listClaudeSessionRoots,
  parseClaudeMeta,
  parseClaudeMessages
} from './parsers/claude'
import {
  listCodexSessionFiles,
  listCodexSessionRoots,
  parseCodexMeta,
  parseCodexMessages
} from './parsers/codex'
import {
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
const CACHE_VERSION = 3
/** Yield to the event loop every N files so scans never starve IPC. */
const YIELD_EVERY = 50
/** Publish partial results during a cold scan so the tree fills in progressively. */
const PUBLISH_EVERY = 300
/** Broadcasts and cache writes are throttled — an active chat appends every second. */
const UPDATE_THROTTLE_MS = 800
const CACHE_SAVE_INTERVAL_MS = 30_000

interface CacheEntry {
  mtimeMs: number
  size: number
  meta: SessionMeta | null
}

/**
 * Provider dirs contain far more than sessions (binaries, clones, DBs) — never watch those.
 * Blacklist by extension/dir-name (not whitelist) so directories with dots in their names
 * (e.g. sanitized cwd paths like "-Users-x-dev-app.web") aren't silently unwatched.
 */
function watchIgnored(p: string): boolean {
  if (/\/(checkpoints|files|research|logs)(\/|$)/.test(p)) return true
  return /\.(db|db-wal|db-shm|sqlite|log|md|txt|png|jpe?g|gif|svg|zip|gz|tar|lock)$/i.test(p)
}

export class SessionIndexer {
  private sessions = new Map<string, SessionMeta>()
  /** file path → parse result keyed on (mtime,size); only changed files get re-read */
  private fileCache = new Map<string, CacheEntry>()
  private fileSource = new Map<string, SourceDir>()
  private watchers: FSWatcher[] = []
  private dirty = new Set<string>()
  private dirtyTimer: NodeJS.Timeout | null = null
  private updateTimer: NodeJS.Timeout | null = null
  private saveTimer: NodeJS.Timeout | null = null
  private cacheDirty = false
  private scanning = false
  private scanQueued = false
  private sources: SourceDir[] = []
  private archived = new Set<string>()
  private onUpdate: () => void
  private cacheFile: string | null

  constructor(onUpdate: () => void, opts?: { cacheFile?: string }) {
    this.onUpdate = onUpdate
    this.cacheFile = opts?.cacheFile ?? null
    this.loadCache()
  }

  /** Applied at query time so toggling archive never re-parses anything. */
  setArchived(ids: string[]): void {
    this.archived = new Set(ids)
    this.emitUpdate()
  }

  setSources(sources: SourceDir[]): Promise<void> {
    this.sources = sources.filter((s) => existsSync(s.path))
    this.stopWatchers()
    const scan = this.rescan()
    for (const s of this.sources) {
      for (const root of ROOT_LISTERS[s.provider](s.path)) {
        if (!existsSync(root)) continue
        // node's recursive fs.watch rides FSEvents on macOS — no native-module dependency,
        // no per-directory file descriptors
        try {
          const w = watch(root, { recursive: true }, (event, filename) => {
            if (!filename) return this.scheduleRescan()
            const full = join(root, filename.toString())
            if (watchIgnored(full)) return
            this.markDirty(event, full)
          })
          w.on('error', (err) => console.error(`[indexer] watcher error for ${root}:`, err))
          this.watchers.push(w)
        } catch (err) {
          console.error(`[indexer] cannot watch ${root}:`, err)
        }
      }
    }
    return scan
  }

  /**
   * Watcher events touch exactly one file — re-stat/parse just that file instead of
   * re-enumerating ~2000 sessions. Structural events (adds in unseen dirs, unlinks)
   * fall back to a full rescan.
   */
  private markDirty(event: string, path: string): void {
    // 'change' on a known session file → cheap single-file refresh
    if (event === 'change' && this.fileSource.has(path)) {
      this.dirty.add(path)
      if (this.dirtyTimer) clearTimeout(this.dirtyTimer)
      this.dirtyTimer = setTimeout(() => this.applyDirty(), 500)
      return
    }
    // 'rename' (created/deleted) or unknown file → structure changed, re-enumerate.
    // Only session-shaped files matter; other churn was already filtered by watchIgnored.
    if (/\.(jsonl|json)$/.test(path) || event === 'rename') this.scheduleRescan()
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
    if (this.dirtyTimer) clearTimeout(this.dirtyTimer)
    this.dirty.clear()
    this.dirtyTimer = setTimeout(() => void this.rescan(), 750)
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
    const cached = this.fileCache.get(file)
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.meta
    let meta: SessionMeta | null = null
    try {
      meta = META_PARSERS[source.provider](file, source.label)
    } catch (err) {
      console.error(`[indexer] parse failed for ${file}:`, err)
    }
    if (meta) this.annotateRepo(meta)
    this.fileCache.set(file, { mtimeMs: st.mtimeMs, size: st.size, meta })
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

  listRepos(): RepoGroup[] {
    const groups = new Map<string, RepoGroup>()
    for (const s of this.sessions.values()) {
      const info = s.repo ?? GENERAL_REPO
      let g = groups.get(info.key)
      if (!g) {
        g = { ...info, sessionCount: 0, archivedCount: 0, lastActivity: 0, providers: [] }
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

  page(query: SessionQuery): SessionPage {
    let all = [...this.sessions.values()]
    all = all.filter((s) => this.archived.has(s.id) === !!query.archived)
    if (query.repoKey) {
      all = all.filter((s) => (s.repo?.key ?? 'general') === query.repoKey)
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
    const offset = Math.max(0, query.offset ?? 0)
    const limit = Math.max(1, Math.min(1000, query.limit ?? DEFAULT_PAGE_SIZE))
    return {
      total: all.length,
      items: all
        .slice(offset, offset + limit)
        .map((s) => ({ ...s, archived: this.archived.has(s.id) }))
    }
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
        ? { ...e, meta: { ...e.meta, repo: undefined, isWorktree: undefined, archived: undefined } }
        : e
    ])
    return JSON.stringify({ v: CACHE_VERSION, entries })
  }

  private async saveCacheAsync(): Promise<void> {
    if (!this.cacheFile || !this.cacheDirty) return
    this.cacheDirty = false
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true })
      const tmp = `${this.cacheFile}.tmp`
      await writeFile(tmp, this.serializeCache())
      await rename(tmp, this.cacheFile)
    } catch (err) {
      console.error('[indexer] cache save failed:', err)
    }
  }

  /** Synchronous flush for app quit. */
  saveCache(): void {
    if (!this.cacheFile) return
    try {
      mkdirSync(dirname(this.cacheFile), { recursive: true })
      const tmp = `${this.cacheFile}.tmp`
      writeFileSync(tmp, this.serializeCache())
      renameSync(tmp, this.cacheFile)
    } catch (err) {
      console.error('[indexer] cache save failed:', err)
    }
  }

  stopWatchers(): void {
    for (const w of this.watchers) void w.close()
    this.watchers = []
  }
}

function isHiddenPath(p: string): boolean {
  return /\/\./.test(p)
}
