import { memo, useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type {
  RoundtableEntry,
  RoundtableEvent,
  RoundtableParticipant,
  RoundtableSnapshot,
  SessionMessage
} from '../../shared/types'
import { entrySeatIndex, seatDisplayName } from '../../shared/roundtable'
import { api } from './api'
import { CHAT_WIDTH_CSS, useChatWidth } from './chat-width'
import { Message } from './ChatView'
import { Markdown } from './Markdown'
import { BranchChip, ChatIcon, ProviderLogo, PROVIDER_LABEL } from './logos'

/** Same DOM bound as ChatView, scaled to discussion-length transcripts. */
const RENDER_LAST = 200

type LiveTool = { readonly toolName: string; readonly detail: string; readonly preview?: string }
/** One seat's in-flight turn as the view sees it. */
type LiveTurn = { readonly text: string; readonly tools: readonly LiveTool[] }
/** Keyed by participant index — several seats may share a provider. */
type LiveMap = Partial<Record<number, LiveTurn>>

/** UI seat name: "Claude", or "Claude · opus" / "Claude #2" when a provider repeats. */
function uiSeatName(participants: readonly RoundtableParticipant[], index: number): string {
  return seatDisplayName(participants, index, PROVIDER_LABEL)
}

/** "Claude, Codex and Copilot" — seat names joined the way a sentence would. */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * The shared-transcript view of one roundtable. The table itself is the signature
 * element: an arc with every seat placed around it, carrying each seat's live state.
 * A user message opens a parallel wave — several seats stream at once, each in its
 * own live block. The round loop lives in main; this view renders, never relays.
 */
export function RoundtableView({ id }: { id: string }): JSX.Element {
  const [rt, setRt] = useState<RoundtableSnapshot | null>(null)
  const [entries, setEntries] = useState<RoundtableEntry[]>([])
  const [running, setRunning] = useState(false)
  const [live, setLive] = useState<LiveMap>({})
  /** Consensus-cycle progress, updated by round events */
  const [cycle, setCycle] = useState({ roundsRun: 0, concluded: false })
  const [draft, setDraft] = useState('')
  const [note, setNote] = useState<string | null>(null)
  const [cwdCopied, setCwdCopied] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  /** Auto-scroll only while the user is pinned to the bottom — never hijack a scroll-up. */
  const atBottomRef = useRef(true)
  /** Events arriving before the snapshot loads are buffered, then replayed. */
  const readyRef = useRef(false)
  const pendingRef = useRef<RoundtableEvent[]>([])
  /** Streamed text is batched (~40ms) per seat so stdout chunks don't re-render the log. */
  const bufRef = useRef(new Map<number, string>())
  const flushRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const chatWidth = useChatWidth()

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
      for (const [seat, chunk] of drained) {
        const cur = next[seat] ?? { text: '', tools: [] }
        next[seat] = { ...cur, text: cur.text + chunk }
      }
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
        setLive((prev) => ({ ...prev, [ev.seat]: { text: '', tools: [] } }))
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
        setLive((prev) => {
          const cur = prev[ev.seat] ?? { text: '', tools: [] }
          return {
            ...prev,
            [ev.seat]: {
              ...cur,
              tools: [...cur.tools, { toolName: ev.toolName, detail: ev.detail, preview: ev.preview }]
            }
          }
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
    atBottomRef.current = true
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
        for (const seat of snap.speaking) liveNow[seat] = { text: '', tools: [] }
        setLive(liveNow)
        readyRef.current = true
        const pending = pendingRef.current
        pendingRef.current = []
        for (const ev of pending) apply(ev)
        composerRef.current?.focus()
      })
      .catch((err) => {
        if (!dead) setNote(err instanceof Error ? err.message : String(err))
      })
    return () => {
      dead = true
      unsub()
      clearPendingText()
    }
  }, [id, apply, clearPendingText])

  useEffect(() => {
    if (atBottomRef.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [entries, live, running])

  useEffect(() => {
    if (!cwdCopied) return
    const t = setTimeout(() => setCwdCopied(false), 1500)
    return () => clearTimeout(t)
  }, [cwdCopied])

  const send = async (): Promise<void> => {
    const p = draft.trim()
    if (!p || running || !rt) return
    setDraft('')
    setNote(null)
    try {
      await api.sendRoundtableMessage(id, p)
    } catch (err) {
      setNote(`Send failed: ${err instanceof Error ? err.message : String(err)}`)
      setDraft(p) // a rejected send must not eat the typed message
    }
  }

  const oneMoreRound = async (): Promise<void> => {
    setNote(null)
    try {
      await api.continueRoundtable(id)
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    }
  }

  if (!rt) {
    return (
      <main className="chat">
        <div className="empty-chat small" role={note ? 'alert' : undefined}>
          {note ?? 'loading roundtable…'}
        </div>
      </main>
    )
  }

  const sliced = entries.length > RENDER_LAST ? entries.slice(-RENDER_LAST) : entries
  const base = entries.length - sliced.length
  /** Seat indexes streaming right now, in seat order. */
  const speaking = rt.participants.map((_, i) => i).filter((i) => live[i] !== undefined)
  const thinkingNames = joinNames(speaking.map((i) => uiSeatName(rt.participants, i)))
  // screen-reader announcement on turn/round transitions — not per streamed token
  const status = running
    ? `${thinkingNames || 'Roundtable'} ${speaking.length === 1 ? 'is' : 'are'} working`
    : entries.length > 0
      ? 'Ready'
      : ''

  return (
    // same live width preference as ChatView — the two transcripts must track together
    <main className="chat" style={{ '--chat-col': CHAT_WIDTH_CSS[chatWidth] } as React.CSSProperties}>
      <header className="chat-header">
        <span className="badge badge-roundtable">
          <ChatIcon size={11} /> Roundtable
        </span>
        <div className="chat-header-text">
          <div className="chat-title">{rt.title}</div>
          <div className="chat-sub">
            {rt.branch && <BranchChip branch={rt.branch} />}
            <button
              className={`chat-cwd ${cwdCopied ? 'copied' : ''}`}
              title={`${rt.cwd}\nclick to copy path`}
              onClick={() => {
                void navigator.clipboard.writeText(rt.cwd)
                setCwdCopied(true)
              }}
            >
              {rt.cwd}
            </button>
            {cwdCopied && (
              <span className="copy-flash" role="status">
                copied
              </span>
            )}
          </div>
        </div>
      </header>

      <RoundtableTable rt={rt} entries={entries} speaking={speaking} running={running} />

      <div
        className="messages"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget
          atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
        }}
      >
        {base > 0 && (
          <div className="sys-row">(showing the last {RENDER_LAST} of {entries.length} messages)</div>
        )}
        {sliced.map((e, i) => (
          <EntryRow
            key={base + i}
            e={e}
            label={
              e.speaker === 'user'
                ? 'User'
                : uiSeatName(rt.participants, entrySeatIndex(rt.participants, e))
            }
          />
        ))}
        {/* the wave: one live block per seat currently streaming, in seat order */}
        {speaking.map((seatIdx) => {
          const turn = live[seatIdx]
          const seat = rt.participants[seatIdx]
          if (!turn || !seat || (turn.text === '' && turn.tools.length === 0)) return null
          return (
            <div key={seatIdx} className="rt-live">
              {turn.tools.map((tool, i) => (
                <Message
                  key={`tool-${i}`}
                  m={
                    {
                      role: 'assistant',
                      kind: 'tool_call',
                      toolName: tool.toolName,
                      text: tool.detail,
                      preview: tool.preview
                    } as SessionMessage
                  }
                  provider={seat.provider}
                />
              ))}
              {turn.text && (
                <div className="msg msg-assistant streaming">
                  <span className={`avatar plogo-${seat.provider}`} aria-hidden="true">
                    <ProviderLogo p={seat.provider} size={14} />
                  </span>
                  <div className="assistant-body markdown">
                    <div className={`rt-speaker rt-speaker-${seat.provider}`}>
                      {uiSeatName(rt.participants, seatIdx)}
                    </div>
                    <p className="streaming-plain">{turn.text}</p>
                  </div>
                </div>
              )}
            </div>
          )
        })}
        {running && (
          <div className="thinking">
            <span
              className={
                speaking.length === 1
                  ? `pulse pulse-${rt.participants[speaking[0]]?.provider ?? 'claude'}`
                  : 'pulse'
              }
            />{' '}
            {speaking.length > 0
              ? `${thinkingNames} ${speaking.length === 1 ? 'is' : 'are'} thinking…`
              : 'starting the round…'}
            {rt.mode === 'consensus' && (
              <span className="rt-progress">
                {' '}
                — reaching an understanding, round {Math.min(cycle.roundsRun + 1, rt.maxRounds)} of
                ≤{rt.maxRounds}
              </span>
            )}
          </div>
        )}
        {!running && rt.mode === 'consensus' && cycle.concluded && (
          <ConsensusOutcome rt={rt} entries={entries} rounds={cycle.roundsRun} />
        )}
        {note && (
          <div className="sys-row" role="alert">
            {note}
          </div>
        )}
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        {status}
      </div>

      <footer className="composer">
        <textarea
          ref={composerRef}
          aria-label="Message the roundtable"
          placeholder="Message the roundtable…  (Enter to send, Shift+Enter for newline)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              void send()
            }
          }}
        />
        {!running && entries.length > 0 && (
          <button
            className="btn-ghost"
            title="Run a discussion round with no new message — seats reply to each other in turn"
            onClick={() => void oneMoreRound()}
          >
            One more round
          </button>
        )}
        {running ? (
          <button className="btn-danger" onClick={() => void api.stopRoundtable(id)}>
            Stop
          </button>
        ) : (
          <button className="btn-primary" disabled={!draft.trim()} onClick={() => void send()}>
            Send
          </button>
        )}
      </footer>
    </main>
  )
}

