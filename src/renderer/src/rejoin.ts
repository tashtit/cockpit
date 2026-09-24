import type { ChatEvent, SessionMessage } from '../../shared/types'

/**
 * Rejoining a turn Cockpit is already running: the window left the conversation
 * mid-turn (another session, back/forward, a reload) and has come back to it.
 *
 * Two sources meet on screen. The log on disk holds every row written before it was
 * read; the stream carries on from the moment the window started listening again. They
 * can only overlap at the log's tail — the events that arrive while it is being read,
 * and, since a CLI may write its log line a moment before its stdout line, the first
 * few after — so that is the only place this looks. The first rows the stream sends are
 * matched against the log's last rows, and matching stops for good at the first row the
 * log does not hold, once the tail is used up, or `REJOIN_GRACE_MS` after the read.
 * A row the two describe differently is let through: a row shown twice until the session
 * is reopened is the lesser harm next to a row that never shows.
 *
 * Everything that is not a transcript row — session ids, permission questions, errors,
 * the end of the turn — passes through untouched, in order: no log holds those.
 */
export type Rejoin = {
  readonly turnId: string
  /** One of the turn's events; returns what to apply now, in order */
  readonly offer: (ev: ChatEvent) => readonly ChatEvent[]
  /** The log is on screen (empty if it could not be read); returns what waited on it */
  readonly logRead: (log: readonly SessionMessage[]) => readonly ChatEvent[]
}

/** How long after the read a streamed row can still be one the log already holds */
export const REJOIN_GRACE_MS = 500
/** How far back into the log a re-sent row can sit — the overlap is a row or two */
const TAIL_ROWS = 8

const isRow = (ev: ChatEvent): boolean => ev.type === 'text' || ev.type === 'tool'

/** Rows of the log a stream event could be: the agent's words and its tool calls */
const streamable = (m: SessionMessage): boolean =>
  (m.role === 'assistant' && m.kind === 'text') || m.kind === 'tool_call'

/** The log row and the stream event are the same thing said twice */
function sameRow(m: SessionMessage, ev: ChatEvent): boolean {
  if (ev.type === 'text') return m.kind === 'text' && m.text.trim() === ev.text.trim()
  if (ev.type === 'tool')
    return m.kind === 'tool_call' && m.toolName === ev.toolName && (m.preview ?? '') === (ev.preview ?? '')
  return false
}

export function rejoinStream(turnId: string, now: () => number = Date.now): Rejoin {
  // what arrived before the log did; null once the log is on screen
  let held: ChatEvent[] | null = []
  // the log's rows the stream may still re-send, oldest first — empty: matching is over
  let tail: readonly SessionMessage[] = []
  // where in `tail` the next re-sent row must be; -1 until one has matched
  let next = -1
  let readAt = 0

  const judge = (ev: ChatEvent): readonly ChatEvent[] => {
    if (tail.length === 0 || !isRow(ev)) return [ev]
    if (now() - readAt > REJOIN_GRACE_MS) {
      tail = []
      return [ev]
    }
    // a re-send is the log's tail, from wherever it starts: the first row may sit
    // anywhere in it (the last match — the shortest overlap), each later one right after
    let at = -1
    if (next >= 0) at = sameRow(tail[next], ev) ? next : -1
    else for (let i = tail.length - 1; i >= 0 && at < 0; i--) if (sameRow(tail[i], ev)) at = i
    if (at < 0) {
      tail = []
      return [ev]
    }
    next = at + 1
    if (next === tail.length) tail = []
    return []
  }

  return {
    turnId,
    offer: (ev) => {
      if (!held) return judge(ev)
      held.push(ev)
      return []
    },
    logRead: (log) => {
      const early = held ?? []
      held = null
      tail = log.filter(streamable).slice(-TAIL_ROWS)
      readAt = now()
      return early.flatMap(judge)
    }
  }
}
