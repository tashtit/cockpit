import { resolve } from 'node:path'
import type {
  AttentionFocus,
  PanelKind,
  ProcessTarget,
  Provider,
  SessionMeta
} from '../../shared/types'
import { PROVIDERS, isProvider } from '../../shared/providers'
import type { SessionIndexer } from '../indexer'
import { defaultConfigHome, isUnder } from '../paths'
import { loadConfig } from '../config'
import { worktreesDir } from '../workspace'

/*
 * Renderer input is untrusted, whatever its TypeScript type says: the type does not
 * survive the bridge. Every handler shapes what it is handed through one of these
 * before it reaches a path, a spawned command or a config key — paths only ever
 * against roots main itself derived.
 */

/** An agent named by the renderer — it becomes a path segment or a spawned command, so only the three. */
export function asProvider(agent: unknown): Provider {
  if (!isProvider(agent)) throw new Error('unknown agent')
  return agent
}

const PANEL_KINDS: readonly PanelKind[] = ['mcp', 'skill', 'plugin', 'marketplace', 'instructions']

export function asPanelKind(kind: unknown): PanelKind {
  const found = PANEL_KINDS.find((k) => k === kind)
  if (!found) throw new Error('unknown panel kind')
  return found
}

/** A repo root the indexer itself derived — never an arbitrary renderer path. */
export function assertKnownRepoRoot(indexer: SessionIndexer, repoRoot: unknown): string {
  if (typeof repoRoot !== 'string') throw new Error('invalid repo root')
  const r = resolve(repoRoot)
  if (!indexer.knownRepoRoots().has(r)) throw new Error(`unknown repo root: ${r}`)
  return r
}

/**
 * A chat turn spawns an autonomous CLI agent in `cwd` — the renderer must only be
 * able to point it at directories the app itself derived: the app's worktrees, a
 * known repo root (or below), or the recorded cwd of an indexed session.
 */
export function assertKnownCwd(indexer: SessionIndexer, cwd: unknown): string {
  if (typeof cwd !== 'string') throw new Error('invalid working directory')
  const c = resolve(cwd)
  if (isUnder(c, worktreesDir())) return c
  if ([...indexer.knownRepoRoots()].some((r) => isUnder(c, r))) return c
  if (indexer.knownSessionCwds().has(c)) return c
  throw new Error(`unknown working directory: ${c}`)
}

/** Config homes are main-derived too: only a configured source (or the provider default). */
export function assertKnownConfigDir(configDir: unknown, provider: Provider): string {
  if (typeof configDir !== 'string') throw new Error('invalid config home')
  // `provider` is renderer input with a compile-time-only type — it is about to be
  // interpolated into a path, so re-check it here rather than trusting the caller
  if (!isProvider(provider)) throw new Error('unknown agent')
  const c = resolve(configDir)
  if (c === defaultConfigHome(provider)) return c
  const known = loadConfig().sources.some((s) => s.provider === provider && resolve(s.path) === c)
  if (!known) throw new Error(`unknown ${provider} config home: ${c}`)
  return c
}

/** An optional config home: absent stays absent (the provider's default), anything else is checked. */
export function optionalConfigDir(configDir: unknown, provider: Provider): string | undefined {
  return configDir === undefined || configDir === null ? undefined : assertKnownConfigDir(configDir, provider)
}

/** An indexed session named by the renderer — refused when the index doesn't know it. */
export function knownSession(indexer: SessionIndexer, id: unknown): SessionMeta {
  const sid = String(id)
  const s = sid.length > 256 ? null : indexer.getSession(sid)
  if (!s) throw new Error(`unknown session: ${sid.slice(0, 80)}`)
  // a seat's conversation is its table's: never taken over, released or resumed alone
  if (s.roundtableId) throw new Error('This session belongs to a roundtable — it is driven from the table.')
  return s
}

/** What the window shows is renderer input: only ever compared, never a path — but still shaped. */
export function asAttentionFocus(raw: unknown): AttentionFocus {
  const f = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  if (f['kind'] === 'roundtable' && typeof f['id'] === 'string') {
    return { kind: 'roundtable', id: f['id'].slice(0, 512) }
  }
  if (f['kind'] === 'cleanup') return { kind: 'cleanup' }
  const provider = PROVIDERS.find((p) => p === f['provider'])
  if (f['kind'] === 'session' && provider && typeof f['cwd'] === 'string') {
    return {
      kind: 'session',
      id: typeof f['id'] === 'string' ? f['id'].slice(0, 512) : null,
      provider,
      cwd: f['cwd'].slice(0, 4096)
    }
  }
  return { kind: 'none' }
}

/** Renderer id lists are untrusted and unbounded — cap and stringify them. */
export function asIdList(raw: unknown): string[] {
  return (Array.isArray(raw) ? raw : []).slice(0, 5000).map((v) => String(v))
}

/** Renderer process picks are untrusted too — cap them and keep only well-formed ones. */
export function asProcessTargets(raw: unknown): ProcessTarget[] {
  return (Array.isArray(raw) ? raw : []).slice(0, 5000).flatMap((v: unknown) => {
    const t = (v ?? {}) as Partial<Record<keyof ProcessTarget, unknown>>
    const pid = Number(t.pid)
    const startedAt = Number(t.startedAt)
    return Number.isInteger(pid) && pid > 0 && Number.isFinite(startedAt)
      ? [{ pid, startedAt, command: String(t.command ?? '') }]
      : []
  })
}
