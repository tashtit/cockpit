import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeUsage, codexUsage, getUsage, parsePremiumRequests, premiumRequestsResetAt, throttled } from '../src/main/usage'

const root = mkdtempSync(join(tmpdir(), 'cockpit-usage-fixtures-'))
const claudeHome = join(root, 'claude')
const codexHome = join(root, 'codex')

/** The fixed "now" all claude assertions are relative to. */
const NOW = Date.parse('2026-08-10T12:30:00Z')

function claudeEntry(
  ts: string,
  requestId: string,
  usage: { in: number; out: number; cr?: number; cc?: number }
): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: ts,
    requestId,
    message: {
      id: `msg-${requestId}`,
      usage: {
        input_tokens: usage.in,
        output_tokens: usage.out,
        cache_read_input_tokens: usage.cr ?? 0,
        cache_creation_input_tokens: usage.cc ?? 0
      }
    }
  })
}

function codexRateLimitLine(ts: string, rateLimits: unknown): string {
  return JSON.stringify({
    timestamp: ts,
    type: 'event_msg',
    payload: { type: 'token_count', rate_limits: rateLimits }
  })
}

beforeAll(() => {
  rmSync(root, { recursive: true, force: true })

  // --- claude: one project log spanning idle gaps, duplicates, and stale entries ---
  const proj = join(claudeHome, 'projects', '-Users-me-dev-app')
  mkdirSync(proj, { recursive: true })
  const dup = claudeEntry('2026-08-10T11:10:00Z', 'r1', { in: 100, out: 50, cr: 10, cc: 5 })
  writeFileSync(
    join(proj, 'session-a.jsonl'),
    [
      // older than the trailing week — must not count anywhere
      claudeEntry('2026-08-02T12:00:00Z', 'r0', { in: 9999, out: 9999 }),
      // same-day activity, but >5h before the current block — 7d only
      claudeEntry('2026-08-10T03:00:00Z', 'r3', { in: 1000, out: 400 }),
      // streamed entry logged three times with the same requestId — counts once
      dup,
      dup,
      dup,
      claudeEntry('2026-08-10T12:05:00Z', 'r2', { in: 200, out: 100 }),
      '{ corrupt line',
      JSON.stringify({ type: 'user', timestamp: '2026-08-10T12:06:00Z' })
    ].join('\n') + '\n'
  )

  // --- codex: newest rollout has no rate limits; older one has two snapshots ---
  const day = join(codexHome, 'sessions', '2026', '08', '10')
  mkdirSync(day, { recursive: true })
  const withLimits = join(day, 'rollout-a.jsonl')
  writeFileSync(
    withLimits,
    [
      codexRateLimitLine('2026-08-10T09:00:00Z', {
        primary: { used_percent: 12, window_minutes: 10080, resets_at: 1786886287 },
        secondary: null,
        plan_type: 'plus'
      }),
      // the LAST snapshot in the file must win
      codexRateLimitLine('2026-08-10T10:00:00Z', {
        primary: { used_percent: 26, window_minutes: 10080, resets_at: 1786886287 },
        secondary: { used_percent: 40, window_minutes: 300, resets_at: 1754824000 },
        plan_type: 'plus'
      })
    ].join('\n') + '\n'
  )
  const noLimits = join(day, 'rollout-b.jsonl')
  writeFileSync(noLimits, JSON.stringify({ timestamp: '2026-08-10T11:00:00Z', type: 'event_msg', payload: { type: 'agent_message' } }) + '\n')
  // rollout-b is newer — codexUsage must fall back to rollout-a
  utimesSync(withLimits, new Date(NOW - 7_200_000), new Date(NOW - 7_200_000))
  utimesSync(noLimits, new Date(NOW - 3_600_000), new Date(NOW - 3_600_000))
})

describe('claudeUsage', () => {
  it('measures the current 5h block and the trailing 7 days from session logs', async () => {
    const [block, week] = await claudeUsage(claudeHome, NOW)

    expect(block.label).toBe('current 5h block')
    // r1 (deduped) + r2; the 03:00 activity opened an earlier, expired block
    expect(block.requests).toBe(2)
    expect(block.tokens).toEqual({ input: 300, output: 150, cacheRead: 10, cacheCreate: 5 })
    // block started at the 11:00 hour → resets at 16:00
    expect(block.resetsAt).toBe(Date.parse('2026-08-10T16:00:00Z'))

    expect(week.label).toBe('last 7 days')
    expect(week.requests).toBe(3)
    expect(week.tokens).toEqual({ input: 1300, output: 550, cacheRead: 10, cacheCreate: 5 })
    expect(week.resetsAt).toBeUndefined()
  })

  it('reports an idle block once 5h have passed since the block started', async () => {
    const later = Date.parse('2026-08-10T18:00:00Z')
    const [block, week] = await claudeUsage(claudeHome, later)
    expect(block.requests).toBe(0)
    expect(block.tokens).toEqual({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0 })
    expect(block.resetsAt).toBeUndefined()
    expect(week.requests).toBe(3)
  })

  it('returns zeroed windows for a home with no session logs', async () => {
    const empty = join(root, 'claude-empty')
    mkdirSync(empty, { recursive: true })
    const [block, week] = await claudeUsage(empty, NOW)
    expect(block.requests).toBe(0)
    expect(week.requests).toBe(0)
  })
})

