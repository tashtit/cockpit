import { useSyncExternalStore } from 'react'
import type { SessionMessage } from '../../shared/types'
import { samePlain } from './same'

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
 *
 * Every row carries a key minted here, which is what the transcript renders it under
 * and what a search anchor and the Work panel name it by. A log read fresh is keyed by
 * offset; a row appended or streamed into keeps or takes the next one; a log read
 * again from disk keeps the key of every row it shares with the one on screen
 * (`reconcileLog`). Messages carry no id of their own, and an offset is not one: once a
 * session's log outgrows the tail main reads, each read starts further in.
 */

/** The rows on screen and the key each renders under, index for index. */
export type ChatRows = {
  readonly messages: readonly SessionMessage[]
  readonly keys: readonly number[]
}

let messages: readonly SessionMessage[] = []
let keys: readonly number[] = []
/** The key the next new row takes — never one a row on screen has had. */
let nextKey = 0
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

function append(m: SessionMessage): void {
  messages = [...messages, m]
  keys = [...keys, nextKey++]
}

/** Fold buffered text into the streaming row (starting one if the turn hasn't spoken yet). */
function applyBuffer(): void {
  const chunk = buffer
  if (!chunk) return
  buffer = ''
  const last = messages[messages.length - 1]
  // the row being streamed into keeps its key: it is the same message, longer
  if (last && last.role === 'assistant' && last.kind === 'text' && last.streaming)
    messages = [...messages.slice(0, -1), { ...last, text: last.text + chunk }]
  else append({ role: 'assistant', kind: 'text', text: chunk, streaming: true })
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
  keys = next.map((_, i) => i)
  nextKey = next.length
  status = ''
  emit()
}

/**
 * The open conversation read again from disk, as its log grows under the view (a
 * session run in a terminal, re-read on each index push). Every row it shares with the
 * transcript on screen keeps its object and its key, so a memoized row that did not
 * change is not drawn again — and one that did change, or was dropped off the front of
 * a log past main's tail window, never hands its key (and whatever the reader opened on
 * it) to a different message.
 */
export function refreshChatLog(next: readonly SessionMessage[]): void {
  stopTimer()
  buffer = ''
  const rows = reconcileLog({ messages, keys }, next, nextKey)
  // as a fresh read does, the re-read clears the last announcement — but a read that
  // changed nothing, with nothing left to clear, is not an update at all
  if (rows.messages === messages && status === '') return
  messages = rows.messages
  keys = rows.keys
  nextKey = rows.nextKey
  status = ''
  emit()
}

/** The identity of a row's place in the log — what an in-place rewrite of it keeps. */
const sameSlot = (a: SessionMessage, b: SessionMessage): boolean =>
  a.role === b.role && a.kind === b.kind && a.toolName === b.toolName && a.ts === b.ts

/** A cheap first test before a full compare: rows that differ here cannot be the same. */
const signature = (m: SessionMessage): string =>
  `${m.role}\u0000${m.kind}\u0000${m.toolName ?? ''}\u0000${m.ts ?? ''}\u0000${m.text.length}\u0000${m.text.slice(0, 48)}`

/**
 * Line a new read of the log up against the rows on screen. Each new row takes the
 * first old row at or after the last match that says exactly the same thing — its
 * object and its key — so rows a longer log pushed off the front are passed over, and
 * the order on screen stays the order read. A row with no match that sits where the
 * next old row did, the same record rewritten (a call marked failed once its result is
 * read), keeps that row's key with its new content; anything else is new and takes a
 * new key. When every row matched in place, the old rows come back as they were, so
 * the store can tell nothing changed.
 */
export function reconcileLog(
  prev: ChatRows,
  next: readonly SessionMessage[],
  firstKey: number
): ChatRows & { readonly nextKey: number } {
  const old = prev.messages
  // every old row by signature, in order; the cursor per signature only moves forward
  const bySig = new Map<string, { readonly at: number[]; next: number }>()
  old.forEach((m, i) => {
    const s = signature(m)
    const hit = bySig.get(s)
    if (hit) hit.at.push(i)
    else bySig.set(s, { at: [i], next: 0 })
  })
  const matchOf = (m: SessionMessage, from: number): number => {
    const list = bySig.get(signature(m))
    if (!list) return -1
    while (list.next < list.at.length && list.at[list.next]! < from) list.next++
    for (let c = list.next; c < list.at.length; c++) {
      const i = list.at[c]!
      if (samePlain(old[i], m)) return i
    }
    return -1
  }

  const rows: SessionMessage[] = []
  const rowKeys: number[] = []
  let key = firstKey
  let from = 0
  let unchanged = next.length === old.length
  next.forEach((m, j) => {
    const i = matchOf(m, from)
    if (i >= 0) {
      rows.push(old[i]!)
      rowKeys.push(prev.keys[i]!)
      if (i !== j) unchanged = false
      from = i + 1
      return
    }
    unchanged = false
    const here = old[from]
    // rewritten in place, unless the old row is still coming (then this one was inserted)
    const rewritten = here !== undefined && sameSlot(here, m) && !(j + 1 < next.length && samePlain(here, next[j + 1]))
    rows.push(m)
    if (rewritten) {
      rowKeys.push(prev.keys[from]!)
      from++
    } else rowKeys.push(key++)
  })
  if (unchanged) return { messages: old, keys: prev.keys, nextKey: firstKey }
  return { messages: rows, keys: rowKeys, nextKey: key }
}

/** Append one row. Buffered stream text lands first so the order is what happened. */
export function addChatMessage(m: SessionMessage): void {
  stopTimer()
  applyBuffer()
  append(m)
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

/** Each row's key, index for index with `useChatLog` — they always change together. */
export function useChatKeys(): readonly number[] {
  return useSyncExternalStore(subscribe, () => keys)
}

/** The screen-reader status line for the open conversation. */
export function useChatStatus(): string {
  return useSyncExternalStore(subscribe, () => status)
}
