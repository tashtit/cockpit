import { closeSync, createReadStream, existsSync, openSync, readSync, statSync, type Stats } from 'node:fs'
import { join, sep } from 'node:path'
import type {
  Mutable,
  ProviderUsage,
  SourceDir,
  UsageSnapshot,
  UsageTokens,
  UsageWindow
} from '../shared/types'
import { claudeIdentity, codexIdentity, ghUser } from './accounts'
import { execText } from './env'
import { readTail, toMs, walkFiles } from './parsers/util'

/**
 * Current subscription usage per provider, without ever touching credentials:
 *   claude  — measured locally from <config>/projects JSONLs (per-message token usage,
 *             deduped by request, bucketed by hour → 5h block + trailing 7 days)
 *   codex   — the CLI persists provider-reported rate-limit snapshots (percent used
 *             per window) in its rollout logs; we read the newest one
 *   copilot — premium-request usage for the signed-in `gh` user via the GitHub
 *             billing API (fails soft when the token lacks the "user" scope)
 */

const HOUR = 3_600_000
const BLOCK_HOURS = 5 // Anthropic's rolling usage window
const WEEK_HOURS = 7 * 24

/* ---------- claude: local measurement ---------- */

/** Accumulator — mutated in place while folding, hence Mutable. */
type HourBucket = Mutable<UsageTokens> & { requests: number }

/** One request's tokens, kept compact: every request of a live log stays in memory. */
type RequestUsage = UsageTokens & { readonly hour: number }

/**
 * What one session log has been read to. Logs are append-only, so a log being written
 * is read on from `offset` rather than re-streamed from byte 0 on every snapshot — a
 * long session's log is tens of MB, and the meter asks every minute.
 */
type ClaudeFileState = {
  readonly ino: number
  readonly size: number
  readonly mtimeMs: number
  /** Bytes through the last complete line: where the next read resumes. */
  readonly offset: number
  /** The file's first bytes — a log rewritten in place keeps its inode, not its head. */
  readonly head: Buffer
  readonly anonymous: number
  /**
   * The complete lines' requests, carried across reads because a streamed request is
   * re-written under the same id and the last one wins. Filled in place by the next
   * read; null once the log has gone quiet, so idle logs keep only their buckets.
   */
  readonly perRequest: Map<string, RequestUsage> | null
  readonly buckets: ReadonlyMap<number, HourBucket>
}

/** Per session file, pruned to the files the last walk of their home still saw. */
const claudeFileCache = new Map<string, ClaudeFileState>()

/** How long after its last write a log stays resumable; after that only its buckets are kept. */
const RESUMABLE_MS = HOUR
const HEAD_BYTES = 256
const NEWLINE = 0x0a

/** The usage one log line reports, or null for every line that reports none. */
function requestOf(line: Buffer): { id: string | null; usage: RequestUsage } | null {
  // cheap pre-filter: only assistant entries carry token usage
  if (line.indexOf('"usage"') < 0 || line.indexOf('"assistant"') < 0) return null
  let entry: any
  try {
    entry = JSON.parse(line.toString('utf8'))
  } catch {
    return null // mid-write / corrupt line
  }
  if (entry?.type !== 'assistant') return null
  const u = entry.message?.usage
  const ts = toMs(entry.timestamp)
  if (!u || ts === null) return null
  const id: string | null =
    (typeof entry.requestId === 'string' && entry.requestId) ||
    (typeof entry.message?.id === 'string' && entry.message.id) ||
    null
  return {
    id,
    usage: {
      hour: Math.floor(ts / HOUR),
      input: Number(u.input_tokens) || 0,
      output: Number(u.output_tokens) || 0,
      cacheRead: Number(u.cache_read_input_tokens) || 0,
      cacheCreate: Number(u.cache_creation_input_tokens) || 0
    }
  }
}

