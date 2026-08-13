import type { PrStatus } from '../shared/types'
import { execText } from './env'

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
  // fails soft: no gh, no auth, or not a GitHub remote just means no PR chips
  const r = await execText(
    'gh',
    ['pr', 'list', '--state', 'all', '--limit', '100', '--json', 'number,title,state,isDraft,headRefName,url'],
    { cwd: repoRoot }
  )
  if (!r.ok) return []
  try {
    const arr = JSON.parse(r.stdout)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}