describe('claudeUsage on a log being written', () => {
  let homes = 0
  /** A home of its own for `content`, so its log is read once, from byte 0. */
  function home(content: string): { dir: string; log: string } {
    const dir = join(root, `claude-grow-${++homes}`)
    const proj = join(dir, 'projects', '-Users-me-dev-app')
    mkdirSync(proj, { recursive: true })
    const log = join(proj, 'session.jsonl')
    writeFileSync(log, content)
    return { dir, log }
  }
  const fresh = (content: string) => claudeUsage(home(content).dir, NOW)
  const anonymous = (ts: string, tokens: number) =>
    JSON.stringify({ type: 'assistant', timestamp: ts, message: { usage: { input_tokens: tokens, output_tokens: 1 } } })

  const first = [
    claudeEntry('2026-08-10T11:10:00Z', 'r1', { in: 100, out: 50 }),
    // streamed: r2 is written again below with its final totals
    claudeEntry('2026-08-10T12:01:00Z', 'r2', { in: 10, out: 1 }),
    anonymous('2026-08-10T12:02:00Z', 7)
  ].join('\n') + '\n'
  const more = [
    claudeEntry('2026-08-10T12:01:00Z', 'r2', { in: 10, out: 90 }),
    anonymous('2026-08-10T12:03:00Z', 3)
  ].join('\n') + '\n'
  const lastLine = claudeEntry('2026-08-10T12:04:00Z', 'r3', { in: 1, out: 2, cr: 3, cc: 4 }) + '\n'

  it('gives the same totals as a fresh read after every append, a half-written line included', async () => {
    const { dir, log } = home(first)
    expect(await claudeUsage(dir, NOW)).toEqual(await fresh(first))

    appendFileSync(log, more)
    const grown = await claudeUsage(dir, NOW)
    expect(grown).toEqual(await fresh(first + more))
    // r2 once, with its final output; both anonymous entries
    expect(grown[0].requests).toBe(4)
    expect(grown[0].tokens).toEqual({ input: 120, output: 142, cacheRead: 0, cacheCreate: 0 })

    // mid-write, cut anywhere: half a line counts for nothing, a whole one still without
    // its line break counts as it stands — and neither counts twice once it is finished
    const entry = lastLine.trimEnd()
    appendFileSync(log, entry.slice(0, 80))
    expect(await claudeUsage(dir, NOW)).toEqual(await fresh(first + more + entry.slice(0, 80)))
    appendFileSync(log, entry.slice(80))
    const whole = await claudeUsage(dir, NOW)
    expect(whole).toEqual(await fresh(first + more + entry))
    expect(whole[0].requests).toBe(5)
    appendFileSync(log, '\n')
    expect(await claudeUsage(dir, NOW)).toEqual(whole)

    const unnamed = anonymous('2026-08-10T12:05:00Z', 5)
    appendFileSync(log, unnamed)
    expect((await claudeUsage(dir, NOW))[0].requests).toBe(6)
    appendFileSync(log, '\n')
    const done = await claudeUsage(dir, NOW)
    expect(done).toEqual(await fresh(first + more + lastLine + unnamed + '\n'))
    expect(done[0].requests).toBe(6)
  })

  it('reads on from where it stopped rather than from byte 0', async () => {
    const { dir, log } = home(first)
    await claudeUsage(dir, NOW)
    // rewrite r2's already-read line in place (same length, past the head), then
    // append: an append-only reader never looks back at it
    const at = first.indexOf('"output_tokens":1,')
    expect(at).toBeGreaterThan(256)
    const fd = openSync(log, 'r+')
    writeSync(fd, '"output_tokens":9,', at)
    closeSync(fd)
    appendFileSync(log, lastLine)
    const [block] = await claudeUsage(dir, NOW)
    expect(block.tokens?.output).toBe(50 + 1 + 1 + 2)
  })

  it('starts over when the log is cut short, rewritten in place or replaced', async () => {
    const { dir, log } = home(first + more)
    await claudeUsage(dir, NOW)

    writeFileSync(log, first)
    expect(await claudeUsage(dir, NOW)).toEqual(await fresh(first))

    // same inode, longer than before, but not the same log
    const other = [lastLine, more, more].join('')
    writeFileSync(log, other)
    expect(await claudeUsage(dir, NOW)).toEqual(await fresh(other))

    const tmp = `${log}.tmp`
    writeFileSync(tmp, first + more + lastLine)
    renameSync(tmp, log)
    expect(await claudeUsage(dir, NOW)).toEqual(await fresh(first + more + lastLine))
  })

  it('reads a log that went quiet from the start once it grows again', async () => {
    const { dir, log } = home(first)
    // quiet for longer than it stays resumable: only its totals are kept
    utimesSync(log, new Date(NOW - 7_200_000), new Date(NOW - 7_200_000))
    expect(await claudeUsage(dir, NOW)).toEqual(await fresh(first))
    appendFileSync(log, more)
    expect(await claudeUsage(dir, NOW)).toEqual(await fresh(first + more))
  })
})

