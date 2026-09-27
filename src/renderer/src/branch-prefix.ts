import { useSyncExternalStore } from 'react'
import { DEFAULT_BRANCH_PREFIX } from '../../shared/branch-prefix'
import { api } from './api'

/**
 * Tiny shared store for the prefix new worktree branches get: the New session form
 * shows it before the name you type, and every branch pill dims it, so a subscription
 * beats drilling the value down the sidebar tree. Main owns the value (config
 * `branchPrefix`); this mirrors it, `cockpit/` until the first read lands.
 */
let prefix = DEFAULT_BRANCH_PREFIX
const listeners = new Set<() => void>()

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function publish(next: string): void {
  prefix = next
  listeners.forEach((l) => l())
}

/** Pull the saved prefix once at startup (App's mount effect), and again after a restore. */
export async function initBranchPrefix(): Promise<void> {
  publish(await api.getBranchPrefix())
}

/** The live prefix — a Settings change re-renders every subscribed pill and form. */
export function useBranchPrefix(): string {
  return useSyncExternalStore(subscribe, () => prefix)
}

/**
 * Save what the person typed. Main normalizes it (`titan` → `titan/`, '' → the default)
 * and refuses a name git would; resolves to the prefix now in force.
 */
export async function saveBranchPrefix(typed: string): Promise<string> {
  const saved = await api.setBranchPrefix(typed)
  publish(saved)
  return saved
}
