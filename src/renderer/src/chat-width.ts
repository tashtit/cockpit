import { storedValue } from './stored-value'

/**
 * The conversation column width — a per-user reading preference. On large
 * displays an unbounded transcript strands right-aligned user bubbles far from
 * the assistant's replies; the column keeps the exchange together, and the
 * user picks how wide it runs (Settings → Display).
 *
 * UI preference, not machine state → localStorage (`stored-value.ts`), like
 * cockpit:provider/mode.
 */
export type ChatWidth = 'narrow' | 'cozy' | 'wide' | 'full'

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

const width = storedValue<ChatWidth>('cockpit:chat-width', {
  parse: (raw) => (Object.hasOwn(CHAT_WIDTH_CSS, raw) ? (raw as ChatWidth) : undefined),
  serialize: (w) => w,
  fallback: 'cozy'
})

/** Live column preference — a Settings change re-renders the open chat. */
export function useChatWidth(): ChatWidth {
  return width.use()
}

export function setChatWidth(w: ChatWidth): void {
  width.set(w)
}

/** Tests only: re-read localStorage after a test cleared it. */
export function reloadChatWidth(): void {
  width.reload()
}
