import { useSyncExternalStore } from 'react'

/**
 * How a diff reads — one column with removals over additions, or the two texts
 * side by side. A reading preference, not machine state → localStorage, like the
 * chat column width; one choice, shared by every diff surface in the app.
 */
export type DiffLayout = 'unified' | 'split'

const KEY = 'cockpit:diff-layout'
const DEFAULT: DiffLayout = 'unified'

export const DIFF_LAYOUT_LABEL: Record<DiffLayout, string> = {
  unified: 'Unified',
  split: 'Split'
}

export const DIFF_LAYOUTS: readonly DiffLayout[] = ['unified', 'split']

function load(): DiffLayout {
  try {
    const v = window.localStorage.getItem(KEY)
    return v === 'split' || v === 'unified' ? v : DEFAULT
  } catch {
    return DEFAULT
  }
}

let layout: DiffLayout = load()
const listeners = new Set<() => void>()

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Live layout preference — flipping it in one diff re-lays every open diff. */
export function useDiffLayout(): DiffLayout {
  return useSyncExternalStore(subscribe, () => layout)
}

export function setDiffLayout(l: DiffLayout): void {
  layout = l
  try {
    window.localStorage.setItem(KEY, l)
  } catch {
    // a blocked store only loses the memory of the choice, never the choice itself
  }
  listeners.forEach((fn) => fn())
}

/** Tests only: re-read localStorage after a test cleared it. */
export function reloadDiffLayout(): void {
  layout = load()
  listeners.forEach((fn) => fn())
}
