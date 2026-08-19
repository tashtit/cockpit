import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import {
  KIND_BLURB,
  KIND_LABEL,
  KIND_ORDER,
  PROVIDERS,
  agentHasIt,
  isDrift,
  type AgentState,
  type PanelReport,
  type PanelRow
} from '../../shared/library'
import type { PanelKind, Provider } from '../../shared/types'
import { api } from './api'
import { ProviderLogo, PROVIDER_LABEL } from './logos'

/**
 * The panel: Cockpit's own config for one scope, one row per managed thing.
 *
 * The switch is what you commanded; the lamp under it is what the agent actually
 * has. They usually agree and the lamp stays dark. When they don't — something was
 * added behind Cockpit's back, or hand-edited — the lamp comes on amber and names
 * the disagreement, and the row offers the only two honest answers: write Cockpit's
 * definition into the agent, or take the agent's into Cockpit.
 */

/** What the lamp says when the agent disagrees with its switch. */
const LAMP: Partial<Record<AgentState, string>> = {
  pending: 'not applied',
  changed: 'differs',
  extra: 'added outside'
}

/** Turning these off runs an uninstall, so they ask first. */
const CONFIRM_OFF: readonly PanelKind[] = ['plugin', 'marketplace']

type Notice = { text: string; kind: 'ok' | 'error' } | null

function cellKey(row: PanelRow, agent: Provider): string {
  return `${row.id}|${agent}`
}