/** Add a request (one) or a whole bucket (its count) to the hour's bucket. */
function addTo(
  buckets: Map<number, HourBucket>,
  hour: number,
  u: UsageTokens & { readonly requests?: number }
): void {
  let b = buckets.get(hour)
  if (!b) buckets.set(hour, (b = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, requests: 0 }))
  b.input += u.input
  b.output += u.output
  b.cacheRead += u.cacheRead
  b.cacheCreate += u.cacheCreate
  b.requests += u.requests ?? 1
}

/**
 * Whether `st` is `prev`'s log grown by appends: same inode, longer, same first bytes,
 * and still a line break where the last read stopped. Anything else is read from 0.
 */
function appendedTo(file: string, st: Stats, prev: ClaudeFileState): boolean {
  if (!prev.perRequest || st.ino !== prev.ino || st.size <= prev.size) return false
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const head = Buffer.alloc(prev.head.length)
    if (readSync(fd, head, 0, head.length, 0) !== head.length || !head.equals(prev.head)) return false
    if (prev.offset === 0) return true
    const last = Buffer.alloc(1)
    return readSync(fd, last, 0, 1, prev.offset - 1) === 1 && last[0] === NEWLINE
  } catch {
    return false
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/**
 * Bucket one claude session log by hour, reading on from where `prev` stopped when the
 * log was only appended to. Streamed in chunks — transcripts can be tens of MB and must
 * never be held in memory whole. Entries repeat while streaming, so usage is deduped by
 * request id (last occurrence wins — it has the final totals). An unterminated last
 * line counts provisionally and is read again next time, since it may still be mid-write.
 */
async function readClaudeFile(
  file: string,
  st: Stats,
  opts: { readonly prev?: ClaudeFileState; readonly now: number }
): Promise<ClaudeFileState> {
  const prev = opts.prev && appendedTo(file, st, opts.prev) ? opts.prev : undefined
  const perRequest = prev?.perRequest ?? new Map<string, RequestUsage>()
  let anonymous = prev?.anonymous ?? 0
  let offset = prev?.offset ?? 0
  let head = prev?.head ?? Buffer.alloc(0)
  let size = st.size
  let partial: Buffer[] = [] // bytes after the last line break read so far
  const commit = (line: Buffer): void => {
    const r = requestOf(line)
    if (r) perRequest.set(r.id ?? `anon-${anonymous++}`, r.usage)
  }
  if (st.size > offset) {
    try {
      // bounded by the size just stat'ed, so the recorded size is what was read
      const stream: AsyncIterable<Buffer> = createReadStream(file, { start: offset, end: st.size - 1 })
      for await (const chunk of stream) {
        if (!prev && head.length < HEAD_BYTES) {
          head = Buffer.concat([head, chunk.subarray(0, HEAD_BYTES - head.length)])
        }
        let from = 0
        for (let nl = chunk.indexOf(NEWLINE); nl >= 0; nl = chunk.indexOf(NEWLINE, from)) {
          const piece = chunk.subarray(from, nl)
          const line = partial.length ? Buffer.concat([...partial, piece]) : piece
          partial = []
          commit(line)
          offset += line.length + 1
          from = nl + 1
        }
        if (from < chunk.length) partial.push(chunk.subarray(from))
      }
    } catch {
      // unreadable mid-way — same failure tolerance as the parsers; what was committed
      // stands, and recording only that much makes the next snapshot read on from it
      partial = []
      size = offset
    }
  }

  const buckets = new Map<number, HourBucket>()
  const tail = partial.length ? requestOf(Buffer.concat(partial)) : null
  const tailKey = tail ? (tail.id ?? `anon-${anonymous}`) : null
  for (const [key, u] of perRequest) if (key !== tailKey) addTo(buckets, u.hour, u)
  if (tail) addTo(buckets, tail.usage.hour, tail.usage)

  const live = opts.now - st.mtimeMs < RESUMABLE_MS
  return {
    ino: st.ino,
    size,
    mtimeMs: st.mtimeMs,
    offset,
    head,
    anonymous,
    perRequest: live ? perRequest : null,
    buckets
  }
}

function emptyTokens(): UsageTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
}

