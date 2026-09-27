import { memo, useEffect, useRef, useState, type JSX } from 'react'
import type {
  Provider,
  RoundtableEntry,
  RoundtableLimits,
  RoundtableWhenBusy,
  RoundtableSnapshot
} from '../../shared/types'
import { cwdLabel } from '../../shared/library'
import { entrySeatIndex, roundRefusal, turnsSpent } from '../../shared/roundtable'
import { api } from './api'
import { CHAT_WIDTH_CSS, useChatWidth } from './chat-width'
import { CopyPath } from './CopyPath'
import { ipcErrorText } from './ipc-error'
import { Message } from './Message'
import { Markdown } from './Markdown'
import { looksSignedOut } from '../../shared/agent-auth'
import { SignInFix } from './SignInFix'
import { RoundtableLimitFields } from './RoundtableLimitFields'
import { cycleReplies, uiSeatName } from './roundtable-seats'
import { useRoundtableStream } from './roundtable-stream'
import { RoundtableTable } from './RoundtableTable'
import { Select } from './Select'
import { fmtElapsed } from './time'
import { EarlierRow, JumpToLatest, useTranscriptWindow, useUnseenBelow } from './transcript-window'
import { BranchChip, ChatIcon, ProviderLogo, SearchIcon } from './logos'
import { SeatEvidencePanel } from './SeatEvidencePanel'

