import { memo, useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type {
  Provider,
  RoundtableEntry,
  RoundtableEvent,
  RoundtableLimits,
  RoundtableParticipant,
  RoundtableQueued,
  RoundtableWhenBusy,
  RoundtableSnapshot,
  SessionMessage
} from '../../shared/types'
import { cwdLabel } from '../../shared/library'
import {
  entrySeatIndex,
  roundRefusal,
  seatDisplayName,
  turnsSpent
} from '../../shared/roundtable'
import { api } from './api'
import { CHAT_WIDTH_CSS, useChatWidth } from './chat-width'
import { Message } from './ChatView'
import { Markdown } from './Markdown'
import { looksSignedOut } from '../../shared/agent-auth'
import { SignInFix } from './SignInFix'
import { limitOptions, MESSAGE_LIMITS, TABLE_LIMITS } from './NewRoundtable'
import { Select } from './Select'
import { BranchChip, ChatIcon, ProviderLogo, PROVIDER_LABEL } from './logos'

/** Same DOM bound as ChatView, scaled to discussion-length transcripts. */
const RENDER_LAST = 200

type LiveTool = { readonly toolName: string; readonly detail: string; readonly preview?: string }
/** One seat's in-flight turn as the view sees it. */
type LiveTurn = {
  readonly text: string
  readonly tools: readonly LiveTool[]
  /** Epoch ms the turn started — how long the seat has been at it */
  readonly since?: number
}
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
  /** Seats the next message or round goes to; null = the whole table */
  const [to, setTo] = useState<readonly number[] | null>(null)
  /** The table's limits being edited in place; null = the editor is closed */
  const [limitsDraft, setLimitsDraft] = useState<RoundtableLimits | null>(null)
  /** The consensus round cap in the same editor */
  const [roundsDraft, setRoundsDraft] = useState(3)
  /** A message sent mid-round, waiting for the round to end (main owns it) */
  const [queued, setQueued] = useState<RoundtableQueued | null>(null)
  /** Ticks while a round runs, so a seat's elapsed time counts up */
  const [now, setNow] = useState(() => Date.now())
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
        setLive((prev) => ({ ...prev, [ev.seat]: { text: '', tools: [], since: ev.at } }))
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
        for (const seat of snap.speaking) {
          liveNow[seat] = { text: '', tools: [], since: snap.speakingSince?.[seat] }
        }
        setQueued(snap.queued ?? null)
        setRoundsDraft(snap.maxRounds)
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
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(t)
  }, [running])

  useEffect(() => {
    if (!cwdCopied) return
    const t = setTimeout(() => setCwdCopied(false), 1500)
    return () => clearTimeout(t)
  }, [cwdCopied])

  /** Mid-round, a message waits for the round (`queue`) or stops it and goes now. */
  const send = async (whenBusy: RoundtableWhenBusy = 'queue'): Promise<void> => {
    const p = draft.trim()
    if (!p || !rt) return
    setDraft('')
    setNote(null)
    try {
      await api.sendRoundtableMessage(id, p, { seats: to ?? undefined, whenBusy })
    } catch (err) {
      setNote(`Send failed: ${err instanceof Error ? err.message : String(err)}`)
      setDraft(p) // a rejected send must not eat the typed message
    }
  }

  const oneMoreRound = async (seats: readonly number[] | null = to): Promise<void> => {
    setNote(null)
    try {
      await api.continueRoundtable(id, seats ?? undefined)
    } catch (err) {
      setNote(err instanceof Error ? err.message : String(err))
    }
  }

  const saveLimits = async (): Promise<void> => {
    if (!limitsDraft || !rt) return
    try {
      const snap = await api.setRoundtableLimits(
        id,
        limitsDraft,
        rt.mode === 'consensus' ? roundsDraft : undefined
      )
      setRt((prev) => (prev ? { ...prev, limits: snap.limits, maxRounds: snap.maxRounds } : prev))
      setLimitsDraft(null)
      setNote(null)
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

  const spent = turnsSpent(entries)
  // the seats that failed in the latest round: a consensus table stops its auto-rounds
  // on one (main's roundComplete), and says so here rather than looking merely idle
  const lastRoundFailures: number[] = []
  for (let j = entries.length - 1, seen = 0; j >= 0 && seen < rt.participants.length; j--) {
    const e = entries[j]
    if (e.speaker === 'user') break
    seen++
    if (e.error) lastRoundFailures.push(entrySeatIndex(rt.participants, e))
  }
  const stoppedOnFailure =
    !running && rt.mode === 'consensus' && !cycle.concluded && lastRoundFailures.length > 0
  /** The seats that can still carry on when some failed — the one-click way forward */
  const working = rt.participants.map((_, i) => i).filter((i) => !lastRoundFailures.includes(i))
  const addressed = to ?? rt.participants.map((_, i) => i)
  const toggleSeat = (i: number): void => {
    const next = addressed.includes(i) ? addressed.filter((x) => x !== i) : [...addressed, i].sort((a, b) => a - b)
    // back to "everyone" when all are on again; never down to nobody
    if (next.length === 0) return
    setTo(next.length === rt.participants.length ? null : next)
  }
  // the table cannot afford another round — said before the user tries, with the way on
  const outOfTurns = !running && roundRefusal(rt.limits, { participants: rt.participants, entries }) !== null
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
          <h2 className="chat-title">{rt.title}</h2>
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
              {rt.repoRoot ? cwdLabel(rt.cwd, rt.repoRoot, rt.branch) : 'scratch room'}
            </button>
            {cwdCopied && (
              <span className="copy-flash" role="status">
                copied
              </span>
            )}
            <button
              className={`rt-budget${outOfTurns ? ' spent' : ''}`}
              aria-expanded={limitsDraft !== null}
              // only while the editor exists — an id that isn't on the page is a dead link
              aria-controls={limitsDraft ? 'rt-limits' : undefined}
              title={`Roundtable spending limits — up to ${rt.limits.maxTurnsPerMessage} agent turns per message`}
              onClick={() => {
                setRoundsDraft(rt.maxRounds)
                setLimitsDraft(limitsDraft ? null : rt.limits)
              }}
            >
              {rt.limits.maxTurnsPerTable === 0
                ? `${spent} agent turns · no ceiling`
                : `${spent} of ${rt.limits.maxTurnsPerTable} agent turns`}
            </button>
          </div>
        </div>
      </header>

      {limitsDraft && (
        <div className="rt-limits" id="rt-limits" role="group" aria-label="Roundtable spending limits">
          <div className="ns-opt">
            <label className="ns-label" htmlFor="rt-edit-message">Agent turns per message</label>
            <Select
              id="rt-edit-message"
              ariaLabel="Agent turns per message"
              value={String(limitsDraft.maxTurnsPerMessage)}
              options={limitOptions(MESSAGE_LIMITS, limitsDraft.maxTurnsPerMessage)}
              onChange={(v) => setLimitsDraft({ ...limitsDraft, maxTurnsPerMessage: Number(v) })}
            />
          </div>
          <div className="ns-opt">
            <label className="ns-label" htmlFor="rt-edit-table">Agent turns for the table</label>
            <Select
              id="rt-edit-table"
              ariaLabel="Agent turns for the table"
              value={String(limitsDraft.maxTurnsPerTable)}
              options={limitOptions(TABLE_LIMITS, limitsDraft.maxTurnsPerTable)}
              onChange={(v) => setLimitsDraft({ ...limitsDraft, maxTurnsPerTable: Number(v) })}
            />
          </div>
          <div className="ns-opt">
            <label className="ns-label" htmlFor="rt-edit-minutes">Longest a seat may take</label>
            <Select
              id="rt-edit-minutes"
              ariaLabel="Longest a seat may take"
              value={String(limitsDraft.maxTurnMinutes)}
              options={minuteOptions(limitsDraft.maxTurnMinutes)}
              onChange={(v) => setLimitsDraft({ ...limitsDraft, maxTurnMinutes: Number(v) })}
            />
          </div>
          {rt.mode === 'consensus' && (
            <div className="ns-opt">
              <label className="ns-label" htmlFor="rt-edit-rounds">Round cap</label>
              <Select
                id="rt-edit-rounds"
                ariaLabel="Round cap"
                value={String(roundsDraft)}
                options={[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
                  value: String(n),
                  label: n === 1 ? '1 round' : `${n} rounds`
                }))}
                onChange={(v) => setRoundsDraft(Number(v))}
              />
            </div>
          )}
          {running && (
            <span className="ns-hint rt-limits-note">
              Applies from the next round — or the next turn, for the time limit.
            </span>
          )}
          <div className="rt-limits-actions">
            <button className="btn-ghost" onClick={() => setLimitsDraft(null)}>Cancel</button>
            <button className="btn-primary" onClick={() => void saveLimits()}>Save</button>
          </div>
        </div>
      )}

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
            toNames={
              e.speaker === 'user' && e.to
                ? joinNames(e.to.map((j) => uiSeatName(rt.participants, j)))
                : undefined
            }
            hint={
              e.speaker !== 'user' && e.error && looksSignedOut(e.text)
                ? {
                    provider: e.speaker,
                    configHome: rt.participants[entrySeatIndex(rt.participants, e)]?.configDir
                  }
                : undefined
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
            {/* one chip per seat still at it: how long, and a way to stop waiting for it —
                the rest of the round carries on without that seat */}
            {speaking.length > 0 && (
              <span className="rt-waiting">
                {speaking.map((i) => (
                  <span key={i} className="rt-waiting-seat">
                    <span className="rt-waiting-time">
                      {uiSeatName(rt.participants, i)} · {elapsed(now, live[i]?.since)}
                    </span>
                    <button
                      className="link-btn"
                      aria-label={`Skip ${uiSeatName(rt.participants, i)} — go on without it`}
                      title="Stop waiting: end this seat's turn and carry on without it"
                      onClick={() => void api.skipRoundtableSeat(id, i).catch(() => {})}
                    >
                      skip
                    </button>
                  </span>
                ))}
              </span>
            )}
          </div>
        )}
        {/* the message sent mid-round, waiting its turn — visibly not sent yet */}
        {queued && (
          <div className="msg msg-user">
            <div className="bubble bubble-user rt-queued">
              <div className="rt-to-caption">
                waiting — goes out when this round ends
                {queued.to ? ` · to ${joinNames(queued.to.map((j) => uiSeatName(rt.participants, j)))}` : ''}
                {' · '}
                <button className="link-btn" onClick={() => void api.unqueueRoundtableMessage(id)}>
                  cancel
                </button>
              </div>
              <pre>{queued.text}</pre>
            </div>
          </div>
        )}
        {!running && rt.mode === 'consensus' && cycle.concluded && (
          <ConsensusOutcome rt={rt} entries={entries} rounds={cycle.roundsRun} />
        )}
        {stoppedOnFailure && (
          <div className="sys-row">
            Stopped reaching an understanding —{' '}
            {joinNames([...new Set(lastRoundFailures)].map((i) => uiSeatName(rt.participants, i)))}{' '}
            couldn’t answer, so another round would only bill the others. Fix it, then send a
            message or run one more round
            {working.length > 0 && working.length < rt.participants.length && (
              <>
                {' '}— or{' '}
                <button
                  className="link-btn"
                  onClick={() => {
                    setTo(working)
                    void oneMoreRound(working)
                  }}
                >
                  continue without{' '}
                  {joinNames([...new Set(lastRoundFailures)].map((i) => uiSeatName(rt.participants, i)))}
                </button>
              </>
            )}
            .
          </div>
        )}
        {outOfTurns && !note && (
          <div className="sys-row">
            This table has spent {spent} of its {rt.limits.maxTurnsPerTable} agent turns — another
            round would pass its ceiling.{' '}
            <button className="link-btn" onClick={() => setLimitsDraft(rt.limits)}>
              Raise the limit
            </button>
          </div>
        )}
        {note && (
          <div className="sys-row" role="alert">
            {note}
            {outOfTurns && (
              <>
                {' '}
                <button className="link-btn" onClick={() => setLimitsDraft(rt.limits)}>
                  Raise the limit
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        {status}
      </div>

      <footer className="composer">
        {/* who the next message goes to — the whole table by default; a seat can be left
            out (one that can't answer, or one you want to hear from alone) */}
        {rt.participants.length > 1 && (
          <div className="rt-to" role="group" aria-label="Send to">
            <span className="rt-to-label">To</span>
            {rt.participants.map((p, i) => (
              <button
                key={i}
                className={`rt-to-seat plogo-${p.provider}${addressed.includes(i) ? ' on' : ''}`}
                aria-pressed={addressed.includes(i)}
                disabled={addressed.length === 1 && addressed.includes(i)}
                title={addressed.includes(i) ? 'Leave this seat out of the next message' : 'Include this seat'}
                onClick={() => toggleSeat(i)}
              >
                <ProviderLogo p={p.provider} size={12} />
                <span>{uiSeatName(rt.participants, i)}</span>
              </button>
            ))}
            {to && (
              <button className="link-btn rt-to-all" onClick={() => setTo(null)}>
                everyone
              </button>
            )}
          </div>
        )}
        <textarea
          ref={composerRef}
          aria-label="Message the roundtable"
          placeholder={
            running
              ? 'Add a message — it goes out when this round ends (Enter)…'
              : to
                ? `Message ${joinNames(to.map((i) => uiSeatName(rt.participants, i)))}…  (Enter to send)`
                : 'Message the roundtable…  (Enter to send, Shift+Enter for newline)'
          }
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
          <>
            {/* mid-round, a message can wait for the round or cut it short */}
            {draft.trim() && (
              <button
                className="btn-ghost"
                title="Stop the round and send this now"
                onClick={() => void send('interrupt')}
              >
                Send now
              </button>
            )}
            {draft.trim() ? (
              <button
                className="btn-primary"
                title="Sends the moment this round ends — a consensus cycle ends early for it"
                onClick={() => void send('queue')}
              >
                Send after round
              </button>
            ) : (
              <button
                className="btn-danger"
                title={queued ? 'Stop the round — the waiting message then goes out' : 'Stop the round'}
                onClick={() => void api.stopRoundtable(id)}
              >
                Stop
              </button>
            )}
          </>
        ) : (
          <button className="btn-primary" disabled={!draft.trim()} onClick={() => void send()}>
            Send
          </button>
        )}
      </footer>
    </main>
  )
}

