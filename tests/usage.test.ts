import { beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeUsage, codexUsage, parsePremiumRequests } from '../src/main/usage'

const root = join(tmpdir(), 'cockpit-usage-fixtures')
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

  it('rejects reports without a usageItems array', () => {
    expect(parsePremiumRequests({})).toBeNull()
    expect(parsePremiumRequests(null)).toBeNull()
    expect(parsePremiumRequests('nope')).toBeNull()
  })
})
