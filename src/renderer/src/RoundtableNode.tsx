import { useEffect, useState, type JSX } from 'react'
import type { RoundtableMeta, SessionMeta } from '../../shared/types'
import { api } from './api'
import { ArchiveIcon, PROVIDER_LABEL, Spinner } from './logos'
import { SeatCluster } from './SeatCluster'
import { keepList, noop, PAGE, SessionRow } from './SessionList'
import { fmtTime, useTimeFormat } from './time'

/**
 * A roundtable as a tree item — it sits inside its project (or Chats) like any
 * session. The row opens the shared view; the chevron expands the seat-sessions the
 * table spawned. Those never appear as independent sessions anywhere else, and open
 * read-only (a debugging view).
 */
export function RoundtableNode({
  t,
  selected,
  selectedId,
  indexVersion,
  onOpen,
  onSelect
}: {
  t: RoundtableMeta
  selected: boolean
  selectedId: string | null
  indexVersion: number
  onOpen: (id: string) => void
  onSelect: (s: SessionMeta) => void
}): JSX.Element {
  const timeFormat = useTimeFormat()
  const [seatsOpen, setSeatsOpen] = useState(false)
  const onToggleSeats = (): void => setSeatsOpen((v) => !v)
  return (
    <>
      <div
        className={`session-row rt-row ${selected ? 'selected' : ''} ${t.archived ? 'archived' : ''}`}
        role="treeitem"
        aria-selected={selected}
        aria-expanded={seatsOpen}
        aria-level={2}
        tabIndex={-1}
        title={`${t.providers.map((p) => PROVIDER_LABEL[p]).join(' + ')}\n${t.title}${
          t.branch ? `\n⎇ ${t.branch}` : ''
        }\nchevron: seat sessions (debug)`}
        onClick={() => onOpen(t.id)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onOpen(t.id)
          } else if (e.key === 'ArrowRight' && !seatsOpen) onToggleSeats()
          else if (e.key === 'ArrowLeft' && seatsOpen) onToggleSeats()
        }}
      >
        {/* the chevron is the seat-session (debug) toggle; the row itself opens the table */}
        <span
          className={`chev ${seatsOpen ? 'open' : ''}`}
          role="button"
          aria-label={seatsOpen ? 'Hide seat sessions' : 'Show seat sessions'}
          onClick={(e) => {
            e.stopPropagation()
            onToggleSeats()
          }}
        >
          ▸
        </span>
        <SeatCluster providers={t.providers} />
        <span className="session-title">{t.title}</span>
        {t.archived && <span className="sr-only">(archived)</span>}
        <span className="row-actions">
          <button
            className="icon-btn small"
            title={t.archived ? 'Unarchive' : 'Archive'}
            aria-label={t.archived ? 'Unarchive roundtable' : 'Archive roundtable'}
            onClick={(e) => {
              e.stopPropagation()
              void api.setRoundtableArchived(t.id, !t.archived)
            }}
          >
            <ArchiveIcon />
          </button>
        </span>
        <span className="row-meta">
          {t.running ? (
            <Spinner label="round in progress" />
          ) : (
            <time dateTime={new Date(t.updatedAt).toISOString()}>
              {fmtTime(t.updatedAt, timeFormat)}
            </time>
          )}
        </span>
      </div>
      {seatsOpen && (
        <SeatSessionList
          tableId={t.id}
          indexVersion={indexVersion}
          selectedId={selectedId}
          onSelect={onSelect}
        />
      )}
    </>
  )
}

/** The provider sessions a table spawned, shown only here — they open read-only. */
function SeatSessionList({
  tableId,
  indexVersion,
  selectedId,
  onSelect
}: {
  tableId: string
  indexVersion: number
  selectedId: string | null
  onSelect: (s: SessionMeta) => void
}): JSX.Element {
  const [items, setItems] = useState<SessionMeta[] | null>(null)

  useEffect(() => {
    let dead = false
    void api.pageSessions({ roundtableId: tableId, limit: PAGE }).then((p) => {
      if (dead) return
      setItems((prev) => keepList(prev, p.items))
    })
    return () => {
      dead = true
    }
  }, [tableId, indexVersion])

  if (items === null) return <div className="tree-empty">loading…</div>
  if (items.length === 0) return <div className="tree-empty">no seat sessions yet</div>
  return (
    <>
      {items.map((s) => (
        <SessionRow
          key={s.id}
          s={s}
          selected={selectedId === s.id}
          level={3}
          onSelect={onSelect}
          onOpenUrl={noop}
        />
      ))}
    </>
  )
}