/** Point on the table edge (a quadratic arc) at parameter t ∈ [0,1], in % of the panel. */
function arcPoint(t: number): { x: number; y: number } {
  const u = 1 - t
  // P0 (4,91) — C (50,-36) — P1 (96,91), mirroring the SVG path below
  return {
    x: u * u * 4 + 2 * u * t * 50 + t * t * 96,
    y: u * u * 91 + 2 * u * t * -36 + t * t * 91
  }
}

/**
 * The table itself — the view's one signature element. Seats sit around an arc (the
 * tabletop edge), each carrying its live state: thinking, agrees, not yet, or quiet.
 * Everything it shows is derived; the arc breathes only while a round runs.
 */
function RoundtableTable({
  rt,
  entries,
  speaking,
  running
}: {
  rt: RoundtableSnapshot
  entries: RoundtableEntry[]
  speaking: readonly number[]
  running: boolean
}): JSX.Element {
  // the current cycle: everything after the last user message
  let start = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].speaker === 'user') {
      start = i + 1
      break
    }
  }
  const seats = rt.participants.map((p, i) => {
    let last: RoundtableEntry | undefined
    for (let j = entries.length - 1; j >= start; j--) {
      const e = entries[j]
      if (e.speaker !== 'user' && entrySeatIndex(rt.participants, e) === i && !e.error) {
        last = e
        break
      }
    }
    const thinking = speaking.includes(i)
    const status = thinking
      ? 'thinking…'
      : last?.stance === 'agree'
        ? 'agrees'
        : last?.stance === 'continue'
          ? 'not yet'
          : last
            ? 'spoke'
            : 'quiet'
    return { provider: p.provider, name: uiSeatName(rt.participants, i), status, thinking }
  })
  const n = seats.length
  return (
    <div className={`rt-table ${running ? 'running' : ''}`} aria-label="The table">
      <svg className="rt-table-arc" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <path className="rt-table-edge" d="M 4 91 Q 50 -36 96 91" />
        <path className="rt-table-glow" d="M 4 91 Q 50 -36 96 91" />
      </svg>
      {seats.map((s, i) => {
        const p = arcPoint((i + 1) / (n + 1))
        return (
          <div
            key={i}
            className={`rt-table-seat ${s.thinking ? 'thinking' : ''} status-${
              s.status === 'agrees' ? 'agree' : s.status === 'not yet' ? 'continue' : 'other'
            }`}
            style={{ left: `${p.x}%`, top: `${p.y}%` }}
          >
            <span className={`rt-seat plogo-${s.provider}`}>
              <ProviderLogo p={s.provider} size={14} />
              {s.thinking && <span className={`pulse pulse-${s.provider} rt-seat-pulse`} />}
            </span>
            <span className="rt-table-name">{s.name}</span>
            <span className="rt-table-status">{s.status}</span>
          </div>
        )
      })}
    </div>
  )
}

