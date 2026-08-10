import { execFile } from 'node:child_process'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type {
  ProviderUsage,
  SourceDir,
  UsageSnapshot,
  UsageTokens,
  UsageWindow
} from '../shared/types'
import { claudeIdentity, codexIdentity, ghUser } from './accounts'
import { cliEnv } from './env'
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

interface HourBucket extends UsageTokens {
  requests: number
}

/** Hourly token totals for one session file; re-parsed only when the file changes. */
const claudeFileCache = new Map<
  string,
  { mtimeMs: number; size: number; buckets: Map<number, HourBucket> }
>()

function addUsage(b: HourBucket, u: any): void {
  b.input += Number(u.input_tokens) || 0
  b.output += Number(u.output_tokens) || 0
  b.cacheRead += Number(u.cache_read_input_tokens) || 0
  b.cacheCreate += Number(u.cache_creation_input_tokens) || 0
  b.requests += 1
}

/**
 * Bucket one claude session log by hour. Streaming line reader — transcripts can be
 * tens of MB and must never be held in memory whole. Entries repeat while streaming,
 * so usage is deduped by request id (last occurrence wins — it has the final totals).
 */
async function parseClaudeFile(file: string): Promise<Map<number, HourBucket>> {
  const perRequest = new Map<string, { ts: number; usage: any }>()
  let anonymous = 0
  const rl = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity
  })
  try {
    for await (const line of rl) {
      // cheap pre-filter: only assistant entries carry token usage
      if (!line.includes('"usage"') || !line.includes('"assistant"')) continue
      let entry: any
      try {
        entry = JSON.parse(line)
      } catch {
        continue // mid-write / corrupt line
      }
      if (entry?.type !== 'assistant') continue
      const usage = entry.message?.usage
      const ts = toMs(entry.timestamp)
      if (!usage || ts === null) continue
      const key: string =
        (typeof entry.requestId === 'string' && entry.requestId) ||
        (typeof entry.message?.id === 'string' && entry.message.id) ||
        `anon-${anonymous++}`
      perRequest.set(key, { ts, usage })
    }
  } catch {
    /* unreadable file — skip, same failure tolerance as the parsers */
  } finally {
    rl.close()
  }
  const buckets = new Map<number, HourBucket>()
  for (const { ts, usage } of perRequest.values()) {
    const hour = Math.floor(ts / HOUR)
    let b = buckets.get(hour)
    if (!b) buckets.set(hour, (b = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, requests: 0 }))
    addUsage(b, usage)
  }
  return buckets
}

function emptyTokens(): UsageTokens {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
}

function sumBuckets(
  buckets: Map<number, HourBucket>,
  fromHour: number
): { tokens: UsageTokens; requests: number } {
  const tokens = emptyTokens()
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
  for (const file of files) {
    let st
    try {
      st = statSync(file)
    } catch {
      continue
    }
    if (st.mtimeMs < cutoff) continue // nothing in the trailing week
    let cached = claudeFileCache.get(file)
    if (!cached || cached.mtimeMs !== st.mtimeMs || cached.size !== st.size) {
      cached = { mtimeMs: st.mtimeMs, size: st.size, buckets: await parseClaudeFile(file) }
      claudeFileCache.set(file, cached)
    }
    for (const [hour, b] of cached.buckets) {
      let m = merged.get(hour)
      if (!m) merged.set(hour, (m = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, requests: 0 }))
      m.input += b.input
      m.output += b.output
      m.cacheRead += b.cacheRead
      m.cacheCreate += b.cacheCreate
      m.requests += b.requests
    }
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

  const blockWindow: UsageWindow = { label: 'current 5h block', ...block }
  if (blockActive) blockWindow.resetsAt = (blockStart! + BLOCK_HOURS) * HOUR
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
  const win: UsageWindow = {
    label: typeof w.window_minutes === 'number' ? codexWindowLabel(w.window_minutes) : 'window',
    usedPercent: Math.max(0, Math.min(100, w.used_percent))
  }
  const resets = toMs(w.resets_at)
  if (resets !== null) win.resetsAt = resets
  return win
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

function ghApi(path: string): Promise<{ out: string | null; err: string | null }> {
  return new Promise((res) => {
    execFile(
      'gh',
      ['api', path],
      { env: cliEnv(), timeout: 15_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return res({ out: null, err: String(stderr || err.message || 'gh failed') })
        res({ out: stdout, err: null })
      }
    )
  })
}

async function copilotUsage(login: string): Promise<ProviderUsage> {
  const base: ProviderUsage = {
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
  base.windows = [
    {
      label: 'premium requests this month',
      requests: Math.round(parsed.requests),
      requestsBilled: parsed.requestsBilled
    }
  ]
  return base
}

/* ---------- snapshot assembly (60s TTL, like github.ts) ---------- */

const TTL_MS = 60_000
let cache: { at: number; data: UsageSnapshot } | null = null
let inflight: Promise<UsageSnapshot> | null = null

export function getUsage(sources: SourceDir[]): Promise<UsageSnapshot> {
  if (cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.data)
  if (inflight) return inflight
  inflight = buildSnapshot(sources)
    .then((data) => {
      cache = { at: Date.now(), data }
      return data
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

async function buildSnapshot(sources: SourceDir[]): Promise<UsageSnapshot> {
  const providers: ProviderUsage[] = []
  let sawCopilot = false
  for (const s of sources) {
    if (!existsSync(s.path)) continue
    if (s.provider === 'claude') {
      const entry: ProviderUsage = {
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
      const entry: ProviderUsage = {
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
  // copilot usage is per GitHub billing identity (the gh user), not per config home
  if (sawCopilot) {
    const login = await ghUser()
    providers.push(
      login
        ? await copilotUsage(login)
        : {
            provider: 'copilot',
            path: '',
            label: 'GitHub Copilot',
            source: 'provider',
            windows: [],
            unavailable: 'gh CLI is not signed in'
          }
    )
  }
  return { at: Date.now(), providers }
}
