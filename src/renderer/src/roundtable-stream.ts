import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type {
  RoundtableEntry,
  RoundtableEvent,
  RoundtableQueued,
  RoundtableSnapshot,
  SessionMessage
} from '../../shared/types'
import { api } from './api'
import { ipcErrorText } from './ipc-error'

type LivePart =
  | { readonly kind: 'text'; readonly text: string }
  /** The call as the transcript row it renders as — built once, when it arrives, so the
   *  memoized row is not handed a new message on every flush of the wave */
  | { readonly kind: 'tool'; readonly m: SessionMessage }
/** One seat's in-flight turn as the view sees it. */
type LiveTurn = {
  /** What the seat has said and run so far, in the order it happened */
  readonly parts: readonly LivePart[]
  /** Epoch ms the turn started — how long the seat has been at it */
  readonly since?: number
}
/** Keyed by participant index — several seats may share a provider. */
type LiveMap = Partial<Record<number, LiveTurn>>

/** Streamed text grows the passage it continues; after a tool call it starts a new one. */
function withText(turn: LiveTurn | undefined, text: string): LiveTurn {
  const cur = turn ?? { parts: [] }
  if (text === '') return cur
  const last = cur.parts[cur.parts.length - 1]
  return last?.kind === 'text'
    ? { ...cur, parts: [...cur.parts.slice(0, -1), { kind: 'text', text: last.text + text }] }
    : { ...cur, parts: [...cur.parts, { kind: 'text', text }] }
}

export type RoundtableStream = {
  /** The table as last loaded; null until its snapshot lands */
  readonly rt: RoundtableSnapshot | null
  /** For an answer main gives back (new limits) — the stream carries no such event */
  readonly setRt: Dispatch<SetStateAction<RoundtableSnapshot | null>>
  readonly entries: readonly RoundtableEntry[]
  readonly running: boolean
  /** The seats streaming right now, and what each has said and run so far */
  readonly live: LiveMap
  /** Consensus-cycle progress, updated by round events */
  readonly cycle: { readonly roundsRun: number; readonly concluded: boolean }
  /** A message sent mid-round, waiting for the round to end (main owns it) */
  readonly queued: RoundtableQueued | null
  /** What went wrong, for the line under the transcript: the stream's own failures,
   *  and the view's, which it says through `setNote` */
  readonly note: string | null
  readonly setNote: Dispatch<SetStateAction<string | null>>
}

/**
 * One roundtable as main streams it: the snapshot, then every event after it. Events
 * arriving before the snapshot loads are buffered, then replayed, and streamed text is
 * batched (~40ms) per seat so stdout chunks don't re-render the log. `onLoad` runs once
 * the snapshot is in and the buffer replayed (the latest one passed is the one called).
 */