/**
 * The cycle's outcome, assembled by the app — never by another AI turn: each seat's
 * own closing line (its stance note, or the first line of its final reply), side by
 * side. The seats speak for themselves; Cockpit only lays them out.
 */
function ConsensusOutcome({
  rt,
  entries,
  rounds
}: {
  rt: RoundtableSnapshot
  entries: RoundtableEntry[]
  rounds: number
}): JSX.Element {
  // the current cycle: everything after the last user message
  let start = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].speaker === 'user') {
      start = i + 1
      break
    }
  }
  const seats = rt.participants.map((p, i) => {
    let last: RoundtableEntry | undefined
    for (let j = entries.length - 1; j >= start; j--) {
      const e = entries[j]
      if (e.speaker !== 'user' && entrySeatIndex(rt.participants, e) === i && !e.error) {
        last = e
        break
      }
    }
    const firstLine = last?.text.split('\n').find((l) => l.trim())?.trim() ?? ''
    const line =
      last?.stanceNote ?? (firstLine.length > 160 ? `${firstLine.slice(0, 160)}…` : firstLine)
    return {
      provider: p.provider,
      name: uiSeatName(rt.participants, i),
      stance: last?.stance,
      line: line || '(no reply this cycle)'
    }
  })
  const allAgree = seats.every((s) => s.stance === 'agree')
  return (
    <section className="rt-outcome" aria-label="Roundtable outcome">
      <div className="rt-outcome-head">
        {allAgree ? 'Shared understanding' : 'No full agreement'}
        <span className="rt-outcome-sub">
          the seats&#8217; own closing lines · {rounds} round{rounds === 1 ? '' : 's'} — a new
          message reopens the table
        </span>
      </div>
      {seats.map((s, i) => (
        <div key={i} className="rt-outcome-row">
          <span className={`avatar plogo-${s.provider}`} aria-hidden="true">
            <ProviderLogo p={s.provider} size={13} />
          </span>
          <span className={`rt-speaker rt-speaker-${s.provider}`}>{s.name}</span>
          <span className={`rt-stance${s.stance === 'agree' ? ' agree' : ''}`}>
            {s.stance === 'agree' ? 'agrees' : 'not yet'}
          </span>
          <span className="rt-outcome-line">{s.line}</span>
        </div>
      ))}
    </section>
  )
}

/** Memoized: the transcript is append-only, so settled rows never re-render. */
const EntryRow = memo(function EntryRow({
  e,
  label
}: {
  e: RoundtableEntry
  label: string
}): JSX.Element {
  if (e.speaker === 'user') {
    return (
      <div className="msg msg-user">
        <div className="bubble bubble-user">
          <pre>{e.text}</pre>
        </div>
      </div>
    )
  }
  if (e.error) {
    return <div className="sys-row">{`${label} turn failed: ${e.text}`}</div>
  }
  return (
    <div className="msg msg-assistant">
      <span className={`avatar plogo-${e.speaker}`} aria-hidden="true">
        <ProviderLogo p={e.speaker} size={14} />
      </span>
      <div className="assistant-body markdown">
        <div className={`rt-speaker rt-speaker-${e.speaker}`}>
          {label}
          {e.stance === 'agree' && <span className="rt-stance agree">· agrees</span>}
          {e.stance === 'continue' && <span className="rt-stance">· not yet</span>}
        </div>
        <Markdown text={e.text} />
      </div>
    </div>
  )
})
