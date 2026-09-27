import { useSyncExternalStore } from 'react'
import type { AcpReadiness, SessionProvider } from '../../shared/types'
import { DRIVABLE_PROVIDERS, isDrivable, READ_ONLY_PROVIDERS } from '../../shared/providers'
import { api } from './api'

/**
 * Which agents a session can be started or continued with right now, as main last said
 * (`acp:readiness`, pushed as `acp-readiness`). The three CLIs Cockpit runs are always
 * in it; an agent it otherwise only reads joins once an ACP agent answers for it — a
 * built-in whose CLI passed the handshake, or one the person defined — and leaves when
 * that one is removed. Until main answers, only the three are: a form never offers an
 * agent that cannot run.
 */
const INITIAL: AcpReadiness = { drivable: DRIVABLE_PROVIDERS, builtinsReady: [] }

let current: AcpReadiness = INITIAL
const listeners = new Set<() => void>()

function set(next: AcpReadiness): void {
  current = next
  listeners.forEach((l) => l())
}

/**
 * Seed from main and follow its pushes; returns the unsubscribe (App's mount effect).
 * Asking also has main re-probe a built-in that has not answered yet (at most once a
 * minute), so a CLI installed since launch is found — the forms that pick an agent ask
 * again when they open (`refreshAcpReadiness`).
 */
export function initAcpReadiness(): () => void {
  // a push that beats the seed is newer than it — the seed must not overwrite it
  let pushed = false
  // optional calls: a preload from before these methods must not take a view down (dev HMR)
  void api
    .getAcpReadiness?.()
    .then((r) => {
      if (!pushed) set(r)
    })
    .catch(() => {})
  const off = api.onAcpReadiness?.((r) => {
    pushed = true
    set(r)
  })
  return off ?? (() => {})
}

/** Ask again — a form that picks an agent, on opening. The answer, or a probe it starts, arrives as usual. */
export function refreshAcpReadiness(): void {
  void api
    .getAcpReadiness?.()
    .then(set)
    .catch(() => {})
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

const snapshot = (): AcpReadiness => current

export function useAcpReadiness(): AcpReadiness {
  return useSyncExternalStore(subscribe, snapshot)
}

/** The agents a session can be started or continued with right now. */
export function useDrivableAgents(): readonly SessionProvider[] {
  return useAcpReadiness().drivable
}

/** Whether a session of this agent can be sent a turn from Cockpit right now. */
export function canDrive(provider: SessionProvider, drivable: readonly SessionProvider[]): boolean {
  return isDrivable(provider) || drivable.includes(provider)
}

/** Every agent a form may offer: the three CLIs, then the ones an ACP agent drives, in the one agent order. */
export function startableAgents(drivable: readonly SessionProvider[]): SessionProvider[] {
  return [...DRIVABLE_PROVIDERS, ...READ_ONLY_PROVIDERS.filter((p) => drivable.includes(p))]
}

/** What the store holds now, for a callback that must not re-render on it. */
export function drivableNow(): readonly SessionProvider[] {
  return current.drivable
}

/** Test seam: forget what main said, so each test starts from the three CLIs. */
export function clearAcpReadiness(): void {
  set(INITIAL)
}