/** "42s", "3m", "1h 5m" since a turn started; blank until the start is known. */
function elapsed(now: number, since: number | undefined): string {
  if (since === undefined) return 'just now'
  const sec = Math.max(0, Math.round((now - since) / 1000))
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${min % 60}m`
}

/** The time-limit presets, plus a hand-edited value shown as itself; 0 = no limit. */
function minuteOptions(current: number): Array<{ value: string; label: string }> {
  const presets = [5, 10, 15, 30, 60, 0]
  const values = presets.includes(current) ? presets : [...presets, current].sort((a, b) => (a || 1e9) - (b || 1e9))
  return values.map((n) => ({ value: String(n), label: n === 0 ? 'no limit' : `${n} min` }))
}

/** One line naming how a seat was set up: model, thinking, and the knobs it has on. */
export function seatSetup(p: RoundtableParticipant): string {
  const o = p.options ?? {}
  return [
    o.model ?? 'default model',
    o.effort ? `${o.effort} thinking` : null,
    o.fast ? 'fast' : null,
    o.longContext ? 'long context' : null,
    o.modelEndpoint ? 'custom provider' : null
  ]
    .filter(Boolean)
    .join(' · ')
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
    return {
      provider: p.provider,
      name: uiSeatName(rt.participants, i),
      status,
      thinking,
      setup: seatSetup(p)
    }
  })
  const n = seats.length
  return (
    <div className={`rt-table ${running ? 'running' : ''}`} role="group" aria-label="The table">
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
            title={`${s.name}\n${s.setup}`}
          >
            <span className={`rt-seat plogo-${s.provider}`}>
              <ProviderLogo p={s.provider} size={14} />
              {s.thinking && <span className={`pulse pulse-${s.provider} rt-seat-pulse`} />}
            </span>
            <span className="rt-table-name">{s.name}</span>
            <span className="rt-table-status">{s.status}</span>
            {/* what this seat runs on — the form's choices, readable on the table itself */}
            <span className="rt-table-setup">{s.setup}</span>
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
          {/* a seat that never spoke stated no position — saying "not yet" would
              invent a dissent (a failed turn is silence, not disagreement) */}
          <span className={`rt-stance${s.stance === 'agree' ? ' agree' : ''}`}>
            {s.stance === 'agree' ? 'agrees' : s.stance === 'continue' ? 'not yet' : 'no reply'}
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
  label,
  hint,
  toNames
}: {
  e: RoundtableEntry
  label: string
  /** A message to part of the table: whom it went to */
  toNames?: string
  /** What fixes a failed turn, when the failure says (a lapsed sign-in) */
  hint?: { readonly provider: Provider; readonly configHome?: string }
}): JSX.Element {
  if (e.speaker === 'user') {
    return (
      <div className="msg msg-user">
        <div className="bubble bubble-user">
          {toNames && <div className="rt-to-caption">to {toNames}</div>}
          <pre>{e.text}</pre>
        </div>
      </div>
    )
  }
  if (e.skipped) {
    return <div className="sys-row">{`${label}: ${e.text}`}</div>
  }
  if (e.error) {
    return (
      <div className="sys-row">
        {`${label} turn failed: ${e.text}`}
        {hint && (
          <span className="rt-fail-hint">
            {' '}
            <SignInFix provider={hint.provider} configHome={hint.configHome} />
          </span>
        )}
      </div>
    )
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