export function AgentPanel({
  repoRoot,
  onOpenInstructions,
  setNotice
}: {
  repoRoot: string | null
  onOpenInstructions: () => void
  setNotice: (n: Notice) => void
}): JSX.Element {
  const [report, setReport] = useState<PanelReport | null>(null)
  /** which section is showing — 'attention' is the cross-kind pile of disagreements */
  const [section, setSection] = useState<PanelKind | 'attention' | 'removed' | null>(null)
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  /** cell key currently being written — its switch shows the write in flight */
  const [busy, setBusy] = useState<string | null>(null)
  /** cell key or row id whose destructive action is in its armed step */
  const [armed, setArmed] = useState<string | null>(null)
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(() => {
    void api
      .getPanel(repoRoot)
      .then(setReport)
      .catch((err) => setNotice({ text: String(err?.message ?? err), kind: 'error' }))
  }, [repoRoot, setNotice])

  useEffect(() => {
    setReport(null)
    setSection(null)
    setQuery('')
    load()
  }, [load])

  useEffect(
    () => () => {
      if (armTimer.current) clearTimeout(armTimer.current)
    },
    []
  )

  const arm = (key: string | null): void => {
    setArmed(key)
    if (armTimer.current) clearTimeout(armTimer.current)
    if (key !== null) armTimer.current = setTimeout(() => setArmed(null), 4000)
  }

  /** Every action returns the freshly reconciled scope, so the panel never guesses. */
  const run = async (key: string, op: () => Promise<PanelReport>, ok: string): Promise<void> => {
    setNotice(null)
    setArmed(null)
    setBusy(key)
    try {
      setReport(await op())
      setNotice({ text: ok, kind: 'ok' })
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : String(err), kind: 'error' })
      load()
    } finally {
      setBusy(null)
    }
  }

  const target = (row: PanelRow): { repoRoot: string | null; kind: PanelKind; name: string } => ({
    repoRoot,
    kind: row.kind,
    name: row.name
  })

  const flip = (row: PanelRow, agent: Provider, on: boolean): void => {
    const key = cellKey(row, agent)
    if (!on && CONFIRM_OFF.includes(row.kind) && armed !== key) {
      arm(key)
      return
    }
    void run(
      key,
      () => api.setPanelSwitch(target(row), agent, on),
      on
        ? `${row.name} is on for ${PROVIDER_LABEL[agent]} — restart that CLI to pick it up.`
        : `${row.name} is off for ${PROVIDER_LABEL[agent]}. Cockpit still has it, so you can put it back.`
    )
  }

  /** Make the agents agree by copying one of theirs — Cockpit picks no winner. */
  const match = (row: PanelRow, source: Provider): void =>
    void run(
      cellKey(row, source),
      () => api.matchPanelEntry(target(row), source),
      `Every agent now runs ${PROVIDER_LABEL[source]}’s ${row.name}.`
    )

  const remove = (row: PanelRow): void =>
    void run(
      row.id,
      () => api.removePanelEntry(target(row)),
      `Removed ${row.name} from every agent. It’s under Removed if you want it back.`
    )

  const restore = (row: PanelRow): void =>
    void run(
      row.id,
      () => api.restorePanelEntry(target(row)),
      `Put ${row.name} back.`
    )

  if (!report) return <div className="tree-empty">reading every agent’s config…</div>

  const kinds = KIND_ORDER.filter((k) => report.rows.some((r) => r.kind === k))
  const driftRows = report.rows.filter((r) => r.drift.length > 0)
  // land on the work when there is any, otherwise on the first section
  const current = section ?? (driftRows.length > 0 ? 'attention' : (kinds[0] ?? null))
  const q = query.trim().toLowerCase()
  // a search looks everywhere: you rarely know which section a server ended up in
  const rows = q
    ? report.rows.filter((r) =>
        `${r.name} ${r.saved.detail} ${KIND_LABEL[r.kind]}`.toLowerCase().includes(q)
      )
    : current === 'attention'
      ? driftRows
      : current === 'removed'
        ? []
        : report.rows.filter((r) => r.kind === current)

  return (
    <>
      <div className="pnl-bar">
        <input
          type="search"
          className="pnl-search"
          placeholder="Search everything…"
          aria-label="Search this scope"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="btn-ghost small" title="Re-read every agent’s config" onClick={load}>
          Refresh
        </button>
      </div>

      {/* one section at a time: the whole setup in one scroll was a wall */}
      <div className={`pnl-tabs ${q ? 'searching' : ''}`} role="tablist" aria-label="Sections">
        {driftRows.length > 0 && (
          <button
            role="tab"
            aria-selected={current === 'attention'}
            className={`pnl-pill attention ${current === 'attention' ? 'active' : ''}`}
            onClick={() => setSection('attention')}
          >
            Needs you
            <span className="pnl-pill-n">{driftRows.length}</span>
          </button>
        )}
        {report.removed.length > 0 && (
          <button
            role="tab"
            aria-selected={current === 'removed'}
            className={`pnl-pill ${current === 'removed' ? 'active' : ''}`}
            onClick={() => setSection('removed')}
          >
            Removed
            <span className="pnl-pill-n">{report.removed.length}</span>
          </button>
        )}
        {kinds.map((kind) => {
          const all = report.rows.filter((r) => r.kind === kind)
          const drift = all.filter((r) => r.drift.length > 0).length
          return (
            <button
              key={kind}
              role="tab"
              aria-selected={current === kind}
              className={`pnl-pill ${current === kind ? 'active' : ''}`}
              onClick={() => setSection(kind)}
            >
              {KIND_LABEL[kind]}
              <span className="pnl-pill-n">{all.length}</span>
              {drift > 0 && <i className="pnl-pill-dot" aria-label={`${drift} need attention`} />}
            </button>
          )
        })}
      </div>

      <p className="pnl-blurb">
        {q ? (
          `${rows.length} match${rows.length === 1 ? '' : 'es'} for “${query.trim()}”`
        ) : current === 'removed' ? (
          'Taken out of every agent. Cockpit kept a copy of each, so you can put them back.'
        ) : current === 'attention' ? (
          'Something here disagrees — with its switch, or with the other agents. Open a row to settle it.'
        ) : (
          <>
            {current ? KIND_BLURB[current] : ''} The switch is what you asked for; the lamp under
            it is what the agent has.
          </>
        )}
      </p>

      {report.rows.length === 0 && (
        <div className="tree-empty">
          {repoRoot === null
            ? 'nothing here yet — anything your agents already have is picked up automatically'
            : 'nothing set for this repo yet — a repo can carry its own instructions, Claude Code MCP servers, and skills'}
        </div>
      )}

      {q !== '' && rows.length === 0 && (
        <div className="tree-empty">nothing here matches “{query.trim()}”</div>
      )}

      {rows.length > 0 && (
        // the cap belongs to the bank: same element owns the lane widths, so the
        // header grid and the lane gradient can never disagree
        <div className={`pnl-bank ${rows.some((r) => r.drift.length > 0) ? '' : 'quiet'}`}>
          <div className="pnl-row pnl-head" aria-hidden="true">
            <span>Cockpit</span>
            {PROVIDERS.map((p) => (
              <span key={p} className="pnl-col">
                <span className={`plogo plogo-${p}`}>
                  <ProviderLogo p={p} size={13} />
                </span>
                {PROVIDER_LABEL[p]}
              </span>
            ))}
            <span />
          </div>
          <div className="pnl-table">
            {rows.map((row) => (
              <Row
                key={row.id}
                row={row}
                showKind={q !== '' || current === 'attention'}
                armed={armed}
                busy={busy}
                open={expanded === row.id}
                onToggle={() => setExpanded(expanded === row.id ? null : row.id)}
                onFlip={flip}
                onMatch={match}
                onRemove={remove}
                onRestore={restore}
                onArm={arm}
                onOpenInstructions={onOpenInstructions}
              />
            ))}
          </div>
        </div>
      )}

      {current === 'removed' && (
        <div className="pnl-removed">
          {report.removed.map((row) => (
            <div key={row.id} className="pnl-removed-row">
              <span className="pnl-title">{row.name}</span>
              <span className="pnl-kind">{KIND_LABEL[row.kind]}</span>
              <span className="pnl-def">{row.saved.detail}</span>
              <button
                className="btn-ghost small"
                disabled={busy !== null}
                onClick={() => restore(row)}
              >
                {busy === row.id ? 'putting back…' : 'Put it back'}
              </button>
            </div>
          ))}
        </div>
      )}

      {current === 'skill' && repoRoot !== null && (
        <p className="pnl-note">
          Codex and Copilot both read <code>.agents/skills</code> in this repo, so their switches
          move together.
        </p>
      )}

      {report.globalOnly.length > 0 && (
        <p className="pnl-note">
          {report.globalOnly.map((k) => KIND_LABEL[k]).join(' and ')} are installed per machine, so
          a repo can’t change them. They live in <strong>Global</strong>.
        </p>
      )}
    </>
  )
}

