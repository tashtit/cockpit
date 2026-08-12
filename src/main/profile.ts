import { statSync } from 'node:fs'
import { extname } from 'node:path'
import type {
  ActivityDay,
  LanguageStat,
  Mutable,
  NameCount,
  ProfileStats,
  Provider,
  ProviderProfile,
  RepoStat,
  SessionMeta
} from '../shared/types'
import { ghUser } from './accounts'
import { readHead } from './parsers/util'

/**
 * The cross-agent work profile: an activity heatmap plus per-agent totals, built
 * entirely from session logs already on disk. Nothing is fetched, and only the
 * aggregate crosses the IPC bridge — never the sessions behind it.
 *
 * Two passes with very different costs:
 *   cheap — heatmap, streaks, repo and per-agent session counts, straight off the
 *           index (no file IO at all)
 *   deep  — lines edited, languages, tool mix and models, which require reading
 *           each transcript; cached on (mtime,size) so a rescan re-reads only
 *           what changed, mirroring usage.ts and the indexer's own stat cache
 *
 * The deep pass is bounded per file (DEEP_READ_BYTES) and failure-tolerant by
 * design: provider log formats are internal and drift between releases, so an
 * unreadable or reshaped transcript is skipped rather than failing the profile.
 */

/** Deep pass reads at most this much of any one transcript. */
const DEEP_READ_BYTES = 2 * 1024 * 1024

const DAY_MS = 86_400_000

/** Deep pass hands the event loop back this often, so IPC never stalls behind it. */
const YIELD_EVERY = 20

/** Tallying counterparts of the readonly wire types (see buildProfile). */
type MutableDay = Mutable<ActivityDay>
type MutableRepoStat = Mutable<RepoStat>

/** Extensions that are code we want to attribute; everything else is ignored. */
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'kts',
  'swift', 'm', 'mm', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'scala', 'clj', 'ex',
  'exs', 'erl', 'hs', 'lua', 'pl', 'r', 'dart', 'sh', 'bash', 'zsh', 'fish', 'sql',
  'html', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'astro', 'json', 'yaml',
  'yml', 'toml', 'xml', 'md', 'mdx', 'proto', 'graphql', 'tf', 'dockerfile'
])

/* ---------- day keys ---------- */

/**
 * Local calendar day for an epoch ms, `YYYY-MM-DD`. Local (not UTC) so the grid
 * agrees with the user's own sense of which day they worked.
 */
export function dayKey(ms: number): string {
  const d = new Date(ms)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** Midnight-local epoch ms for a day key, so day arithmetic stays DST-correct. */
function dayStart(key: string): number {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d).getTime()
}

/** The day key `n` days after `key` (DST-safe: goes through the local calendar). */
function addDays(key: string, n: number): string {
  const [y, m, d] = key.split('-').map(Number)
  return dayKey(new Date(y, m - 1, d + n).getTime())
}

/* ---------- deep pass ---------- */

/** What one transcript contributed; cached so unchanged files are never re-read. */
interface DeepStats {
  linesAdded: number
  linesRemoved: number
  files: Set<string>
  tools: Map<string, number>
  models: Map<string, number>
  /** ext → [files, linesAdded] */
  languages: Map<string, { files: Set<string>; linesAdded: number }>
}

function emptyDeep(): DeepStats {
  return {
    linesAdded: 0,
    linesRemoved: 0,
    files: new Set(),
    tools: new Map(),
    models: new Map(),
    languages: new Map()
  }
}

function bump(m: Map<string, number>, key: string | undefined | null, by = 1): void {
  if (!key) return
  m.set(key, (m.get(key) ?? 0) + by)
}

function countLines(s: unknown): number {
  if (typeof s !== 'string' || !s) return 0
  return s.split('\n').length
}

/** Attribute an edited file to its language and record the lines it gained. */
function recordFile(d: DeepStats, path: unknown, added: number): void {
  if (typeof path !== 'string' || !path) return
  d.files.add(path)
  const ext = extname(path).slice(1).toLowerCase()
  if (!ext || !CODE_EXTENSIONS.has(ext)) return
  let lang = d.languages.get(ext)
  if (!lang) d.languages.set(ext, (lang = { files: new Set(), linesAdded: 0 }))
  lang.files.add(path)
  lang.linesAdded += added
}

