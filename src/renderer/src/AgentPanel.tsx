import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import {
  KIND_BLURB,
  KIND_LABEL,
  PROVIDERS,
  agentHasIt,
  isDrift,
  type AgentState,
  type PanelReport,
  type PanelRow
} from '../../shared/library'
import type { DriftFix, PanelKind, Provider } from '../../shared/types'
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

const FIX_LABEL: Record<DriftFix, string> = {
  apply: 'Write Cockpit’s version',
  adopt: 'Take this agent’s version'
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

  const fix = (row: PanelRow, agent: Provider, how: DriftFix): void =>
    void run(
      cellKey(row, agent),
      () => api.fixPanelDrift(target(row), agent, how),
      how === 'apply'
        ? `Wrote Cockpit’s ${row.name} into ${PROVIDER_LABEL[agent]}.`
        : `Cockpit now keeps ${PROVIDER_LABEL[agent]}’s ${row.name}.`
    )

  const forget = (row: PanelRow): void =>
    void run(
      row.id,
      () => api.forgetPanelEntry(target(row)),
      `Removed ${row.name} from every agent, and Cockpit stopped tracking it.`
    )

  if (!report) return <div className="tree-empty">reading every agent’s config…</div>

  const kinds = [...new Set(report.rows.map((r) => r.kind))]

  return (
    <>
      <div className="pnl-bar">
        <span className="pnl-counts">
          <strong>{report.on}</strong> switched on
          {report.drift > 0 && <em className="pnl-drift">{report.drift} need attention</em>}
        </span>
        <button className="btn-ghost small" title="Re-read every agent’s config" onClick={load}>
          Refresh
        </button>
      </div>

      <p className="ns-hint">
        The switch is what you asked for; the lamp under it is what the agent actually has.
        Switching an agent off takes the entry out of that agent — Cockpit keeps it, so you can
        put it back.
      </p>

      {report.rows.length > 0 && (
        // one header for the whole panel: every section shares the grid, and each
        // agent's switch carries its own identity color, so repeating it per
        // section would be five rows of the same thing
        <div className="pnl-row pnl-head" aria-hidden="true">
          <span>Cockpit</span>
          {PROVIDERS.map((p) => (
            <span key={p} className="pnl-col">
              <span className={`plogo plogo-${p}`} aria-hidden="true">
                <ProviderLogo p={p} size={13} />
              </span>
              {PROVIDER_LABEL[p]}
            </span>
          ))}
          <span />
        </div>
      )}

      {report.rows.length === 0 && (
        <div className="tree-empty">
          {repoRoot === null
            ? 'nothing here yet — anything your agents already have is picked up automatically'
            : 'nothing set for this repo yet — a repo can carry its own instructions, Claude Code MCP servers, and skills'}
        </div>
      )}

      {kinds.map((kind) => {
        const rows = report.rows.filter((r) => r.kind === kind)
        return (
          <section key={kind} className="pnl-group" aria-label={KIND_LABEL[kind]}>
            <div className="pnl-group-head">
              <h3 className="ns-label">{KIND_LABEL[kind]}</h3>
              <span className="pnl-blurb">{KIND_BLURB[kind]}</span>
            </div>
            {kind === 'skill' && repoRoot !== null && (
              <p className="pnl-note">
                Codex and Copilot both read <code>.agents/skills</code> in this repo, so their
                switches move together.
              </p>
            )}
            <div className="pnl-table">
              {rows.map((row) => (
                <Row
                  key={row.id}
                  row={row}
                  armed={armed}
                  busy={busy}
                  open={expanded === row.id}
                  onToggle={() => setExpanded(expanded === row.id ? null : row.id)}
                  onFlip={flip}
                  onFix={fix}
                  onForget={forget}
                  onArm={arm}
                  onOpenInstructions={onOpenInstructions}
                />
              ))}
            </div>
          </section>
        )
      })}

      {report.globalOnly.length > 0 && (
        <p className="pnl-note">
          {report.globalOnly.map((k) => KIND_LABEL[k]).join(' and ')} are installed per machine, so
          a repo can’t change them. They live in{' '}
          <strong>Global</strong>.
        </p>
      )}
    </>
  )
}

