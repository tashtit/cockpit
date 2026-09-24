import { useEffect, useState } from 'react'
import type { UpdateState } from '../../shared/types'
import { api } from './api'
import { useArmedConfirm } from './ConfirmRemove'

/**
 * What the sidebar's update bar has to tell you, if anything. Settings › About is
 * where the updater is managed; this is the part of it that reaches you wherever
 * you are — a newer Cockpit to fetch, one coming down, one waiting for a restart,
 * or one that could not be installed.
 */
export type UpdatePrompt =
  | { readonly kind: 'available'; readonly version: string }
  | { readonly kind: 'downloading'; readonly version: string; readonly percent: number }
  | { readonly kind: 'ready'; readonly version: string }
  | { readonly kind: 'failed'; readonly version?: string; readonly reason: string }

export function updatePrompt(s: UpdateState, prev: UpdatePrompt | null): UpdatePrompt | null {
  if (s.status === 'ready') return { kind: 'ready', version: s.version ?? '' }
  if (s.status === 'downloading') {
    return { kind: 'downloading', version: s.version ?? '', percent: s.percent ?? 0 }
  }
  // a rolled-back install holds every automatic step back until it has been looked
  // at, so the bar sends you to why rather than offering the same build again
  if (s.installFailure) return { kind: 'failed', reason: s.installFailure }
  switch (s.status) {
    case 'available':
      return { kind: 'available', version: s.version ?? '' }
    case 'error':
      // a download or restart that failed names the version it could not install;
      // a check that failed names none, and is not worth a bar — the next is hours off
      return s.version ? { kind: 'failed', version: s.version, reason: s.message ?? '' } : null
    case 'checking':
      // checks keep running with a build downloaded or on offer, and it is still
      // there while they do: a bar that blinked out every four hours would be noise
      return prev?.kind === 'ready' || prev?.kind === 'available' ? prev : null
    default:
      return null
  }
}

/** The bar's prompt, following every transition main pushes. */
export function useUpdatePrompt(): UpdatePrompt | null {
  const [prompt, setPrompt] = useState<UpdatePrompt | null>(null)
  useEffect(() => {
    let dead = false
    const follow = (s: UpdateState): void => {
      if (!dead) setPrompt((prev) => updatePrompt(s, prev))
    }
    void api.getUpdateState().then(follow, () => {})
    const off = api.onUpdateState(follow)
    return () => {
      dead = true
      off()
    }
  }, [])
  return prompt
}

/**
 * Restart into a downloaded build — in one click, unless Cockpit is running agent
 * turns, which the restart would stop. Main counts those (it knows every turn,
 * including the ones no session id names yet) and refuses the first click with the
 * number; the control then asks, and a second click restarts anyway. The ask backs
 * out on blur, Escape or a few seconds' wait, like every armed confirm here.
 */
export function useRestartToUpdate(): {
  /** The turns a restart would stop, while it waits for the second click */
  readonly armed: number | null
  readonly restart: () => void
  readonly disarm: () => void
} {
  // the armed slot holds the count: there is one restart, so nothing else to key on
  const confirm = useArmedConfirm()
  const restart = (): void => {
    const stopRunning = confirm.armed !== null
    confirm.disarm()
    api.installUpdate(stopRunning ? { stopRunning } : undefined).then(
      (out) => {
        if (!out.restarting && out.runningTurns) confirm.arm(String(out.runningTurns))
      },
      () => {}
    )
  }
  return {
    armed: confirm.armed === null ? null : Number(confirm.armed),
    restart,
    disarm: confirm.disarm
  }
}

/** "1 turn" / "3 turns" — what the armed restart says it will stop. */
export function turnsWord(n: number): string {
  return `${n} ${n === 1 ? 'turn' : 'turns'}`
}
