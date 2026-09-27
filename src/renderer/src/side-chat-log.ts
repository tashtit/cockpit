import { useSyncExternalStore } from 'react'
import type { ChatEvent, SideChatRequest, SideExchange } from '../../shared/types'
import { api } from './api'
import { ipcErrorText } from './ipc-error'

/**
 * Side chat's threads: per session, what was asked on the side and what came back, for as
 * long as the window lives. Nothing here is the session's — each answer came from a
 * throwaway copy of it (main's `sideTurnRequest`), and a reload forgets the lot, as the
 * copies themselves are forgotten.
 *
 * A module store rather than panel state, so an answer still lands while the panel is
 * closed or another session is on screen, and a half-typed question survives Escape. Its
 * stream arrives on a channel of its own (`onSideChatEvent`), never the chat's.
 */

export type SideState = 'asking' | 'answered' | 'failed' | 'stopped'

export type SideEntry = {
  /** Minted here: what the panel renders the exchange under */
  readonly key: number
  readonly question: string
  /** Everything the copy said, its messages in order */
  readonly answer: string
  readonly state: SideState
  /** Why it failed, in main's words */
  readonly error?: string
  /** What the copy looked at to answer — each call's headline, in order */
  readonly looked: readonly SideLook[]
}

export type SideLook = { readonly tool: string; readonly what: string }

/** Which session a side chat is about — the binding, as a side question names it. */
export type SideTarget = Omit<SideChatRequest, 'question' | 'history'>

/** The key a session's thread lives under. */
export function sideKey(t: Pick<SideTarget, 'provider' | 'nativeSessionId'>): string {
  return `${t.provider}:${t.nativeSessionId}`
}

/** A question the store has handed main, known by its turn once main answers. */
type Flight = { readonly session: string; readonly key: number; turnId: string | null }

const NONE: readonly SideEntry[] = []
/** Calls a copy reads to answer are few; past this the list stops growing, the count doesn't matter */
const LOOKS_MAX = 40
/** Turns whose events beat askSideChat's reply, held until it lands */
const EARLY_MAX = 16

let threads: ReadonlyMap<string, readonly SideEntry[]> = new Map()
let drafts: ReadonlyMap<string, string> = new Map()
const flights = new Map<string, Flight>()
const early = new Map<string, ChatEvent[]>()
let nextKey = 0
const listeners = new Set<() => void>()

function emit(): void {
  listeners.forEach((l) => l())
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function patch(session: string, key: number, fn: (e: SideEntry) => SideEntry): void {
  const list = threads.get(session)
  if (!list) return
  const next = list.map((e) => (e.key === key ? fn(e) : e))
  threads = new Map(threads).set(session, next)
  emit()
}

function entryOf(f: Flight): SideEntry | undefined {
  return threads.get(f.session)?.find((e) => e.key === f.key)
}

function apply(f: Flight, ev: ChatEvent): void {
  // a question stopped, cleared or already over: whatever else its process says is the kill
  if (entryOf(f)?.state !== 'asking') return
  switch (ev.type) {
    case 'text':
      patch(f.session, f.key, (e) => ({ ...e, answer: e.answer ? `${e.answer}\n\n${ev.text}` : ev.text }))
      return
    case 'tool':
      patch(f.session, f.key, (e) =>
        e.looked.length >= LOOKS_MAX
          ? e
          : { ...e, looked: [...e.looked, { tool: ev.toolName, what: ev.preview ?? ev.detail }] }
      )
      return
    case 'error':
      patch(f.session, f.key, (e) => ({ ...e, error: e.error ? `${e.error}\n${ev.message}` : ev.message }))
      return
    case 'done':
      if (f.turnId) flights.delete(f.turnId)
      patch(f.session, f.key, (e) =>
        e.error || !e.answer.trim()
          ? { ...e, state: 'failed', error: e.error ?? 'No answer came back.' }
          : { ...e, state: 'answered' }
      )
      return
    default:
      // the copy's own session id, and permissions (a side question never runs over ACP)
      return
  }
}

function onEvent(ev: ChatEvent): void {
  const f = flights.get(ev.turnId)
  if (f) {
    apply(f, ev)
    return
  }
  // a turn that fails fast can speak before askSideChat resolves with its id
  const held = early.get(ev.turnId)
  if (held) held.push(ev)
  else {
    early.set(ev.turnId, [ev])
    if (early.size > EARLY_MAX) early.delete(early.keys().next().value as string)
  }
}

/** Follow main's side-chat stream; returns the unsubscribe (App's mount effect). */
export function initSideChat(): () => void {
  return api.onSideChatEvent(onEvent)
}

/** The exchanges a new question carries: the ones that were answered, oldest first. */
function historyOf(list: readonly SideEntry[]): SideExchange[] {
  return list.filter((e) => e.state === 'answered').map((e) => ({ question: e.question, answer: e.answer }))
}

export function isAsking(session: string): boolean {
  return (threads.get(session) ?? NONE).some((e) => e.state === 'asking')
}

/** Ask a copy of the session. One question at a time per session — main refuses a second. */
export function askSide(target: SideTarget, question: string): void {
  const session = sideKey(target)
  const q = question.trim()
  if (!q || isAsking(session)) return
  const list = threads.get(session) ?? NONE
  const key = nextKey++
  threads = new Map(threads).set(session, [...list, { key, question: q, answer: '', state: 'asking', looked: [] }])
  drafts = new Map(drafts).set(session, '')
  emit()
  const f: Flight = { session, key, turnId: null }
  api
    .askSideChat({ ...target, question: q, history: historyOf(list) })
    .then((turnId) => {
      if (entryOf(f)?.state !== 'asking') {
        // stopped or cleared before main said which turn it was: stop that turn now
        void api.cancelSideChat(turnId)
        return
      }
      f.turnId = turnId
      flights.set(turnId, f)
      const held = early.get(turnId)
      early.delete(turnId)
      for (const ev of held ?? []) apply(f, ev)
    })
    .catch((err: unknown) => {
      patch(session, key, (e) => (e.state === 'asking' ? { ...e, state: 'failed', error: ipcErrorText(err) } : e))
    })
}

/** Stop the question being answered, if there is one. */
export function stopSide(session: string): void {
  const asking = (threads.get(session) ?? NONE).find((e) => e.state === 'asking')
  if (!asking) return
  for (const [turnId, f] of flights) {
    if (f.session !== session || f.key !== asking.key) continue
    flights.delete(turnId)
    void api.cancelSideChat(turnId)
  }
  patch(session, asking.key, (e) => ({ ...e, state: 'stopped' }))
}

/** Start the side chat over: stop what runs, forget what was said. */
export function clearSide(session: string): void {
  stopSide(session)
  if (!threads.has(session)) return
  const next = new Map(threads)
  next.delete(session)
  threads = next
  emit()
}

export function setSideDraft(session: string, text: string): void {
  drafts = new Map(drafts).set(session, text)
  emit()
}

export function useSideThread(session: string | null): readonly SideEntry[] {
  return useSyncExternalStore(subscribe, () => (session ? (threads.get(session) ?? NONE) : NONE))
}

export function useSideDraft(session: string | null): string {
  return useSyncExternalStore(subscribe, () => (session ? (drafts.get(session) ?? '') : ''))
}

/** Tests: a window that never asked anything. */
export function resetSideChat(): void {
  threads = new Map()
  drafts = new Map()
  flights.clear()
  early.clear()
  emit()
}
