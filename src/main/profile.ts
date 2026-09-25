import { createReadStream, mkdirSync, readFileSync, statSync } from 'node:fs'
import { rename, rm, writeFile } from 'node:fs/promises'
import { dirname, extname } from 'node:path'
import { createInterface } from 'node:readline'
import type {
  AccountStat,
  ActivityDay,
  AgentSplit,
  LanguageStat,
  ModelStat,
  Mutable,
  NameCount,
  ProfileStats,
  Provider,
  PromptTally,
  ProviderProfile,
  RepoStat,
  RoundtableTally,
  SessionMeta,
  SessionTally,
  SourceDir
} from '../shared/types'
import { claudeIdentity, codexIdentity, copilotUsers, ghUser } from './accounts'
import { parseUnifiedDiff } from './parsers/artifacts'
import { cellToolCalls } from './parsers/code-mode'
import { toolItemFor, toolItemName, toolRecords } from './parsers/codex'
import { contentToText, sessionLogFiles, toMs } from './parsers/util'

/**
 * The cross-agent work profile: an activity heatmap plus per-agent totals, built
 * entirely from session logs already on disk. Nothing is fetched, and only the
 * aggregate crosses the IPC bridge — never the sessions behind it.
 *
 * Two passes with very different costs:
 *   cheap — session, repo and account counts, straight off the index (no file IO)
 *   deep  — everything read from the transcripts themselves: prompts and when they
 *           were sent (so the activity grid, the streaks and the hours), lines
 *           edited, languages, tool mix and models; cached on (mtime,size) so a rescan
 *           re-reads only what changed, mirroring usage.ts and the indexer's own cache
 *
 * The deep pass streams each log whole (up to DEEP_READ_BYTES), and is failure-tolerant
 * by design: provider log formats are internal and drift between releases, so an
 * unreadable or reshaped transcript is skipped rather than failing the profile.
 */

/**
 * The deep pass reads at most this much of any one transcript. It used to stop at 2MB,
 * and a third of real Claude transcripts are bigger (a screenshot is a megabyte of
 * base64), so everything a long session did after its first hour went uncounted. The
 * largest seen is ~110MB; streamed a line at a time, a whole machine's logs (1.4GB)
 * read in a few seconds cold, and only changed files after that. Codex's reader keeps
 * a file's lines (its tool records pair across the whole file), so it gets a smaller
 * bound: the largest rollout seen is 26MB.
 */
const DEEP_READ_BYTES: Record<Provider, number> = {
  claude: 256 * 1024 * 1024,
  copilot: 256 * 1024 * 1024,
  codex: 64 * 1024 * 1024
}

const DAY_MS = 86_400_000

/** Deep pass hands the event loop back this often, so IPC never stalls behind it. */
const YIELD_EVERY = 20

/** Tallying counterparts of the readonly wire types (see buildProfile). */
type MutableDay = Mutable<ActivityDay>
type MutableRepoStat = Mutable<RepoStat>
type MutableTally = Mutable<SessionTally>

function emptyTally(): MutableTally {
  return { sessions: 0, byProvider: {} }
}

/** One more session in a bucket, credited to the agent that ran it. */
function tally(t: MutableTally, provider: Provider): void {
  t.sessions++
  t.byProvider[provider] = (t.byProvider[provider] ?? 0) + 1
}

function split(into: AgentSplit, provider: Provider, by: number): void {
  into[provider] = (into[provider] ?? 0) + by
}

/** The seats, apart from the person's own sessions: how many, which agents, how many tables. */
function seatTally(seats: readonly SessionMeta[]): RoundtableTally | null {
  if (seats.length === 0) return null
  const t = emptyTally()
  for (const s of seats) tally(t, s.provider)
  return { ...t, tables: new Set(seats.map((s) => s.roundtableId ?? s.cwd)).size }
}

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

/** What one transcript contributed; cached so unchanged files are never re-read.
 *  Mutable on purpose — this is the per-file accumulator the deep pass fills in. */