export function useRoundtableStream(id: string, onLoad: (snap: RoundtableSnapshot) => void): RoundtableStream {
  const [rt, setRt] = useState<RoundtableSnapshot | null>(null)
  const [entries, setEntries] = useState<RoundtableEntry[]>([])
  const [running, setRunning] = useState(false)
  const [live, setLive] = useState<LiveMap>({})
  const [cycle, setCycle] = useState({ roundsRun: 0, concluded: false })
  const [note, setNote] = useState<string | null>(null)
  const [queued, setQueued] = useState<RoundtableQueued | null>(null)
  /** Events arriving before the snapshot loads are buffered, then replayed. */
  const readyRef = useRef(false)
  const pendingRef = useRef<RoundtableEvent[]>([])
  /** Streamed text is batched (~40ms) per seat so stdout chunks don't re-render the log. */
  const bufRef = useRef(new Map<number, string>())
  const flushRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onLoadRef = useRef(onLoad)
  onLoadRef.current = onLoad

  const clearPendingText = useCallback((seat?: number) => {
    if (seat !== undefined) bufRef.current.delete(seat)
    else bufRef.current.clear()
    if (bufRef.current.size === 0 && flushRef.current) {
      clearTimeout(flushRef.current)
      flushRef.current = null
    }
  }, [])

  const flushDelta = useCallback(() => {
    flushRef.current = null
    const drained = [...bufRef.current]
    bufRef.current.clear()
    if (drained.length === 0) return
    setLive((prev) => {
      const next: LiveMap = { ...prev }
      for (const [seat, chunk] of drained) next[seat] = withText(next[seat], chunk)
      return next
    })
  }, [])

  const apply = useCallback(
    (ev: RoundtableEvent) => {
      if (ev.type === 'round') {
        setRunning(ev.running)
        if (ev.roundsRun !== undefined || ev.concluded !== undefined) {
          setCycle((c) => ({
            roundsRun: ev.roundsRun ?? c.roundsRun,
            concluded: ev.concluded ?? c.concluded
          }))
        }
        if (!ev.running) {
          clearPendingText()
          setLive({})
        }
      } else if (ev.type === 'turn') {
        clearPendingText(ev.seat)
        setLive((prev) => ({ ...prev, [ev.seat]: { parts: [], since: ev.at } }))
      } else if (ev.type === 'queued') {
        setQueued(ev.queued)
        if (ev.error) setNote(`Your waiting message didn’t go out: ${ev.error}`)
      } else if (ev.type === 'turn-end') {
        clearPendingText(ev.seat)
        setLive((prev) => {
          const { [ev.seat]: _gone, ...rest } = prev
          return rest
        })
      } else if (ev.type === 'delta') {
        bufRef.current.set(ev.seat, (bufRef.current.get(ev.seat) ?? '') + ev.text)
        if (!flushRef.current) flushRef.current = setTimeout(flushDelta, 40)
      } else if (ev.type === 'tool') {
        // text still waiting in the batch was said before this call, so it lands first
        const said = bufRef.current.get(ev.seat) ?? ''
        clearPendingText(ev.seat)
        setLive((prev) => {
          const cur = withText(prev[ev.seat], said)
          const tool: LivePart = {
            kind: 'tool',
            m: { role: 'assistant', kind: 'tool_call', toolName: ev.toolName, text: ev.detail, preview: ev.preview }
          }
          return { ...prev, [ev.seat]: { ...cur, parts: [...cur.parts, tool] } }
        })
      } else if (ev.type === 'entry') {
        if (ev.entry.speaker !== 'user' && ev.entry.seat !== undefined) {
          clearPendingText(ev.entry.seat)
          setLive((prev) => {
            const { [ev.entry.seat as number]: _gone, ...rest } = prev
            return rest
          })
        }
        // index is absolute — an entry the snapshot already carried must not repeat
        setEntries((es) => (ev.index < es.length ? es : [...es, ev.entry]))
      }
    },
    [clearPendingText, flushDelta]
  )

  useEffect(() => {
    readyRef.current = false
    pendingRef.current = []
    setRt(null)
    setEntries([])
    setRunning(false)
    setLive({})
    setNote(null)
    // subscribe before the snapshot loads: anything emitted in between is replayed
    const unsub = api.onRoundtableEvent((ev) => {
      if (ev.id !== id) return
      if (!readyRef.current) pendingRef.current.push(ev)
      else apply(ev)
    })
    let dead = false
    void api
      .getRoundtable(id)
      .then((snap) => {
        if (dead) return
        setRt(snap)
        setEntries([...snap.entries])
        setRunning(snap.running)
        setCycle({ roundsRun: snap.roundsRun, concluded: snap.concluded })
        const liveNow: LiveMap = {}
        for (const seat of snap.speaking) {
          liveNow[seat] = { parts: [], since: snap.speakingSince?.[seat] }
        }
        setQueued(snap.queued ?? null)
        setLive(liveNow)
        readyRef.current = true
        const pending = pendingRef.current
        pendingRef.current = []
        for (const ev of pending) apply(ev)
        onLoadRef.current(snap)
      })
      .catch((err) => {
        if (!dead) setNote(ipcErrorText(err))
      })
    return () => {
      dead = true
      unsub()
      clearPendingText()
    }
  }, [id, apply, clearPendingText])

  return { rt, setRt, entries, running, live, cycle, queued, note, setNote }
}