function parseJsonlLines(text: string): any[] {
  const out: any[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      out.push(JSON.parse(t))
    } catch {
      /* partial / corrupt line — skip, same tolerance as the parsers */
    }
  }
  return out
}

/**
 * Claude transcripts: assistant entries carry `message.content[]` with `tool_use`
 * blocks. Edit inputs hold old_string/new_string, Write holds the whole content.
 */
function deepClaude(text: string): DeepStats {
  const d = emptyDeep()
  for (const entry of parseJsonlLines(text)) {
    const msg = entry?.message
    if (!msg) continue
    if (typeof msg.model === 'string') bump(d.models, msg.model)
    if (!Array.isArray(msg.content)) continue
    for (const c of msg.content) {
      if (c?.type !== 'tool_use' || typeof c.name !== 'string') continue
      bump(d.tools, c.name)
      const input = c.input ?? {}
      if (c.name === 'Edit' || c.name === 'MultiEdit') {
        // MultiEdit carries an `edits` array; Edit is the single-edit shape
        const edits = Array.isArray(input.edits) ? input.edits : [input]
        let added = 0
        for (const e of edits) {
          added += countLines(e?.new_string)
          d.linesRemoved += countLines(e?.old_string)
        }
        d.linesAdded += added
        recordFile(d, input.file_path, added)
      } else if (c.name === 'Write') {
        const added = countLines(input.content)
        d.linesAdded += added
        recordFile(d, input.file_path, added)
      }
    }
  }
  return d
}

/**
 * Codex rollouts: `function_call` items (under `payload` in the current shape,
 * flat in pre-2026 logs). Codex has no edit tool — it patches through shell
 * `apply_patch` heredocs, so lines come from the patch body's +/- markers.
 */
function deepCodex(text: string): DeepStats {
  const d = emptyDeep()
  for (const entry of parseJsonlLines(text)) {
    const p = entry?.payload ?? entry
    if (typeof p?.model === 'string') bump(d.models, p.model)
    if (p?.type !== 'function_call' || typeof p.name !== 'string') continue
    bump(d.tools, p.name)
    const args = typeof p.arguments === 'string' ? p.arguments : ''
    if (!args.includes('apply_patch')) continue
    countPatch(d, args)
  }
  return d
}

/**
 * Pull +/- counts and touched paths out of an apply_patch body. The format is
 * `*** Add File: <path>` / `*** Update File: <path>` followed by +/- lines.
 * Args arrive JSON-encoded inside the tool call, so newlines may be escaped.
 */
function countPatch(d: DeepStats, args: string): void {
  const body = args.includes('\\n') && !args.includes('\n') ? args.replace(/\\n/g, '\n') : args
  let current: string | null = null
  let addedForCurrent = 0
  const flush = (): void => {
    if (current) recordFile(d, current, addedForCurrent)
    current = null
    addedForCurrent = 0
  }
  for (const line of body.split('\n')) {
    const header = /^\*\*\* (?:Add|Update|Delete) File: (.+?)"?$/.exec(line.trim())
    if (header) {
      flush()
      current = header[1].trim()
      continue
    }
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) {
      d.linesAdded++
      addedForCurrent++
    } else if (line.startsWith('-')) {
      d.linesRemoved++
    }
  }
  flush()
}

/**
 * Copilot sessions: `tool.execution_start` events with `data.toolName` and
 * `data.arguments`. `create` writes `file_text`; `edit` carries old/new strings.
 */
function deepCopilot(text: string): DeepStats {
  const d = emptyDeep()
  for (const entry of parseJsonlLines(text)) {
    if (typeof entry?.data?.model === 'string') bump(d.models, entry.data.model)
    if (entry?.type !== 'tool.execution_start') continue
    const data = entry.data ?? {}
    const name = typeof data.toolName === 'string' ? data.toolName : null
    if (!name) continue
    bump(d.tools, name)
    const args = data.arguments ?? {}
    if (name === 'create') {
      const added = countLines(args.file_text ?? args.content)
      d.linesAdded += added
      recordFile(d, args.path, added)
    } else if (name === 'edit' || name === 'str_replace') {
      const added = countLines(args.new_str ?? args.new_string ?? args.newStr)
      d.linesRemoved += countLines(args.old_str ?? args.old_string ?? args.oldStr)
      d.linesAdded += added
      recordFile(d, args.path, added)
    }
  }
  return d
}

