import type { RepoGroup, SessionHolder, SessionProvider } from '../../shared/types'
import { isSessionProvider, SESSION_PROVIDERS } from '../../shared/providers'
import { heldSessions } from './hold'
import { storedValue } from './stored-value'

/**
 * Which agents' sessions the tree shows. A view preference for this machine, like the
 * holder filter (`hold.ts`), so it lives in localStorage (`stored-value.ts`) rather than
 * in config. Kept as the agents *hidden*: an agent Cockpit starts reading later shows up
 * without anyone having to switch it on.
 */
const NONE: readonly SessionProvider[] = []

const hiddenAgents = storedValue<readonly SessionProvider[]>('cockpit:hidden-agents', {
  parse: (raw) => {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isSessionProvider) : undefined
  },
  serialize: (hidden) => (hidden.length === 0 ? null : JSON.stringify(hidden)),
  fallback: NONE
})

/** The agents the tree leaves out; empty when it shows them all. */
export function useHiddenAgents(): readonly SessionProvider[] {
  return hiddenAgents.use()
}

export function setAgentShown(agent: SessionProvider, shown: boolean): void {
  const hidden = hiddenAgents.get().filter((a) => a !== agent)
  hiddenAgents.set(shown ? hidden : [...hidden, agent])
}

export function showAllAgents(): void {
  hiddenAgents.set(NONE)
}

/** Tests only: drop what this run holds and read storage again. */
export function reloadHiddenAgents(): void {
  hiddenAgents.reload()
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