function sumBuckets(
  buckets: Map<number, HourBucket>,
  fromHour: number
): { tokens: UsageTokens; requests: number } {
  const tokens: Mutable<UsageTokens> = emptyTokens()
  let requests = 0
  for (const [hour, b] of buckets) {
    if (hour < fromHour) continue
    tokens.input += b.input
    tokens.output += b.output
    tokens.cacheRead += b.cacheRead
    tokens.cacheCreate += b.cacheCreate
    requests += b.requests
  }
  return { tokens, requests }
}

/**
 * Usage measured from one claude config home. `now` is injectable for tests.
 * Block semantics follow the provider's rolling window: a block starts at the first
 * activity (hour-floored) and lasts 5 hours; a later message starts a new block.
 */
export async function claudeUsage(configDir: string, now = Date.now()): Promise<UsageWindow[]> {
  const root = join(configDir, 'projects')
  const cutoff = now - WEEK_HOURS * HOUR
  const files = walkFiles(root, 3).filter((f) => f.endsWith('.jsonl'))

  const merged = new Map<number, HourBucket>()
  const seen = new Set<string>()
  for (const file of files) {
    let st
    try {
      st = statSync(file)
    } catch {
      continue
    }
    if (st.mtimeMs < cutoff) continue // nothing in the trailing week
    seen.add(file)
    let cached = claudeFileCache.get(file)
    if (!cached || cached.ino !== st.ino || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
      cached = await readClaudeFile(file, st, { prev: cached, now })
      claudeFileCache.set(file, cached)
    }
    for (const [hour, b] of cached.buckets) addTo(merged, hour, b)
  }
  // a deleted log, or one gone quiet for a week, has nothing left to count
  const prefix = root + sep
  for (const file of claudeFileCache.keys()) {
    if (file.startsWith(prefix) && !seen.has(file)) claudeFileCache.delete(file)
  }

  const nowHour = Math.floor(now / HOUR)
  const weekFrom = nowHour - WEEK_HOURS
  const activeHours = [...merged.keys()].filter((h) => h >= weekFrom && h <= nowHour).sort((a, b) => a - b)

  // rolling 5h blocks: a new block starts when activity falls outside the current
  // block, or after a ≥5h idle gap
  let blockStart: number | null = null
  let lastActive: number | null = null
  for (const h of activeHours) {
    if (merged.get(h)!.requests === 0) continue
    if (blockStart === null || h - blockStart >= BLOCK_HOURS || h - (lastActive ?? h) >= BLOCK_HOURS) {
      blockStart = h
    }
    lastActive = h
  }

  const blockActive = blockStart !== null && nowHour - blockStart < BLOCK_HOURS
  const block = blockActive
    ? sumBuckets(merged, blockStart!)
    : { tokens: emptyTokens(), requests: 0 }
  const week = sumBuckets(merged, weekFrom)

  const blockWindow: UsageWindow = {
    label: 'current 5h block',
    ...block,
    ...(blockActive ? { resetsAt: (blockStart! + BLOCK_HOURS) * HOUR } : {})
  }
  return [blockWindow, { label: 'last 7 days', ...week }]
}

/* ---------- codex: provider-reported rate limits from rollout logs ---------- */

const CODEX_TAIL_BYTES = 128 * 1024
const CODEX_FILES_TO_TRY = 8

function codexWindowLabel(minutes: number): string {
  if (minutes === 300) return '5h window'
  if (minutes === 10_080) return 'weekly window'
  if (minutes % 1440 === 0) return `${minutes / 1440}d window`
  if (minutes % 60 === 0) return `${minutes / 60}h window`
  return `${minutes}m window`
}