function Row({
  row,
  open,
  armed,
  busy,
  onToggle,
  onFlip,
  onFix,
  onForget,
  onArm,
  onOpenInstructions
}: {
  row: PanelRow
  open: boolean
  armed: string | null
  busy: string | null
  onToggle: () => void
  onFlip: (row: PanelRow, agent: Provider, on: boolean) => void
  onFix: (row: PanelRow, agent: Provider, how: DriftFix) => void
  onForget: (row: PanelRow) => void
  onArm: (key: string | null) => void
  onOpenInstructions: () => void
}): JSX.Element {
  const drifted = row.drift.length > 0
  return (
    <>
      <div className={`pnl-row ${drifted ? 'drifted' : ''} ${open ? 'open' : ''}`}>
        <span className="pnl-name-cell">
          <button className="pnl-name" aria-expanded={open} onClick={onToggle}>
            <span className={`pnl-caret ${open ? 'open' : ''}`} aria-hidden="true">
              ▸
            </span>
            <span className="pnl-title">{row.name}</span>
            <span className="pnl-def" title={row.cockpit.detail}>
              {row.cockpit.detail}
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
              {writing ? (
                <span className="pnl-lamp working">working…</span>
              ) : isArmed ? (
                <span className="pnl-lamp danger">remove?</span>
              ) : (
                LAMP[cell.state] && <span className="pnl-lamp">{LAMP[cell.state]}</span>
              )}
            </span>
          )
        })}
        <span className="pnl-cell-actions">
          {drifted && (
            <button
              className="pnl-alert"
              title="Cockpit and this agent disagree — open the row to settle it"
              onClick={onToggle}
            >
              !
            </button>
          )}
        </span>
      </div>
      {open && (
        <div className="pnl-detail">
          <Detail
            row={row}
            armed={armed}
            busy={busy}
            onFix={onFix}
            onForget={onForget}
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
  onFix,
  onForget,
  onArm,
  onOpenInstructions
}: {
  row: PanelRow
  armed: string | null
  busy: string | null
  onFix: (row: PanelRow, agent: Provider, how: DriftFix) => void
  onForget: (row: PanelRow) => void
  onArm: (key: string | null) => void
  onOpenInstructions: () => void
}): JSX.Element {
  const holders = PROVIDERS.filter((p) => agentHasIt(row.cells[p].state))
  const forgetArmed = armed === row.id
  return (
    <div className="pnl-detail-body">
      {row.fields.length > 0 && (
        <table className="pnl-diff" aria-label={`${row.name} — Cockpit and each agent`}>
          <thead>
            <tr>
              <th scope="col">field</th>
              <th scope="col" className="pnl-src">
                Cockpit
              </th>
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
              .filter(
                (field) =>
                  (row.cockpit.fields[field] ?? '') !== '' ||
                  holders.some((p) => (row.cells[p].fields[field] ?? '') !== '')
              )
              .map((field) => {
                const mine = row.cockpit.fields[field] ?? ''
                // a field the agent doesn't record at all is unknown, not different
                const off = holders.filter(
                  (p) => field in row.cells[p].fields && row.cells[p].fields[field] !== mine
                )
                return (
                  <tr key={field} className={off.length > 0 ? 'differs' : ''}>
                    <th scope="row">{field}</th>
                    <td className="pnl-src">{mine || <span className="pnl-none">—</span>}</td>
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

      {row.drift.map((p) => (
        <div key={p} className="pnl-fix">
          <span className="pnl-fix-what">
            {row.cells[p].state === 'pending' &&
              `${PROVIDER_LABEL[p]} doesn’t have ${row.name}, but its switch is on.`}
            {row.cells[p].state === 'changed' &&
              `${PROVIDER_LABEL[p]} is running a different ${row.name} than Cockpit has.`}
            {row.cells[p].state === 'extra' &&
              `${PROVIDER_LABEL[p]} has ${row.name} even though its switch is off.`}
          </span>
          <div className="pnl-fix-actions">
            {(['apply', 'adopt'] as const)
              // there is nothing to adopt from an agent that doesn't have it
              .filter((how) => how === 'apply' || agentHasIt(row.cells[p].state))
              .map((how) => (
                <button
                  key={how}
                  className="btn-ghost small"
                  disabled={busy !== null}
                  onClick={() => onFix(row, p, how)}
                >
                  {FIX_LABEL[how]}
                </button>
              ))}
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
            className={`btn-ghost small ${forgetArmed ? 'armed' : ''}`}
            disabled={busy !== null}
            aria-label={
              forgetArmed ? `Confirm removing ${row.name} everywhere` : `Remove ${row.name} everywhere`
            }
            title="Take it out of every agent and stop tracking it in Cockpit"
            onBlur={() => {
              if (forgetArmed) onArm(null)
            }}
            onClick={() => (forgetArmed ? onForget(row) : onArm(row.id))}
          >
            {forgetArmed ? 'remove everywhere?' : 'Remove everywhere'}
          </button>
        )}
      </div>
    </div>
  )
}