const DEEP_PARSERS: Record<Provider, (text: string) => DeepStats> = {
  claude: deepClaude,
  codex: deepCodex,
  copilot: deepCopilot
}

/** file → parsed contribution, keyed on (mtime,size). Survives for the process. */
const deepCache = new Map<string, { mtimeMs: number; size: number; stats: DeepStats }>()

function deepForFile(file: string, provider: Provider): DeepStats | null {
  let mtimeMs = 0
  let size = 0
  try {
    const st = statSync(file)
    mtimeMs = st.mtimeMs
    size = st.size
  } catch {
    return null // file vanished between index and profile — skip it
  }
  const hit = deepCache.get(file)
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.stats
  let stats: DeepStats
  try {
    const { text } = readHead(file, DEEP_READ_BYTES)
    stats = DEEP_PARSERS[provider](text)
  } catch {
    return null // unreadable / reshaped log — never fail the whole profile for one file
  }
  deepCache.set(file, { mtimeMs, size, stats })
  return stats
}

function mergeDeep(into: DeepStats, from: DeepStats): void {
  into.linesAdded += from.linesAdded
  into.linesRemoved += from.linesRemoved
  for (const f of from.files) into.files.add(f)
  for (const [k, v] of from.tools) bump(into.tools, k, v)
  for (const [k, v] of from.models) bump(into.models, k, v)
  for (const [ext, lang] of from.languages) {
    let cur = into.languages.get(ext)
    if (!cur) into.languages.set(ext, (cur = { files: new Set(), linesAdded: 0 }))
    for (const f of lang.files) cur.files.add(f)
    cur.linesAdded += lang.linesAdded
  }
}

function topCounts(m: Map<string, number>, limit: number): NameCount[] {
  return [...m.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit)
}

/* ---------- streaks ---------- */

/**
 * Longest and current run of consecutive active days. "Current" tolerates today
 * being empty — a streak shouldn't read as broken until a whole day has lapsed.
 */
export function streaks(
  activeDays: Set<string>,
  today: string
): { current: number; longest: number } {
  if (activeDays.size === 0) return { current: 0, longest: 0 }
  const sorted = [...activeDays].sort()
  let longest = 1
  let run = 1
  for (let i = 1; i < sorted.length; i++) {
    run = addDays(sorted[i - 1], 1) === sorted[i] ? run + 1 : 1
    if (run > longest) longest = run
  }
  let current = 0
  let cursor = activeDays.has(today) ? today : addDays(today, -1)
  while (activeDays.has(cursor)) {
    current++
    cursor = addDays(cursor, -1)
  }
  return { current, longest }
}

/* ---------- assembly ---------- */

/**
 * Build the profile. `now` and `login` are injectable so tests stay deterministic
 * and never shell out to `gh`.
 *
 * Async because the deep pass reads every transcript: on a cold cache that is
 * seconds of IO, and this runs on the main process where a synchronous stall
 * would freeze the UI and every other IPC call. It yields between files (see
 * `yieldEvery`), matching the indexer's own scan discipline.
 */