type DeepStats = {
  /** What the person sent, never tool results or injected context (see ProviderProfile.prompts) */
  prompts: number
  /** When each prompt was sent, where its record says: the activity grid and the hours */
  promptTimes: number[]
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
    prompts: 0,
    promptTimes: [],
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

/** Lines as written: a trailing newline ends the last line, it doesn't add one. */
function countLines(s: unknown): number {
  if (typeof s !== 'string' || !s) return 0
  return s.split('\n').length - (s.endsWith('\n') ? 1 : 0)
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

/**
 * A Claude `user` entry the person typed. The same entry type carries every tool
 * result, the CLI's own notes (`isMeta`), a compaction summary and the markup
 * around a local command — only a slash command is input among the `<…>` ones.
 */
function isClaudePrompt(entry: any): boolean {
  if (entry?.type !== 'user' || entry.isMeta || entry.isSidechain || entry.isCompactSummary) return false
  const content = entry.message?.content
  if (Array.isArray(content) && content.some((b: any) => b?.type === 'tool_result')) return false
  const text = contentToText(content).trimStart()
  if (!text || text.startsWith('[Request interrupted')) return false
  return !text.startsWith('<') || text.startsWith('<command-')
}

/** One prompt, and when it was sent if its record says. */
function prompted(d: DeepStats, at: unknown): void {
  d.prompts++
  const t = toMs(at)
  if (t) d.promptTimes.push(t)
}

/**
 * A per-file accumulator, fed one parsed log line at a time and read out once at the
 * end — so a 100MB transcript never has to be held whole.
 */
type DeepReader = {
  readonly line: (entry: any) => void
  readonly done: () => DeepStats
}

/**
 * Claude transcripts: assistant entries carry `message.content[]` with `tool_use`
 * blocks. Edit inputs hold old_string/new_string, Write holds the whole content.
 */
function claudeReader(): DeepReader {
  const d = emptyDeep()
  return { line: (entry) => claudeLine(d, entry), done: () => d }
}

function claudeLine(d: DeepStats, entry: any): void {
  if (isClaudePrompt(entry)) prompted(d, entry.timestamp)
  const msg = entry?.message
  if (!msg) return
  if (typeof msg.model === 'string') bump(d.models, msg.model)
  if (!Array.isArray(msg.content)) return
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

/**
 * Codex rollouts (under `payload` in the current shape, flat in pre-2026 logs). One
 * tool run can be recorded three times — a direct call, a line of a code-mode `exec`
 * cell, the typed item it completes with — so each is counted from the one record the
 * transcript reads it from (`toolRecords`), never twice. Codex has no edit tool: lines
 * come from `apply_patch` bodies (a call's own, or a cell's) and from the `FileChange`
 * items a patch run inside a cell completes with.
 *
 * Prompts come from the `user_message` events, which carry exactly what was typed. A
 * rollout without them has only its `message` items, where the user role also holds
 * the context Codex injects (`<environment_context>`, AGENTS.md) — skipped the way
 * the parser skips it for a title.
 */
function deepCodex(lines: readonly any[]): DeepStats {
  const d = emptyDeep()
  const records = toolRecords(lines)
  const typed: unknown[] = []
  const userItems: unknown[] = []
  for (const entry of lines) {
    const p = entry?.payload ?? entry
    if (typeof p?.model === 'string') bump(d.models, p.model)
    if (entry?.type === 'event_msg' && p?.type === 'user_message') typed.push(entry.timestamp)
    else if (entry?.type !== 'event_msg' && p?.type === 'message' && p.role === 'user') {
      const t = contentToText(p.content).trimStart()
      if (t && !t.startsWith('<') && !t.startsWith('# AGENTS.md')) userItems.push(entry.timestamp)
    }
    const item = toolItemFor(entry, records)
    if (item?.type === 'FileChange') {
      if (countFileChange(d, item)) bump(d.tools, 'apply_patch')
    } else if (item) {
      bump(d.tools, toolItemName(item))
    } else if (p?.type === 'function_call' && typeof p.name === 'string') {
      bump(d.tools, p.name)
      const args = typeof p.arguments === 'string' ? p.arguments : ''
      if (args.includes('apply_patch')) countPatch(d, args)
    } else if (p?.type === 'custom_tool_call' && typeof p.name === 'string' && typeof p.input === 'string') {
      if (p.name !== 'exec') {
        bump(d.tools, p.name)
        if (p.name === 'apply_patch') countPatch(d, p.input)
      } else if (records.cells) {
        // a cell is not a run of its own: the tools it calls are
        for (const call of cellToolCalls(p.input)) {
          bump(d.tools, call.name)
          if (call.name === 'apply_patch' && typeof call.input === 'string') countPatch(d, call.input)
        }
      }
    }
  }
  for (const at of typed.length > 0 ? typed : userItems) prompted(d, at)
  return d
}

/** Codex's tool records pair calls across the whole file (`toolRecords`), so its lines are kept. */
function codexReader(): DeepReader {
  const lines: any[] = []
  return { line: (entry) => lines.push(entry), done: () => deepCodex(lines) }
}

/**
 * A `FileChange` item's `changes`, path → `{type: 'add' | 'delete', content}` or
 * `{type: 'update', unified_diff}`. One that failed or was declined still names its
 * files but edited none of them. Says whether it named any file (the transcript shows
 * no row for one that names none).
 */
function countFileChange(d: DeepStats, item: any): boolean {
  const changes = item?.changes
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) return false
  const applied = typeof item.status !== 'string' || item.status === 'completed'
  let named = false
  for (const [path, change] of Object.entries<any>(changes)) {
    named = true
    if (!applied) continue
    const kind = change?.type ?? change?.kind
    let added = 0
    if (kind === 'add') added = countLines(change.content)
    else if (kind === 'delete') d.linesRemoved += countLines(change.content)
    else if (typeof change?.unified_diff === 'string') {
      for (const hunk of parseUnifiedDiff(change.unified_diff)) {
        for (const line of hunk) {
          if (line.op === 'add') added++
          else if (line.op === 'del') d.linesRemoved++
        }
      }
    }
    d.linesAdded += added
    recordFile(d, path, added)
  }
  return named
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
 * Every `user.message` is a prompt: Copilot logs its injected context elsewhere.
 */
function copilotReader(): DeepReader {
  const d = emptyDeep()
  return { line: (entry) => copilotLine(d, entry), done: () => d }
}

function copilotLine(d: DeepStats, entry: any): void {
  if (typeof entry?.data?.model === 'string') bump(d.models, entry.data.model)
  if (entry?.type === 'user.message') prompted(d, entry.timestamp)
  if (entry?.type !== 'tool.execution_start') return
  const data = entry.data ?? {}
  const name = typeof data.toolName === 'string' ? data.toolName : null
  if (!name) return
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

const DEEP_READERS: Record<Provider, () => DeepReader> = {
  claude: claudeReader,
  codex: codexReader,
  copilot: copilotReader
}

/**
 * Stream one log through its provider's reader, a line at a time, up to DEEP_READ_BYTES.
 * A line cut by the cap or half-written by a live session fails to parse and is skipped
 * — the same tolerance the parsers have.
 */
async function readDeep(file: string, provider: Provider): Promise<DeepStats> {
  const reader = DEEP_READERS[provider]()
  const input = createReadStream(file, { end: DEEP_READ_BYTES[provider] - 1 })
  const lines = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const raw of lines) {
      const t = raw.trim()
      if (!t) continue
      let entry: unknown
      try {
        entry = JSON.parse(t)
      } catch {
        continue
      }
      reader.line(entry)
    }
  } finally {
    lines.close()
    input.destroy()
  }
  return reader.done()
}

/**
 * file → parsed contribution, keyed on (mtime,size). Lives for the process, and is
 * persisted to userData between launches (`cacheFile`): reading every log whole is
 * seconds of IO on a real machine (7s over 1.4GB of logs, measured), which a restart
 * must not pay again for files that have not changed.
 */
const deepCache = new Map<string, { mtimeMs: number; size: number; stats: DeepStats }>()
/** A fresh read landed in `deepCache` since it was last saved */
let deepDirty = false
/** The persisted cache already merged into `deepCache`, so it is read once per launch */
let deepLoadedFrom: string | null = null
/** Saves chain, so two builds finishing together never interleave a write and a rename */
let deepSaving: Promise<void> = Promise.resolve()

/** Bumped whenever a reader changes what it counts: an older cache is then read fresh. */
const DEEP_CACHE_VERSION = 1

/** DeepStats as JSON has it: Sets and Maps as arrays. */
type StoredStats = {
  readonly prompts: number
  readonly promptTimes: number[]
  readonly linesAdded: number
  readonly linesRemoved: number
  readonly files: string[]
  readonly tools: [string, number][]
  readonly models: [string, number][]
  readonly languages: [string, { readonly files: string[]; readonly linesAdded: number }][]
}

function storeStats(d: DeepStats): StoredStats {
  return {
    prompts: d.prompts,
    promptTimes: d.promptTimes,
    linesAdded: d.linesAdded,
    linesRemoved: d.linesRemoved,
    files: [...d.files],
    tools: [...d.tools],
    models: [...d.models],
    languages: [...d.languages].map(([ext, l]) => [ext, { files: [...l.files], linesAdded: l.linesAdded }])
  }
}

/** The stored shape back, or null for anything that isn't one — the file is only ours until it isn't. */
function reviveStats(v: any): DeepStats | null {
  const nums = (a: unknown): a is number[] => Array.isArray(a) && a.every((n) => typeof n === 'number')
  const pairs = (a: unknown): a is [string, number][] =>
    Array.isArray(a) && a.every((e) => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'number')
  if (
    typeof v?.prompts !== 'number' ||
    !nums(v.promptTimes) ||
    typeof v.linesAdded !== 'number' ||
    typeof v.linesRemoved !== 'number' ||
    !Array.isArray(v.files) ||
    !pairs(v.tools) ||
    !pairs(v.models) ||
    !Array.isArray(v.languages)
  ) {
    return null
  }
  const languages = new Map<string, { files: Set<string>; linesAdded: number }>()
  for (const e of v.languages) {
    if (!Array.isArray(e) || typeof e[0] !== 'string' || !Array.isArray(e[1]?.files)) return null
    languages.set(e[0], { files: new Set(e[1].files), linesAdded: Number(e[1].linesAdded) || 0 })
  }
  return {
    prompts: v.prompts,
    promptTimes: v.promptTimes,
    linesAdded: v.linesAdded,
    linesRemoved: v.linesRemoved,
    files: new Set(v.files),
    tools: new Map(v.tools),
    models: new Map(v.models),
    languages
  }
}

/** Merge the persisted cache into memory, once per launch. A missing or stale one is no loss. */
function loadDeepCache(file: string): void {
  if (deepLoadedFrom === file) return
  deepLoadedFrom = file
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (raw?.v !== DEEP_CACHE_VERSION || typeof raw.entries !== 'object' || raw.entries === null) return
    for (const [path, e] of Object.entries<any>(raw.entries)) {
      const stats = reviveStats(e?.stats)
      if (stats && typeof e.mtimeMs === 'number' && typeof e.size === 'number' && !deepCache.has(path)) {
        deepCache.set(path, { mtimeMs: e.mtimeMs, size: e.size, stats })
      }
    }
  } catch {
    /* no cache yet, or an unreadable one: this build writes a fresh one */
  }
}

/**
 * Keep exactly the logs this build read — a log that is gone, or no longer indexed,
 * leaves the cache with it — and write it out when anything changed.
 */
function saveDeepCache(file: string, visited: ReadonlySet<string>): Promise<void> {
  for (const path of deepCache.keys()) {
    if (visited.has(path)) continue
    deepCache.delete(path)
    deepDirty = true
  }
  if (!deepDirty) return deepSaving
  deepDirty = false
  const entries: Record<string, { mtimeMs: number; size: number; stats: StoredStats }> = {}
  for (const [path, e] of deepCache) entries[path] = { mtimeMs: e.mtimeMs, size: e.size, stats: storeStats(e.stats) }
  const body = JSON.stringify({ v: DEEP_CACHE_VERSION, entries })
  deepSaving = deepSaving.then(async () => {
    const tmp = `${file}.${process.pid}.tmp`
    try {
      mkdirSync(dirname(file), { recursive: true })
      await writeFile(tmp, body)
      await rename(tmp, file)
    } catch (err) {
      console.error('[profile] cache save failed:', err)
      await rm(tmp, { force: true }).catch(() => {})
    }
  })
  return deepSaving
}

/** Forget the in-memory cache — for tests, which must see what a fresh launch sees. */
export function forgetDeepCache(): void {
  deepCache.clear()
  deepDirty = false
  deepLoadedFrom = null
}

async function deepForFile(file: string, provider: Provider): Promise<DeepStats | null> {
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
    stats = await readDeep(file, provider)
  } catch {
    return null // unreadable / reshaped log — never fail the whole profile for one file
  }
  deepCache.set(file, { mtimeMs, size, stats })
  deepDirty = true
  return stats
}

