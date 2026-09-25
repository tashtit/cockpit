import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react'
import type { RoundtableParticipant } from '../../shared/types'
import { seatDisplayName } from '../../shared/roundtable'
import { api } from './api'
import { buildEvidence, EVIDENCE_VERB, seatSessions, type EvidenceTurn } from './evidence'
import { ipcErrorText } from './ipc-error'
import { PROVIDER_LABEL, XIcon } from './logos'
import { TabList, type TabDef } from './Tabs'
import { fmtTime, useTimeFormat } from './time'

/**
 * Beside a roundtable, what each seat's replies rest on — the commands it ran, what it
 * searched for, the pages it fetched, the code it read — turn by turn, from the seat's
 * own log (`evidence.ts`). The table keeps only each reply's words; the calls behind
 * them streamed past while the seat answered and were gone from the table after.
 */

/** A seat's sessions read at most — a Copilot seat can start one per turn */
const SESSIONS_PER_SEAT = 20

type SeatEvidence = {
  readonly turns: readonly EvidenceTurn[]
  readonly sessions: number
  /** Several seats of one agent that never named their sessions: each shows all of them */
  readonly shared: boolean
}

export function SeatEvidencePanel({
  table,
  participants,
  refresh,
  onClose
}: {
  /** The table, and the room its seats ran in — paths under it read relative to it */
  table: { readonly id: string; readonly cwd: string }
  participants: readonly RoundtableParticipant[]
  /** Changes when the seats may have written more — a round ended */
  refresh: number
  onClose: () => void
}): JSX.Element {
  const [seat, setSeat] = useState(0)
  const [evidence, setEvidence] = useState<readonly SeatEvidence[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    tabsRef.current?.querySelector<HTMLButtonElement>('[role=tab][aria-selected=true]')?.focus()
  }, [])
  useLayoutEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = 0
  }, [seat])

  useEffect(() => {
    let live = true
    const read = async (): Promise<SeatEvidence[]> => {
      const page = await api.pageSessions({ roundtableId: table.id, limit: 200 })
      return Promise.all(
        seatSessions(participants, page.items).map(async ({ sessions, shared }) => {
          const newest = [...sessions].sort((a, b) => b.startedAt - a.startedAt).slice(0, SESSIONS_PER_SEAT)
          const logs = await Promise.all(newest.map((s) => api.getSessionMessages(s.id)))
          const turns = logs.flatMap((log) => buildEvidence(log)).sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0))
          return { turns, sessions: sessions.length, shared }
        })
      )
    }
    read()
      .then((e) => live && (setEvidence(e), setError(null)))
      .catch((err: unknown) => live && setError(ipcErrorText(err)))
    return () => {
      live = false
    }
  }, [table.id, participants, refresh])

  const name = (i: number): string => seatDisplayName(participants, i, PROVIDER_LABEL)
  const tabs: readonly TabDef<string>[] = participants.map((_, i) => ({
    id: String(i),
    label: name(i),
    count: evidence?.[i]?.turns.reduce((n, t) => n + t.items.length, 0) ?? 0
  }))
  const shown = evidence?.[seat]

  return (
    <aside
      id="evidence-panel"
      className="work-panel"
      aria-label="Evidence"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        onClose()
      }}
    >
      <div className="work-head" ref={tabsRef}>
        <TabList id="evidence" label="Seats" tabs={tabs} selected={String(seat)} onSelect={(t) => setSeat(Number(t))} />
        <button className="icon-btn small work-close" aria-label="Close the evidence" title="Close (Esc)" onClick={onClose}>
          <XIcon />
        </button>
      </div>
      <div
        className="work-body"
        ref={bodyRef}
        role="tabpanel"
        id={`evidence-panel-${seat}`}
        aria-labelledby={`evidence-tab-${seat}`}
        tabIndex={0}
      >
        {error ? (
          <p className="review-error" role="alert">
            {error}
          </p>
        ) : !shown ? (
          <p className="work-note">Reading the seats’ logs…</p>
        ) : (
          <SeatTurns seat={name(seat)} evidence={shown} room={table.cwd} />
        )}
      </div>
    </aside>
  )
}

/** Paths under the room read relative to it, as the chat's rows do under a session's directory */
function relative(text: string, room: string): string {
  return text.split(`${room}/`).join('')
}

function SeatTurns({ seat, evidence, room }: { seat: string; evidence: SeatEvidence; room: string }): JSX.Element {
  const fmt = useTimeFormat()
  if (evidence.sessions === 0) {
    return (
      <p className="work-empty">
        {seat}’s log isn’t indexed yet. It appears once the seat has answered and Cockpit has read the new file.
      </p>
    )
  }
  if (evidence.turns.length === 0) {
    return (
      <p className="work-empty">
        {seat} answered from what it already knew: it ran no commands, searched nothing and read no files.
      </p>
    )
  }
  const calls = evidence.turns.reduce((n, t) => n + t.items.length, 0)
  const refused = evidence.turns.reduce((n, t) => n + t.items.filter((i) => i.outcome === 'refused').length, 0)
  return (
    <>
      <div className="work-meta">
        <span>
          {evidence.turns.length === 1 ? '1 turn' : `${evidence.turns.length} turns`} ·{' '}
          {calls === 1 ? '1 call' : `${calls} calls`}
        </span>
        {/* a seat whose calls never ran backed its claims with nothing it could check */}
        {refused > 0 && <span className="work-flag">{refused} not run</span>}
      </div>
      <p className="work-note">
        What {seat} ran, searched for, fetched and read before each reply, newest first — what its claims rest on.
      </p>
      {evidence.shared && (
        <p className="work-note">
          More than one seat runs this agent without naming its sessions, so each is shown them all: the logs can’t
          say which seat ran which.
        </p>
      )}
      <ol className="ev-turns">
        {evidence.turns.map((t) => (
          <li key={`${t.ts ?? 0}-${t.key}`} className="ev-turn">
            <div className="ev-turn-head">
              {t.ts && <span className="work-check-meta">{fmtTime(t.ts, fmt)}</span>}
              {t.reply && (
                <span className="ev-reply" title={t.reply}>
                  {t.reply}
                </span>
              )}
            </div>
            <ul className="ev-items">
              {t.items.map((item) => (
                <li key={item.key} className="ev-item">
                  <span className="ev-verb">
                    {item.kind === 'other' ? `called ${item.toolName}` : EVIDENCE_VERB[item.kind]}
                  </span>
                  <span className="ev-what">
                    <code className="ev-text" title={item.text}>
                      {relative(item.text, room)}
                    </code>
                    {item.result && (
                      <span className="ev-result" title={item.result}>
                        {relative(item.result.split('\n').find((l) => l.trim()) ?? '', room)}
                      </span>
                    )}
                  </span>
                  {item.outcome === 'failed' && <span className="review-kind tone-danger">failed</span>}
                  {item.outcome === 'refused' && (
                    <span className="review-kind tone-warn" title="The seat's safe mode held it for approval: it never ran">
                      not run
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </>
  )
}