/** Same DOM bound as ChatView, scaled to discussion-length transcripts. */
const RENDER_LAST = 200

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
  const [draft, setDraft] = useState('')
  /** Seats the next message or round goes to; null = the whole table */
  const [to, setTo] = useState<readonly number[] | null>(null)
  /** The table's limits being edited in place; null = the editor is closed */
  const [limitsDraft, setLimitsDraft] = useState<RoundtableLimits | null>(null)
  /** The consensus round cap in the same editor */
  const [roundsDraft, setRoundsDraft] = useState(3)
  /** Ticks while a round runs, so a seat's elapsed time counts up */
  const [now, setNow] = useState(() => Date.now())
  const scrollRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  /** Auto-scroll only while the user is pinned to the bottom — never hijack a scroll-up. */
  const atBottomRef = useRef(true)
  const chatWidth = useChatWidth()

  // the table as main streams it (roundtable-stream.ts); once loaded, the round cap
  // editor starts from the table's own and the composer takes focus
  const { rt, setRt, entries, running, live, cycle, queued, note, setNote } = useRoundtableStream(id, (snap) => {
    setRoundsDraft(snap.maxRounds)
    composerRef.current?.focus()
  })
  // a table opens pinned to the bottom
  useEffect(() => {
    atBottomRef.current = true
  }, [id])

  // what each seat's replies rest on, beside the table — re-read when a round ends
  const [evidence, setEvidence] = useState(false)
  const [evidenceRead, setEvidenceRead] = useState(0)
  // a round's end is when the seats' logs hold what they gathered for it
  useEffect(() => {
    if (!running) setEvidenceRead((n) => n + 1)
  }, [running])

  useEffect(() => {
    if (atBottomRef.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [entries, live, running])
  // the DOM window over the entries, and the way down for a reader who scrolled up
  const { limit, showEarlier } = useTranscriptWindow(scrollRef, RENDER_LAST, id)
  const below = useUnseenBelow(scrollRef, atBottomRef, entries)
  const { markUnseen } = below
  useEffect(() => {
    // a seat streaming into its live block while the reader is scrolled up counts too
    markUnseen()
  }, [live, markUnseen])

  useEffect(() => {
    if (!running) return
    const t = setInterval(() => setNow(Date.now()), 1_000)
    return () => clearInterval(t)
  }, [running])

  /** Mid-round, a message waits for the round (`queue`) or stops it and goes now. */
  const send = async (whenBusy: RoundtableWhenBusy = 'queue'): Promise<void> => {
    const p = draft.trim()
    if (!p || !rt) return
    setDraft('')
    setNote(null)
    try {
      await api.sendRoundtableMessage(id, p, { seats: to ?? undefined, whenBusy })
    } catch (err) {
      setNote(`Send failed: ${ipcErrorText(err)}`)
      setDraft(p) // a rejected send must not eat the typed message
    }
  }

  const oneMoreRound = async (seats: readonly number[] | null = to): Promise<void> => {
    setNote(null)
    try {
      await api.continueRoundtable(id, seats ?? undefined)
    } catch (err) {
      setNote(ipcErrorText(err))
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
      setNote(ipcErrorText(err))
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
  const sliced = entries.length > limit ? entries.slice(-limit) : entries
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
            <CopyPath path={rt.cwd} label={rt.repoRoot ? cwdLabel(rt.cwd, rt.repoRoot, rt.branch) : 'scratch room'} />
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
        {/* the calls behind the replies: the table keeps only their words */}
        <button
          className="btn-review btn-work"
          aria-label="Evidence"
          aria-pressed={evidence}
          aria-controls={evidence ? 'evidence-panel' : undefined}
          title={
            evidence
              ? 'Close the evidence'
              : 'Evidence — what each seat ran, searched for, fetched and read behind its replies'
          }
          onClick={() => setEvidence((on) => !on)}
        >
          <SearchIcon />
        </button>
      </header>

      <div className="chat-deck">
        <div className="chat-main">
          {limitsDraft && (
            <div className="rt-limits" id="rt-limits" role="group" aria-label="Roundtable spending limits">
              <RoundtableLimitFields idPrefix="rt-edit" limits={limitsDraft} onChange={setLimitsDraft} />
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
              if (atBottomRef.current) below.settle()
            }}
          >
            {base > 0 && (
              <EarlierRow shown={sliced.length} total={entries.length} step={RENDER_LAST} onShow={showEarlier} />
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
                // primitives, not an object: a fresh one per render broke the row's memo on
                // every flush of the wave
                signIn={e.speaker !== 'user' && e.error && looksSignedOut(e.text) ? e.speaker : undefined}
                signInHome={e.error ? rt.participants[entrySeatIndex(rt.participants, e)]?.configDir : undefined}
              />
            ))}
            {/* the wave: one live block per seat currently streaming, in seat order */}
            {speaking.map((seatIdx) => {
              const turn = live[seatIdx]
              const seat = rt.participants[seatIdx]
              if (!turn || !seat || turn.parts.length === 0) return null
              return (
                <div key={seatIdx} className="rt-live">
                  {/* parts only ever append, so an index is a stable key */}
                  {turn.parts.map((part, i) =>
                    part.kind === 'tool' ? (
                      <Message key={i} m={part.m} provider={seat.provider} />
                    ) : (
                      <div key={i} className="msg msg-assistant">
                        <span className={`avatar plogo-${seat.provider}`} aria-hidden="true">
                          <ProviderLogo p={seat.provider} size={14} />
                        </span>
                        <div className="assistant-body markdown">
                          <div className={`rt-speaker rt-speaker-${seat.provider}`}>
                            {uiSeatName(rt.participants, seatIdx)}
                          </div>
                          <p className="streaming-plain">{part.text}</p>
                        </div>
                      </div>
                    )
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
                    {speaking.map((i) => {
                      // how long, on the board's own clock; "just now" until the start is known
                      const since = live[i]?.since
                      return (
                        <span key={i} className="rt-waiting-seat">
                          <span className="rt-waiting-time">
                            {uiSeatName(rt.participants, i)} ·{' '}
                            {since === undefined ? 'just now' : fmtElapsed(now - since)}
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
                      )
                    })}
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
            <JumpToLatest on={below.unseen} onJump={below.jump} />
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
        </div>
        {evidence && (
          <SeatEvidencePanel
            table={rt}
            participants={rt.participants}
            refresh={evidenceRead}
            onClose={() => setEvidence(false)}
          />
        )}
      </div>
    </main>
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
  entries: readonly RoundtableEntry[]
  rounds: number
}): JSX.Element {
  const replies = cycleReplies(rt.participants, entries)
  const seats = rt.participants.map((p, i) => {
    const last = replies[i]
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
  signIn,
  signInHome,
  toNames
}: {
  e: RoundtableEntry
  label: string
  /** A message to part of the table: whom it went to */
  toNames?: string
  /** The agent to sign in again, when a failed turn says that is what fixes it */
  signIn?: Provider
  /** The seat's config home, for the sign-in command */
  signInHome?: string
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
        {signIn && (
          <span className="rt-fail-hint">
            {' '}
            <SignInFix provider={signIn} configHome={signInHome} />
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
