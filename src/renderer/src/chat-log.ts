import { useSyncExternalStore } from 'react'
import type { SessionMessage } from '../../shared/types'

/**
 * The open conversation: its transcript and the one line a screen reader hears.
 *
 * This is the app's hottest state — a streaming turn rewrites the last row ~25
 * times a second — so it lives here rather than in App. App only *writes* it
 * (stream events, sends, notices) and ChatView is the only reader, which keeps a
 * turn's stream out of the sidebar, the board and whatever view is on screen.
 * Same pattern as busy.ts and landed.ts.
 *
 * The status line is deliberately not derived from the transcript: a `role=status`
 * region that mirrors the last system row re-announces stale notices forever, so
 * every transition (turn start, end, failure, a notice) says its piece once, here.
 */

let messages: readonly SessionMessage[] = []
let status = ''
const listeners = new Set<() => void>()

/** Streamed text is batched so each stdout chunk doesn't rewrite the transcript. */
const FLUSH_MS = 40
let buffer = ''
let timer: ReturnType<typeof setTimeout> | null = null

function emit(): void {
  listeners.forEach((l) => l())
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Fold buffered text into the streaming row (starting one if the turn hasn't spoken yet). */
function applyBuffer(): void {
  const chunk = buffer
  if (!chunk) return
  buffer = ''
  const last = messages[messages.length - 1]
  messages =
    last && last.role === 'assistant' && last.kind === 'text' && last.streaming
      ? [...messages.slice(0, -1), { ...last, text: last.text + chunk }]
      : [...messages, { role: 'assistant', kind: 'text', text: chunk, streaming: true }]
}

function stopTimer(): void {
  if (timer) clearTimeout(timer)
  timer = null
}

/** Replace the whole transcript: opening a session, or starting a new one. */
export function setChatLog(next: readonly SessionMessage[]): void {
  stopTimer()
  buffer = ''
  messages = next
  status = ''
  emit()
}

/** Append one row. Buffered stream text lands first so the order is what happened. */
export function addChatMessage(m: SessionMessage): void {
  stopTimer()
  applyBuffer()
  messages = [...messages, m]
  emit()
}

/**
 * A system notice: in the transcript, and said once — now, when it happens.
 * `spoken` is for when the row and the announcement want different words.
 */
export function addChatNotice(text: string, spoken = text): void {
  addChatMessage({ role: 'system', kind: 'system', text })
  announceChat(spoken)
}

/** A chunk of the agent's reply. */
export function streamChatText(chunk: string): void {
  buffer += chunk
  if (!timer)
    timer = setTimeout(() => {
      timer = null
      applyBuffer()
      emit()
    }, FLUSH_MS)
}

/**
 * The turn is over. `keepText` false is a cancel: the killed turn's half-written
 * sentence never arrived, so it must not appear after the fact.
 */
export function endChatStream({ keepText }: { keepText: boolean }): void {
  stopTimer()
  if (keepText) applyBuffer()
  else buffer = ''
  if (messages.some((m) => m.streaming)) {
    // only the rows that were streaming: replacing every row's identity here would
    // re-render (and re-markdown) the whole memoized transcript at once
    messages = messages.map((m) => (m.streaming ? { ...m, streaming: false } : m))
  }
  emit()
}

/** What the `role=status` region says next. */
export function announceChat(text: string): void {
  if (status === text) return
  status = text
  emit()
}

/** The transcript — ChatView's only source for it. */
export function useChatLog(): readonly SessionMessage[] {
  return useSyncExternalStore(subscribe, () => messages)
}

/** The screen-reader status line for the open conversation. */
export function useChatStatus(): string {
  return useSyncExternalStore(subscribe, () => status)
}