function mergeDeep(into: DeepStats, from: DeepStats): void {
  into.prompts += from.prompts
  for (const t of from.promptTimes) into.promptTimes.push(t)
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

/** Identity of one signed-in account, injectable so buildProfile stays IO-free here. */
export type AccountIdentity = {
  readonly provider: Provider
  readonly label: string
  readonly identity: string | null
}

export type ProfileOptions = {
  readonly now: number
  readonly login: string | null
  readonly maxDays?: number
  /** Signed-in identities per source (provider+label), from accounts.ts */
  readonly identities?: AccountIdentity[]
  /** Roundtable seat sessions — never in `sessions`, reported apart */
  readonly seats?: readonly SessionMeta[]
  /** Where the deep pass's per-file cache persists between launches (userData) */
  readonly cacheFile?: string
}

/**
 * Build the profile. `now` and `login` are injectable so tests stay deterministic
 * and never shell out to `gh`.
 *
 * Async because the deep pass reads every transcript: on a cold cache that is
 * seconds of IO, and this runs on the main process where a synchronous stall
 * would freeze the UI and every other IPC call. It yields between files (see
 * `YIELD_EVERY`), matching the indexer's own scan discipline.
 */
export async function buildProfile(sessions: SessionMeta[], opts: ProfileOptions): Promise<ProfileStats> {
  if (opts.cacheFile) loadDeepCache(opts.cacheFile)
  const profile = await assemble(sessions, opts)
  if (opts.cacheFile) await saveDeepCache(opts.cacheFile, new Set(sessions.flatMap((s) => sessionLogFiles(s))))
  return profile
}

async function assemble(sessions: SessionMeta[], opts: ProfileOptions): Promise<ProfileStats> {
  const { now, login } = opts
  const maxDays = opts.maxDays ?? 371 // 53 weeks — a full GitHub-style grid
  const today = dayKey(now)
  const roundtables = seatTally(opts.seats ?? [])

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
      repos: [],
      models: [],
      accounts: [],
      hours: Array.from({ length: 24 }, () => ({ prompts: 0, byProvider: {} })),
      roundtables
    }
  }

  /* cheap pass — everything below comes off the index, no file IO */
  // Accumulate through mutable twins of the shared types: the wire shapes are
  // deeply readonly (that's the contract the renderer gets), which is exactly
  // what a tallying loop can't use.
  const perProvider = new Map<Provider, { sessions: number; days: Set<string> }>()
  const repos = new Map<string, MutableRepoStat>()
  const bySource = new Map<string, Mutable<AccountStat>>()
  let since = Infinity

  for (const s of sessions) {
    const ts = s.startedAt || s.updatedAt
    if (!ts) continue
    if (ts < since) since = ts

    let p = perProvider.get(s.provider)
    if (!p) perProvider.set(s.provider, (p = { sessions: 0, days: new Set() }))
    p.sessions++

    const srcKey = `${s.provider}:${s.source}`
    let acct = bySource.get(srcKey)
    if (!acct) {
      bySource.set(
        srcKey,
        (acct = { provider: s.provider, label: s.source, identity: null, sessions: 0, lastActivity: 0 })
      )
    }
    acct.sessions++
    if (s.updatedAt > acct.lastActivity) acct.lastActivity = s.updatedAt

    const info = s.repo
    const repoKey = info?.key ?? 'general'
    let r = repos.get(repoKey)
    if (!r) {
      repos.set(
        repoKey,
        (r = {
          key: repoKey,
          name: info?.name ?? 'General',
          fullName: info?.fullName ?? null,
          ...emptyTally(),
          lastActivity: 0
        })
      )
    }
    tally(r, s.provider)
    if (s.updatedAt > r.lastActivity) r.lastActivity = s.updatedAt
  }

  /* deep pass — bounded, cached reads of the transcripts themselves */
  const perProviderDeep = new Map<Provider, DeepStats>()
  const failures = new Map<Provider, number>()
  const attempts = new Map<Provider, number>()
  const reads = new Map<Provider, number>()
  const byDay = new Map<string, MutableDay>()
  const hours = Array.from({ length: 24 }, (): Mutable<PromptTally> => ({ prompts: 0, byProvider: {} }))
  let sinceYield = 0
  for (const s of sessions) {
    const ts = s.startedAt || s.updatedAt
    attempts.set(s.provider, (attempts.get(s.provider) ?? 0) + 1)
    // a thread kept across several files counts every page of it
    const pages: (DeepStats | null)[] = []
    for (const f of sessionLogFiles(s)) pages.push(await deepForFile(f, s.provider))
    if (++sinceYield >= YIELD_EVERY) {
      sinceYield = 0
      await new Promise<void>((r) => setImmediate(r))
    }
    const read = pages[pages.length - 1] !== null
    // The days it was worked in: the day it started, and every day it was sent a
    // prompt — a session resumed all week is a week of work, not one square.
    const worked = new Set<string>(ts ? [dayKey(ts)] : [])
    if (read) {
      for (const stats of pages) {
        for (const t of stats?.promptTimes ?? []) {
          worked.add(dayKey(t))
          const h = hours[new Date(t).getHours()]
          h.prompts++
          split(h.byProvider, s.provider, 1)
        }
      }
    }
    for (const key of worked) {
      let day = byDay.get(key)
      if (!day) byDay.set(key, (day = { day: key, ...emptyTally() }))
      tally(day, s.provider)
      perProvider.get(s.provider)?.days.add(key)
    }
    if (!read) {
      failures.set(s.provider, (failures.get(s.provider) ?? 0) + 1)
      continue
    }
    reads.set(s.provider, (reads.get(s.provider) ?? 0) + 1)
    let agg = perProviderDeep.get(s.provider)
    if (!agg) perProviderDeep.set(s.provider, (agg = emptyDeep()))
    for (const stats of pages) if (stats) mergeDeep(agg, stats)
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

  const providers: ProviderProfile[] = [...perProvider.entries()]
    .map(([provider, counts]) => {
      const deep = perProviderDeep.get(provider) ?? emptyDeep()
      const tried = attempts.get(provider) ?? 0
      const failed = failures.get(provider) ?? 0
      let toolCalls = 0
      for (const n of deep.tools.values()) toolCalls += n
      return {
        provider,
        sessions: counts.sessions,
        activeDays: counts.days.size,
        readSessions: reads.get(provider) ?? 0,
        prompts: deep.prompts,
        toolCalls,
        linesAdded: deep.linesAdded,
        linesRemoved: deep.linesRemoved,
        filesTouched: deep.files.size,
        tools: topCounts(deep.tools, 8),
        models: topCounts(deep.models, 5),
        ...(tried > 0 && failed === tried ? { deepUnavailable: 'logs unreadable' } : {})
      }
    })
    .sort((a, b) => b.sessions - a.sessions)

  // Languages merged across agents, split like models: which agent writes the Swift
  const allLanguages = new Map<string, { files: Set<string>; linesAdded: number; byProvider: AgentSplit }>()
  for (const [provider, deep] of perProviderDeep) {
    for (const [ext, lang] of deep.languages) {
      let cur = allLanguages.get(ext)
      if (!cur) allLanguages.set(ext, (cur = { files: new Set(), linesAdded: 0, byProvider: {} }))
      for (const f of lang.files) cur.files.add(f)
      cur.linesAdded += lang.linesAdded
      if (lang.linesAdded > 0) split(cur.byProvider, provider, lang.linesAdded)
    }
  }
  const languages: LanguageStat[] = [...allLanguages.entries()]
    .map(([ext, l]) => ({ ext, files: l.files.size, linesAdded: l.linesAdded, byProvider: l.byProvider }))
    .sort((a, b) => b.linesAdded - a.linesAdded || a.ext.localeCompare(b.ext))
    .slice(0, 8)

  // Models merged across agents, keeping the per-agent split — the same model
  // family crosses agent boundaries (Copilot serves claude-opus), and that
  // split is what the profile's segmented bars exist to show.
  const allModels = new Map<string, Mutable<ModelStat>>()
  for (const [provider, deep] of perProviderDeep) {
    for (const [name, count] of deep.models) {
      if (name === '<synthetic>') continue // claude's placeholder for injected turns, not a model
      let m = allModels.get(name)
      if (!m) allModels.set(name, (m = { name, count: 0, byProvider: {} }))
      m.count += count
      split(m.byProvider, provider, count)
    }
  }
  const models: ModelStat[] = [...allModels.values()]
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 8)

  // Accounts: join each source's session tally with its signed-in identity
  const identityOf = new Map(
    (opts.identities ?? []).map((a) => [`${a.provider}:${a.label}`, a.identity])
  )
  const accounts: AccountStat[] = [...bySource.entries()]
    .map(([key, a]) => ({ ...a, identity: identityOf.get(key) ?? null }))
    .sort((a, b) => b.sessions - a.sessions)

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
    repos: [...repos.values()].sort((a, b) => b.sessions - a.sessions).slice(0, 8),
    models,
    accounts,
    hours,
    roundtables
  }
}

/** Signed-in identity per source, read from each provider's own config files. */
function sourceIdentities(sources: SourceDir[]): AccountIdentity[] {
  return sources.map((s) => {
    let identity: string | null = null
    try {
      if (s.provider === 'claude') identity = claudeIdentity(s.path)
      else if (s.provider === 'codex') identity = codexIdentity(s.path)
      else identity = copilotUsers(s.path).active
    } catch {
      /* unreadable config — the account still lists, just unnamed */
    }
    return { provider: s.provider, label: s.label, identity }
  })
}

/**
 * Entry point for the IPC handler: resolves the `gh` login, then aggregates. `sessions`
 * are the person's own (the indexer's `ownSessions`); the roundtables' seats come in apart.
 */
export async function getProfile(
  sessions: SessionMeta[],
  opts: {
    readonly sources?: SourceDir[]
    readonly seats?: readonly SessionMeta[]
    readonly cacheFile?: string
  } = {}
): Promise<ProfileStats> {
  const login = await ghUser().catch(() => null)
  return await buildProfile(sessions, {
    now: Date.now(),
    login,
    identities: sourceIdentities(opts.sources ?? []),
    seats: opts.seats,
    cacheFile: opts.cacheFile
  })
}