function codexWindow(w: any): UsageWindow | null {
  if (!w || typeof w.used_percent !== 'number') return null
  const resets = toMs(w.resets_at)
  return {
    label: typeof w.window_minutes === 'number' ? codexWindowLabel(w.window_minutes) : 'window',
    usedPercent: Math.max(0, Math.min(100, w.used_percent)),
    ...(resets !== null ? { resetsAt: resets } : {})
  }
}

/** Last provider-reported rate-limit snapshot in one rollout file's tail, if any. */
export function codexSnapshotFromTail(text: string): {
  windows: UsageWindow[]
  plan?: string
  measuredAt?: number
} | null {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue
    let entry: any
    try {
      entry = JSON.parse(lines[i])
    } catch {
      continue
    }
    const rl = entry?.payload?.rate_limits
    if (!rl) continue
    const windows = [codexWindow(rl.primary), codexWindow(rl.secondary)].filter(
      (w): w is UsageWindow => w !== null
    )
    if (windows.length === 0) continue
    const out: { windows: UsageWindow[]; plan?: string; measuredAt?: number } = { windows }
    if (typeof rl.plan_type === 'string' && rl.plan_type) out.plan = rl.plan_type
    const ts = toMs(entry.timestamp)
    if (ts !== null) out.measuredAt = ts
    return out
  }
  return null
}

export function codexUsage(configDir: string): {
  windows: UsageWindow[]
  plan?: string
  measuredAt?: number
} | null {
  const files = walkFiles(join(configDir, 'sessions'), 5)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => {
      try {
        return { f, mtimeMs: statSync(f).mtimeMs }
      } catch {
        return null
      }
    })
    .filter((x): x is { f: string; mtimeMs: number } => x !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, CODEX_FILES_TO_TRY)
  for (const { f, mtimeMs } of files) {
    const snap = codexSnapshotFromTail(readTail(f, CODEX_TAIL_BYTES).text)
    if (snap) return { measuredAt: mtimeMs, ...snap }
  }
  return null
}

/* ---------- copilot: premium requests via the GitHub billing API ---------- */

/** Sum premium-request usage items from the billing report. Exported for tests. */
export function parsePremiumRequests(
  json: unknown
): { requests: number; requestsBilled: number } | null {
  const items = (json as any)?.usageItems
  if (!Array.isArray(items)) return null
  let requests = 0
  let requestsBilled = 0
  for (const it of items) {
    requests += Number(it?.grossQuantity) || 0
    requestsBilled += Number(it?.netQuantity) || 0
  }
  return { requests, requestsBilled: Math.round(requestsBilled) }
}

/**
 * When the premium-request allowance next resets: GitHub counts it per calendar month,
 * from the first at 00:00 UTC. Exported for tests.
 */
export function premiumRequestsResetAt(now = Date.now()): number {
  const d = new Date(now)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
}

async function ghApi(path: string): Promise<{ out: string | null; err: string | null }> {
  const r = await execText('gh', ['api', path])
  if (!r.ok) return { out: null, err: r.stderr.trim() || r.error || 'gh failed' }
  return { out: r.stdout, err: null }
}

async function copilotUsage(login: string): Promise<ProviderUsage> {
  const base: Mutable<ProviderUsage> = {
    provider: 'copilot',
    path: '',
    label: 'GitHub Copilot',
    identity: login,
    source: 'provider',
    windows: []
  }
  const { out, err } = await ghApi(`/users/${login}/settings/billing/premium_request/usage`)
  if (err) {
    base.unavailable = /user.?\s*scope|HTTP 403/i.test(err)
      ? 'gh token lacks the "user" scope — run `gh auth refresh -h github.com -s user`'
      : 'usage report unavailable for this account'
    return base
  }
  let parsed: ReturnType<typeof parsePremiumRequests> = null
  try {
    parsed = parsePremiumRequests(JSON.parse(out ?? ''))
  } catch {
    /* fall through to unavailable */
  }
  if (!parsed) {
    base.unavailable = 'usage report unavailable for this account'
    return base
  }
  base.measuredAt = Date.now()
  // the label is a column in Settings: "premium requests this month" wrapped to two
  // lines and made the row taller than every other — the month is what the reset says
  base.windows = [
    {
      label: 'premium requests',
      requests: Math.round(parsed.requests),
      requestsBilled: parsed.requestsBilled,
      resetsAt: premiumRequestsResetAt(base.measuredAt)
    }
  ]
  return base
}