describe('codexUsage', () => {
  it('reads the last provider-reported rate-limit snapshot from recent rollouts', () => {
    const snap = codexUsage(codexHome)
    expect(snap).not.toBeNull()
    expect(snap!.plan).toBe('plus')
    expect(snap!.windows).toEqual([
      {
        label: 'weekly window',
        usedPercent: 26,
        resetsAt: 1786886287_000
      },
      {
        label: '5h window',
        usedPercent: 40,
        resetsAt: 1754824000_000
      }
    ])
  })

  it('returns null when no rollout carries rate limits', () => {
    const empty = join(root, 'codex-empty')
    mkdirSync(join(empty, 'sessions'), { recursive: true })
    expect(codexUsage(empty)).toBeNull()
  })
})

describe('parsePremiumRequests', () => {
  it('sums gross and billed quantities across usage items', () => {
    expect(
      parsePremiumRequests({
        usageItems: [
          { product: 'copilot', sku: 'copilot_premium_requests', grossQuantity: 100.5, netQuantity: 0 },
          { product: 'copilot', sku: 'copilot_premium_requests', grossQuantity: 50, netQuantity: 12.4 }
        ]
      })
    ).toEqual({ requests: 150.5, requestsBilled: 12 })
  })

  it('resets on the first of the next month, 00:00 UTC — across a year end too', () => {
    expect(premiumRequestsResetAt(Date.UTC(2026, 8, 22, 13, 0))).toBe(Date.UTC(2026, 9, 1))
    expect(premiumRequestsResetAt(Date.UTC(2026, 11, 31, 23, 59))).toBe(Date.UTC(2027, 0, 1))
    // measured on the first itself: the reset is the next one, never the moment itself
    expect(premiumRequestsResetAt(Date.UTC(2026, 9, 1, 0, 0))).toBe(Date.UTC(2026, 10, 1))
  })

  it('rejects reports without a usageItems array', () => {
    expect(parsePremiumRequests({})).toBeNull()
    expect(parsePremiumRequests(null)).toBeNull()
    expect(parsePremiumRequests('nope')).toBeNull()
  })
})

describe('throttled', () => {
  it('remembers a result for the TTL and coalesces concurrent calls into one run', async () => {
    let now = 1_000
    let runs = 0
    const get = throttled(
      60_000,
      async () => {
        runs++
        return { runs }
      },
      () => now
    )
    const [a, b] = await Promise.all([get(), get()])
    expect(runs).toBe(1)
    expect(a).toBe(b)
    now += 59_999
    expect(await get()).toBe(a)
    expect(runs).toBe(1)
    now += 1
    const c = await get()
    expect(runs).toBe(2)
    expect(c).not.toBe(a)
  })

  it('does not remember a failed run — the next call tries again', async () => {
    let fail = true
    let runs = 0
    const get = throttled(60_000, async () => {
      runs++
      if (fail) throw new Error('gh failed')
      return 'ok'
    })
    await expect(get()).rejects.toThrow('gh failed')
    fail = false
    expect(await get()).toBe('ok')
    expect(await get()).toBe('ok')
    expect(runs).toBe(2)
  })
})

describe('getUsage', () => {
  it('measures the local homes and hands bursts of calls the same snapshot', async () => {
    const sources = [
      { provider: 'claude' as const, path: claudeHome, label: 'claude' },
      { provider: 'codex' as const, path: codexHome, label: 'codex' },
      // never walked: the copilot path has nothing local to measure, and without a
      // copilot source the snapshot never reaches for gh at all
      { provider: 'copilot' as const, path: join(root, 'missing-copilot'), label: 'copilot' }
    ]
    const first = await getUsage(sources)
    expect(first.providers.map((p) => p.provider)).toEqual(['claude', 'codex'])
    expect(first.providers[0].windows.map((w) => w.label)).toEqual(['current 5h block', 'last 7 days'])
    expect(first.providers[1].windows.map((w) => w.label).sort()).toEqual(['5h window', 'weekly window'])
    // the sidebar re-asks on every busy-set change — those land on the cached snapshot
    expect(await getUsage(sources)).toBe(first)
  })
})

afterAll(() => rmSync(root, { recursive: true, force: true }))
