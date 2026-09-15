import type { PrStatus } from '../shared/types'
import { execText } from './env'
import { PR_LIST_FIELDS, parsePrList } from './github-core'

const TTL_MS = 60_000

type CacheEntry = {
  readonly at: number
  readonly data: PrStatus[]
  readonly inflight: Promise<PrStatus[]> | null
}

const cache = new Map<string, CacheEntry>()

/**
 * PRs for a repo via the `gh` CLI, cached per repo root. Fails soft to [] —
 * no gh installed / not a GitHub repo / offline just means no badges.
 */
export function getPrs(repoRoot: string): Promise<PrStatus[]> {
  const entry = cache.get(repoRoot)
  const now = Date.now()
  if (entry && now - entry.at < TTL_MS) return entry.inflight ?? Promise.resolve(entry.data)
  if (entry?.inflight) return entry.inflight

  const inflight = fetchPrs(repoRoot).then((data) => {
    cache.set(repoRoot, { at: Date.now(), data, inflight: null })
    return data
  })
  cache.set(repoRoot, { at: now, data: entry?.data ?? [], inflight })
  return inflight
}

async function fetchPrs(repoRoot: string): Promise<PrStatus[]> {
  // fails soft: no gh, no auth, or not a GitHub remote just means no PR chips.
  // The rollup and review decision ride the same query, so a checks badge costs
  // no extra round trip — github-core folds them into one word each.
  const r = await execText(
    'gh',
    ['pr', 'list', '--state', 'all', '--limit', '100', '--json', PR_LIST_FIELDS],
    { cwd: repoRoot }
  )
  if (!r.ok) return []
  return parsePrList(r.stdout)
}