/* ---------- throttling ---------- */

/**
 * Remember `compute`'s last result for `ttlMs` and coalesce concurrent calls into one
 * run. A rejected run is never remembered — the next call simply tries again. `now`
 * is injectable for tests.
 */
export function throttled<T>(
  ttlMs: number,
  compute: () => Promise<T>,
  now: () => number = Date.now
): () => Promise<T> {
  let last: { at: number; value: T } | null = null
  let inflight: Promise<T> | null = null
  return () => {
    if (last && now() - last.at < ttlMs) return Promise.resolve(last.value)
    if (inflight) return inflight
    inflight = compute()
      .then((value) => {
        last = { at: now(), value }
        return value
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  }
}

/**
 * Copilot usage goes over the network (`gh api`), so it is fetched at most once per
 * interval no matter how often the renderer asks. The fail-soft "unavailable" answers
 * are values too: a 403 is not retried until the interval passes either.
 */
const COPILOT_TTL_MS = 60_000
const copilotSnapshot = throttled(COPILOT_TTL_MS, async (): Promise<ProviderUsage> => {
  // copilot usage is per GitHub billing identity (the gh user), not per config home
  const login = await ghUser()
  return login
    ? copilotUsage(login)
    : {
        provider: 'copilot',
        path: '',
        label: 'GitHub Copilot',
        source: 'provider',
        windows: [],
        unavailable: 'gh CLI is not signed in'
      }
})

/* ---------- snapshot assembly ---------- */

/**
 * Local measurements are cheap (per-file caches) but not free: the sidebar asks on a
 * timer and again whenever a session starts or finishes, Settings asks on open. A
 * short TTL absorbs those bursts without hiding a just-finished turn for long.
 */
const SNAPSHOT_TTL_MS = 5_000
let latestSources: SourceDir[] = []
const snapshot = throttled(SNAPSHOT_TTL_MS, () => buildSnapshot(latestSources))

export function getUsage(sources: SourceDir[]): Promise<UsageSnapshot> {
  latestSources = sources
  return snapshot()
}

async function buildSnapshot(sources: SourceDir[]): Promise<UsageSnapshot> {
  const providers: ProviderUsage[] = []
  let sawCopilot = false
  for (const s of sources) {
    if (!existsSync(s.path)) continue
    if (s.provider === 'claude') {
      const entry: Mutable<ProviderUsage> = {
        provider: 'claude',
        path: s.path,
        label: s.label,
        identity: claudeIdentity(s.path),
        source: 'local-logs',
        measuredAt: Date.now(),
        windows: await claudeUsage(s.path)
      }
      if (!existsSync(join(s.path, 'projects'))) entry.unavailable = 'no session logs found'
      providers.push(entry)
    } else if (s.provider === 'codex') {
      const snap = codexUsage(s.path)
      const entry: Mutable<ProviderUsage> = {
        provider: 'codex',
        path: s.path,
        label: s.label,
        identity: codexIdentity(s.path),
        source: 'provider',
        windows: snap?.windows ?? []
      }
      if (snap) {
        entry.measuredAt = snap.measuredAt
        if (snap.plan) entry.plan = snap.plan
      } else {
        entry.unavailable = 'no rate-limit data in recent codex sessions'
      }
      providers.push(entry)
    } else {
      sawCopilot = true
    }
  }
  if (sawCopilot) providers.push(await copilotSnapshot())
  return { at: Date.now(), providers }
}
