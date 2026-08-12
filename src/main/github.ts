import { execFile } from 'node:child_process'
import type { PrStatus } from '../shared/types'
import { cliEnv } from './env'

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

function fetchPrs(repoRoot: string): Promise<PrStatus[]> {
  return new Promise((res) => {
    execFile(
      'gh',
      [
        'pr', 'list',
        '--state', 'all',
        '--limit', '100',
        '--json', 'number,title,state,isDraft,headRefName,url'
      ],
      { cwd: repoRoot, env: cliEnv(), timeout: 15_000 },
      (err, stdout) => {
        if (err) return res([])
        try {
          const arr = JSON.parse(stdout)
          res(Array.isArray(arr) ? arr : [])
        } catch {
          res([])
        }
      }
    )
  })
}