function Row({
  row,
  showKind,
  open,
  armed,
  busy,
  onToggle,
  onFlip,
  onMatch,
  onRemove,
  onRestore,
  onArm,
  onOpenInstructions
}: {
  row: PanelRow
  /** the attention pile mixes kinds, so each row says which one it is */
  showKind: boolean
  open: boolean
  armed: string | null
  busy: string | null
  onToggle: () => void
  onFlip: (row: PanelRow, agent: Provider, on: boolean) => void
  onMatch: (row: PanelRow, source: Provider) => void
  onRemove: (row: PanelRow) => void
  onRestore: (row: PanelRow) => void
  onArm: (key: string | null) => void
  onOpenInstructions: () => void
}): JSX.Element {
  const drifted = row.drift.length > 0
  const armedHere = armed !== null && armed.startsWith(`${row.id}|`)
  return (
    <>
      <div className={`pnl-row ${drifted ? 'drifted' : ''} ${open ? 'open' : ''}`}>
        <span className="pnl-name-cell">
          <button className="pnl-name" aria-expanded={open} onClick={onToggle}>
            <span className={`pnl-caret ${open ? 'open' : ''}`} aria-hidden="true">
              ▸
            </span>
            <span className="pnl-title">{row.name}</span>
            {showKind && <span className="pnl-kind">{KIND_LABEL[row.kind]}</span>}
            <span className="pnl-def" title={row.saved.detail}>
              {row.saved.detail}
            </span>
          </button>
        </span>
        {PROVIDERS.map((p) => {
          const cell = row.cells[p]
          const key = cellKey(row, p)
          const writing = busy === key
          const isArmed = armed === key
          if (cell.state === 'na') {
            return (
              <span key={p} className="pnl-cell na" title={cell.reason}>
                —
              </span>
            )
          }
          return (
            <span key={p} className="pnl-cell">
              <button
                role="switch"
                aria-checked={cell.desired}
                aria-label={`${row.name} in ${PROVIDER_LABEL[p]}`}
                title={
                  isArmed
                    ? 'Click again to remove it from this agent'
                    : cell.detail || (cell.desired ? 'switched on' : 'switched off')
                }
                disabled={busy !== null}
                className={`sw sw-${p} ${cell.desired ? 'on' : 'off'} ${
                  isDrift(cell.state) ? 'drift' : ''
                } ${isArmed ? 'armed' : ''}`}
                onBlur={() => {
                  if (isArmed) onArm(null)
                }}
                onClick={() => onFlip(row, p, !cell.desired)}
              >
                <i aria-hidden="true" />
              </button>
              {writing && <span className="pnl-lamp working" aria-hidden="true" />}
            </span>
          )
        })}
        {/* every disagreement reads in one place, so the lanes stay a clean switch
            bank and rows keep one height however many lamps are lit */}
        <span className="pnl-flags">
          {armedHere && <span className="pnl-flag danger">click again to remove</span>}
          {!armedHere &&
            row.drift.map((p) => (
              <button
                key={p}
                className="pnl-flag"
                title="Cockpit and this agent disagree — open the row to settle it"
                onClick={onToggle}
              >
                <span className="pnl-flag-who">{PROVIDER_LABEL[p]}</span>
                <span className="pnl-flag-state">{LAMP[row.cells[p].state]}</span>
              </button>
            ))}
        </span>
      </div>
      {open && (
        <div className="pnl-detail">
          <Detail
            row={row}
            armed={armed}
            busy={busy}
            onFlip={onFlip}
            onMatch={onMatch}
            onRemove={onRemove}
            onArm={onArm}
            onOpenInstructions={onOpenInstructions}
          />
        </div>
      )}
    </>
  )
}