export async function buildProfile(
  sessions: SessionMeta[],
  opts: { now: number; login: string | null; maxDays?: number }
): Promise<ProfileStats> {
  const { now, login } = opts
  const maxDays = opts.maxDays ?? 371 // 53 weeks — a full GitHub-style grid
  const today = dayKey(now)

  if (sessions.length === 0) {
    return {
      at: now,
      login,
      since: null,
      totalSessions: 0,
      activeDays: 0,
      currentStreak: 0,
      longestStreak: 0,
      busiestDay: null,
      days: [],
      providers: [],
      languages: [],
      repos: []
    }
  }

  /* cheap pass — everything below comes off the index, no file IO */
  // Accumulate through mutable twins of the shared types: the wire shapes are
  // deeply readonly (that's the contract the renderer gets), which is exactly
  // what a tallying loop can't use.
  const byDay = new Map<string, MutableDay>()
  const perProvider = new Map<Provider, { sessions: number; days: Set<string> }>()
  const repos = new Map<string, MutableRepoStat>()
  let since = Infinity

  for (const s of sessions) {
    const ts = s.startedAt || s.updatedAt
    if (!ts) continue
    if (ts < since) since = ts
    const key = dayKey(ts)

    let day = byDay.get(key)
    if (!day) byDay.set(key, (day = { day: key, sessions: 0, byProvider: {} }))
    day.sessions++
    day.byProvider[s.provider] = (day.byProvider[s.provider] ?? 0) + 1

    let p = perProvider.get(s.provider)
    if (!p) perProvider.set(s.provider, (p = { sessions: 0, days: new Set() }))
    p.sessions++
    p.days.add(key)

    const info = s.repo
    const repoKey = info?.key ?? 'general'
    let r = repos.get(repoKey)
    if (!r) {
      repos.set(
        repoKey,
        (r = { key: repoKey, name: info?.name ?? 'General', sessions: 0, lastActivity: 0 })
      )
    }
    r.sessions++
    if (s.updatedAt > r.lastActivity) r.lastActivity = s.updatedAt
  }

  /* dense day grid: zero-session days must exist so the heatmap has no holes */
  const firstKey = dayKey(Math.max(since, now - (maxDays - 1) * DAY_MS))
  const days: ActivityDay[] = []
  for (let cursor = firstKey; ; cursor = addDays(cursor, 1)) {
    days.push(byDay.get(cursor) ?? { day: cursor, sessions: 0, byProvider: {} })
    if (cursor === today || dayStart(cursor) > now) break
  }

  const busiestDay =
    [...byDay.values()].sort((a, b) => b.sessions - a.sessions || a.day.localeCompare(b.day))[0] ??
    null
  const { current, longest } = streaks(new Set(byDay.keys()), today)

  /* deep pass — bounded, cached reads of the transcripts themselves */
  const perProviderDeep = new Map<Provider, DeepStats>()
  const failures = new Map<Provider, number>()
  const attempts = new Map<Provider, number>()
  let sinceYield = 0
  for (const s of sessions) {
    attempts.set(s.provider, (attempts.get(s.provider) ?? 0) + 1)
    const stats = deepForFile(s.sourcePath, s.provider)
    if (++sinceYield >= YIELD_EVERY) {
      sinceYield = 0
      await new Promise<void>((r) => setImmediate(r))
    }
    if (!stats) {
      failures.set(s.provider, (failures.get(s.provider) ?? 0) + 1)
      continue
    }
    let agg = perProviderDeep.get(s.provider)
    if (!agg) perProviderDeep.set(s.provider, (agg = emptyDeep()))
    mergeDeep(agg, stats)
  }

  const providers: ProviderProfile[] = [...perProvider.entries()]
    .map(([provider, counts]) => {
      const deep = perProviderDeep.get(provider) ?? emptyDeep()
      const tried = attempts.get(provider) ?? 0
      const failed = failures.get(provider) ?? 0
      return {
        provider,
        sessions: counts.sessions,
        activeDays: counts.days.size,
        linesAdded: deep.linesAdded,
        linesRemoved: deep.linesRemoved,
        filesTouched: deep.files.size,
        tools: topCounts(deep.tools, 8),
        models: topCounts(deep.models, 5),
        ...(tried > 0 && failed === tried ? { deepUnavailable: 'logs unreadable' } : {})
      }
    })
    .sort((a, b) => b.sessions - a.sessions)

  const allLanguages = new Map<string, { files: Set<string>; linesAdded: number }>()
  for (const deep of perProviderDeep.values()) {
    for (const [ext, lang] of deep.languages) {
      let cur = allLanguages.get(ext)
      if (!cur) allLanguages.set(ext, (cur = { files: new Set(), linesAdded: 0 }))
      for (const f of lang.files) cur.files.add(f)
      cur.linesAdded += lang.linesAdded
    }
  }
  const languages: LanguageStat[] = [...allLanguages.entries()]
    .map(([ext, l]) => ({ ext, files: l.files.size, linesAdded: l.linesAdded }))
    .sort((a, b) => b.linesAdded - a.linesAdded || a.ext.localeCompare(b.ext))
    .slice(0, 8)

  return {
    at: now,
    login,
    since: since === Infinity ? null : since,
    totalSessions: sessions.length,
    activeDays: byDay.size,
    currentStreak: current,
    longestStreak: longest,
    busiestDay,
    days,
    providers,
    languages,
    repos: [...repos.values()].sort((a, b) => b.sessions - a.sessions).slice(0, 8)
  }
}

/** Entry point for the IPC handler: resolves the `gh` login, then aggregates. */
export async function getProfile(sessions: SessionMeta[]): Promise<ProfileStats> {
  const login = await ghUser().catch(() => null)
  return await buildProfile(sessions, { now: Date.now(), login })
}
