import { useSyncExternalStore } from 'react'
import type { RepoGroup, SessionHolder, SessionProvider } from '../../shared/types'
import { isSessionProvider, SESSION_PROVIDERS } from '../../shared/providers'
import { heldSessions } from './hold'

/**
 * Which agents' sessions the tree shows. A view preference for this machine, like the
 * holder filter (`hold.ts`), so it lives in localStorage rather than in config. Kept as
 * the agents *hidden*: an agent Cockpit starts reading later shows up without anyone
 * having to switch it on.
 */
const KEY = 'cockpit:hidden-agents'

const listeners = new Set<() => void>()
/** A choice storage refused to save — it still holds for this run. */
let unsaved: readonly SessionProvider[] | undefined
/** The last list read, kept while its stored text is the same: a snapshot must be stable. */
let cached: { readonly raw: string | null; readonly value: readonly SessionProvider[] } | null = null

const NONE: readonly SessionProvider[] = []

function read(): readonly SessionProvider[] {
  if (unsaved !== undefined) return unsaved
  let raw: string | null = null
  try {
    raw = window.localStorage.getItem(KEY)
  } catch {
    return NONE
  }
  if (cached && cached.raw === raw) return cached.value
  let value: readonly SessionProvider[] = NONE
  try {
    const parsed: unknown = raw === null ? [] : JSON.parse(raw)
    if (Array.isArray(parsed)) value = parsed.filter(isSessionProvider)
  } catch {
    /* an unreadable preference is no preference */
  }
  cached = { raw, value }
  return value
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** The agents the tree leaves out; empty when it shows them all. */
export function useHiddenAgents(): readonly SessionProvider[] {
  return useSyncExternalStore(subscribe, read)
}

function save(hidden: readonly SessionProvider[]): void {
  try {
    if (hidden.length === 0) window.localStorage.removeItem(KEY)
    else window.localStorage.setItem(KEY, JSON.stringify(hidden))
    unsaved = undefined
  } catch {
    unsaved = hidden
  }
  listeners.forEach((l) => l())
}

export function setAgentShown(agent: SessionProvider, shown: boolean): void {
  const hidden = read().filter((a) => a !== agent)
  save(shown ? hidden : [...hidden, agent])
}

export function showAllAgents(): void {
  save(NONE)
}

/** What a page query asks for: every agent but the hidden, or no narrowing at all. */
export function shownProviders(hidden: readonly SessionProvider[]): SessionProvider[] | undefined {
  return hidden.length === 0 ? undefined : SESSION_PROVIDERS.filter((p) => !hidden.includes(p))
}

/** How many of a project's active sessions both of the tree's filters let through. */
export function shownSessions(
  repo: RepoGroup,
  filters: { readonly holder: SessionHolder | null; readonly hidden: readonly SessionProvider[] }
): number {
  if (filters.hidden.length === 0) return heldSessions(repo, filters.holder)
  let n = 0
  for (const [agent, c] of Object.entries(repo.byProvider)) {
    if (!c || filters.hidden.includes(agent as SessionProvider)) continue
    n += filters.holder === 'cockpit' ? c.held : filters.holder === 'agent' ? c.sessions - c.held : c.sessions
  }
  return n
}

/** Every agent with a session among these projects, and how many each has — the popover's rows. */
export function agentCounts(
  repos: readonly RepoGroup[],
  holder: SessionHolder | null
): Array<{ readonly agent: SessionProvider; readonly count: number }> {
  const totals = new Map<SessionProvider, number>()
  for (const r of repos) {
    for (const [agent, c] of Object.entries(r.byProvider)) {
      if (!c) continue
      const n = holder === 'cockpit' ? c.held : holder === 'agent' ? c.sessions - c.held : c.sessions
      totals.set(agent as SessionProvider, (totals.get(agent as SessionProvider) ?? 0) + n)
    }
  }
  // in the one order every agent list uses: driven first, then the ones Cockpit reads
  return SESSION_PROVIDERS.filter((a) => totals.has(a)).map((agent) => ({ agent, count: totals.get(agent)! }))
}
