import { useSyncExternalStore } from 'react'

/**
 * The conversation column width — a per-user reading preference. On large
 * displays an unbounded transcript strands right-aligned user bubbles far from
 * the assistant's replies; the column keeps the exchange together, and the
 * user picks how wide it runs (Settings → Display).
 *
 * UI preference, not machine state → localStorage, like cockpit:provider/mode.
 */
export type ChatWidth = 'narrow' | 'cozy' | 'wide' | 'full'

const KEY = 'cockpit:chat-width'
const DEFAULT: ChatWidth = 'cozy'

/** CSS value each preference maps to ('100%' = no column, edge-to-edge). */
export const CHAT_WIDTH_CSS: Record<ChatWidth, string> = {
  narrow: '680px',
  cozy: '860px',
  wide: '1120px',
  full: '100%'
}

export const CHAT_WIDTH_OPTIONS: ReadonlyArray<{ value: ChatWidth; label: string; hint: string }> = [
  { value: 'narrow', label: 'Narrow', hint: '680px' },
  { value: 'cozy', label: 'Comfortable', hint: '860px' },
  { value: 'wide', label: 'Wide', hint: '1120px' },
  { value: 'full', label: 'Full width', hint: 'no limit' }
]

/**
 * Guarded like rail.ts: this runs when the module loads, before any error boundary
 * exists, so storage refusing access would leave a blank window rather than a
 * default width.
 */
function load(): ChatWidth {
  let v: string | null = null
  try {
    v = window.localStorage.getItem(KEY)
  } catch {
    // storage unavailable — the default is a fine width
  }
  return v && v in CHAT_WIDTH_CSS ? (v as ChatWidth) : DEFAULT
}

let width: ChatWidth = load()
const listeners = new Set<() => void>()

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Live column preference — a Settings change re-renders the open chat. */
export function useChatWidth(): ChatWidth {
  return useSyncExternalStore(subscribe, () => width)
}

export function setChatWidth(w: ChatWidth): void {
  width = w
  try {
    window.localStorage.setItem(KEY, w)
  } catch {
    // not remembered past this run — the open chat still takes the width
  }
  listeners.forEach((l) => l())
}

/** Tests only: re-read localStorage after a test cleared it. */
export function reloadChatWidth(): void {
  width = load()
  listeners.forEach((l) => l())
}
