import { useSyncExternalStore } from 'react'
import type { AcpReadiness, SessionProvider } from '../../shared/types'
import { acpCanReopen } from '../../shared/acp'
import { isDrivable, PROVIDERS, READ_ONLY_PROVIDERS } from '../../shared/providers'
import { api } from './api'
import { seedThenFollow } from './seed-then-follow'
import { subscribers } from './subscribers'

/**
 * Which agents a session can be started or continued with right now, as main last said
 * (`acp:readiness`, pushed as `acp-readiness`). The three CLIs Cockpit runs are always
 * in it; an agent it otherwise only reads joins once an ACP agent answers for it — a
 * built-in whose CLI passed the handshake, or one the person defined — and leaves when
 * that one is removed. Until main answers, only the three are: a form never offers an
 * agent that cannot run.
 */
const INITIAL: AcpReadiness = { drivable: PROVIDERS, builtinsReady: [] }

let current: AcpReadiness = INITIAL
const changes = subscribers()

function set(next: AcpReadiness): void {
  current = next
  changes.notify()
}

/**
 * Seed from main and follow its pushes; returns the unsubscribe (App's mount effect).
 * Asking also has main re-probe a built-in that has not answered yet (at most once a
 * minute), so a CLI installed since launch is found — the forms that pick an agent, and
 * Settings' list of ACP agents, ask again when they open (`refreshAcpReadiness`).
 */
export function initAcpReadiness(): () => void {
  // optional calls: a preload from before these methods must not take a view down (dev HMR)
  if (!api.getAcpReadiness || !api.onAcpReadiness) return () => {}
  return seedThenFollow(api.getAcpReadiness, api.onAcpReadiness, set)
}

/**
 * Ask again — a form that picks an agent, on opening. The answer, or a probe it starts,
 * arrives as usual. `recheck` re-probes every built-in, so one whose CLI has gone stops
 * being offered (Settings' Check again).
 */
export function refreshAcpReadiness(opts?: { readonly recheck?: boolean }): void {
  void api
    .getAcpReadiness?.(opts)
    .then(set)
    .catch(() => {})
}

const snapshot = (): AcpReadiness => current

export function useAcpReadiness(): AcpReadiness {
  return useSyncExternalStore(changes.subscribe, snapshot)
}

/** The agents a session can be started or continued with right now. */
export function useDrivableAgents(): readonly SessionProvider[] {
  return useAcpReadiness().drivable
}

/** Whether a session of this agent can be sent a turn from Cockpit right now. */
export function canDrive(provider: SessionProvider, drivable: readonly SessionProvider[]): boolean {
  return isDrivable(provider) || drivable.includes(provider)
}

/**
 * Whether this session can: its agent can be driven, and the ACP server that drives it
 * keeps the session (`acpCanReopen` — an editor's Cursor chat or Cline task it can't).
 */
export function canContinue(
  session: { readonly provider: SessionProvider; readonly sourcePath?: string },
  drivable: readonly SessionProvider[]
): boolean {
  return canDrive(session.provider, drivable) && acpCanReopen(session)
}

/** Every agent a form may offer: the three CLIs, then the ones an ACP agent drives, in the one agent order. */
export function startableAgents(drivable: readonly SessionProvider[]): SessionProvider[] {
  return [...PROVIDERS, ...READ_ONLY_PROVIDERS.filter((p) => drivable.includes(p))]
}

/** What the store holds now, for a callback that must not re-render on it. */
export function drivableNow(): readonly SessionProvider[] {
  return current.drivable
}

/** Test seam: forget what main said, so each test starts from the three CLIs. */
export function clearAcpReadiness(): void {
  set(INITIAL)
}