/**
 * The row opened up: Cockpit's definition first, then each agent's, field by field.
 * Cockpit leads the table because it is the source of truth — the agents are the
 * copies, and any row where they disagree is what the lamp was pointing at.
 */
function Detail({
  row,
  armed,
  busy,
  onFlip,
  onMatch,
  onRemove,
  onArm,
  onOpenInstructions
}: {
  row: PanelRow
  armed: string | null
  busy: string | null
  onFlip: (row: PanelRow, agent: Provider, on: boolean) => void
  onMatch: (row: PanelRow, source: Provider) => void
  onRemove: (row: PanelRow) => void
  onArm: (key: string | null) => void
  onOpenInstructions: () => void
}): JSX.Element {
  const holders = PROVIDERS.filter((p) => agentHasIt(row.cells[p].state))
  const removeArmed = armed === row.id
  return (
    <div className="pnl-detail-body">
      {row.fields.length > 0 && holders.length > 0 && (
        <table className="pnl-diff" aria-label={`${row.name} — what each agent runs`}>
          <thead>
            <tr>
              <th scope="col">field</th>
              {holders.map((p) => (
                <th key={p} scope="col" className={`tint-${p}`}>
                  {PROVIDER_LABEL[p]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {row.fields
              // a field nobody fills in is not a comparison, it's an empty line
              .filter((field) => holders.some((p) => (row.cells[p].fields[field] ?? '') !== ''))
              .map((field) => {
                // the agents are compared with each other; a field one of them simply
                // doesn't record is unknown, not a difference
                const values = holders
                  .filter((p) => field in row.cells[p].fields)
                  .map((p) => row.cells[p].fields[field])
                const differs = values.some((v) => v !== values[0])
                return (
                  <tr key={field} className={differs ? 'differs' : ''}>
                    <th scope="row">{field}</th>
                    {holders.map((p) => (
                      <td key={p} title={row.cells[p].fields[field]}>
                        {row.cells[p].fields[field] || (
                          <span className="pnl-none">
                            {field in row.cells[p].fields ? '—' : 'not recorded'}
                          </span>
                        )}
                      </td>
                    ))}
                  </tr>
                )
              })}
          </tbody>
        </table>
      )}

      {/* a disagreement between agents has no "right" side for Cockpit to pick,
          so the user names the agent whose setup the others should follow */}
      {row.disagree && (
        <div className="pnl-fix">
          <span className="pnl-fix-what">
            {row.holders.map((p) => PROVIDER_LABEL[p]).join(' and ')} don’t run the same{' '}
            {row.name}. Which one is right?
          </span>
          <div className="pnl-fix-actions">
            {row.holders.map((p) => (
              <button
                key={p}
                className="btn-ghost small"
                disabled={busy !== null}
                onClick={() => onMatch(row, p)}
              >
                Use {PROVIDER_LABEL[p]}’s
              </button>
            ))}
          </div>
        </div>
      )}

      {row.drift
        .filter((p) => row.cells[p].state !== 'changed')
        .map((p) => (
          <div key={p} className="pnl-fix">
            <span className="pnl-fix-what">
              {row.cells[p].state === 'pending'
                ? `${PROVIDER_LABEL[p]} doesn’t have ${row.name}, but its switch is on.`
                : `${PROVIDER_LABEL[p]} has ${row.name} even though its switch is off.`}
            </span>
            <div className="pnl-fix-actions">
              <button
                className="btn-ghost small"
                disabled={busy !== null}
                onClick={() => onFlip(row, p, row.cells[p].state === 'pending')}
              >
                {row.cells[p].state === 'pending' ? 'Write it now' : 'Switch it on'}
              </button>
              {row.cells[p].state === 'extra' && (
                <button
                  className="btn-ghost small"
                  disabled={busy !== null}
                  onClick={() => onFlip(row, p, false)}
                >
                  Take it out
                </button>
              )}
            </div>
          </div>
        ))}

      <div className="pnl-detail-actions">
        {row.kind === 'instructions' ? (
          <button className="btn-ghost small" onClick={onOpenInstructions}>
            Edit the baseline
          </button>
        ) : (
          <button
            className={`btn-ghost small ${removeArmed ? 'armed' : ''}`}
            disabled={busy !== null}
            aria-label={
              removeArmed ? `Confirm removing ${row.name} everywhere` : `Remove ${row.name} everywhere`
            }
            title="Take it out of every agent. Cockpit keeps a copy, so you can put it back."
            onBlur={() => {
              if (removeArmed) onArm(null)
            }}
            onClick={() => (removeArmed ? onRemove(row) : onArm(row.id))}
          >
            {removeArmed ? 'remove everywhere?' : 'Remove everywhere'}
          </button>
        )}
      </div>
    </div>
  )
}
