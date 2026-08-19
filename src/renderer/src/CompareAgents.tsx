import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import {
  KIND_LABEL,
  KIND_ORDER,
  PROVIDERS,
  buildParity,
  syncTargets,
  type ParityReport,
  type ParityRow,
  type ParityState
} from '../../shared/parity'
import type { ExtensionsInventory, InstructionsState, Provider, SyncKind } from '../../shared/types'
import { api } from './api'
import { ProviderLogo, PROVIDER_LABEL } from './logos'

/**
 * The Compare tab: every shared thing as a row, every agent as a column — the one
 * place that answers "what does Claude have that Codex doesn't, and where do the two
 * disagree?". Rows expand into a field-by-field diff, and each gap is a button that
 * closes it. The parity itself is computed by `shared/parity.ts` from data the view
 * already holds; this file only renders it and calls the sync.
 */

const STATE_GLYPH: Record<ParityState, string> = {
  present: '✓',
  differs: '≠',
  missing: '+',
  na: '·'
}

const STATE_WORD: Record<ParityState, string> = {
  present: 'has it',
  differs: 'differs',
  missing: 'missing',
  na: 'not supported'
}

type Notice = { text: string; kind: 'ok' | 'error' } | null

/** Instructions sync through their own apply path, not the extension writer. */
function isInstructions(row: ParityRow): boolean {
  return row.kind === 'instructions'
}

export function CompareAgents({
  inv,
  reload,
  setNotice,
  onOpenTab
}: {
  inv: ExtensionsInventory
  reload: () => void
  setNotice: (n: Notice) => void
  onOpenTab: (tab: 'instructions') => void
}): JSX.Element {
  const [instructions, setInstructions] = useState<InstructionsState | null>(null)
  const [onlyDiff, setOnlyDiff] = useState(true)
  const [expanded, setExpanded] = useState<string | null>(null)
  /** row id currently being written — every action on that row is disabled meanwhile */
  const [busy, setBusy] = useState<string | null>(null)
  /** `${rowId}|${agent}` whose destructive replace is in its armed step */
  const [armed, setArmed] = useState<string | null>(null)
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    let live = true
    void api.getInstructions(null).then((s) => live && setInstructions(s))
    return () => {
      live = false
    }
  }, [inv])

  useEffect(
    () => () => {
      if (armTimer.current) clearTimeout(armTimer.current)
    },
    []
  )

  const report: ParityReport = useMemo(() => buildParity(inv, instructions), [inv, instructions])
  const shown = onlyDiff ? report.rows.filter((r) => r.diverged || r.incomplete) : report.rows

  const arm = (key: string | null): void => {
    setArmed(key)
    if (armTimer.current) clearTimeout(armTimer.current)
    if (key !== null) armTimer.current = setTimeout(() => setArmed(null), 4000)
  }

  /** One cell's worth of sync: give `to` what the reference agent has. */
  const syncOne = async (row: ParityRow, to: Provider): Promise<string> => {
    if (isInstructions(row)) {
      await api.applyInstructions(null)
      return 'Applied the shared baseline to every agent file.'
    }
    return api.syncExtension(row.kind as SyncKind, row.name, {
      to,
      from: row.reference ?? undefined,
      overwrite: row.cells[to].state === 'differs'
    })
  }

  const run = async (row: ParityRow, targets: readonly Provider[]): Promise<void> => {
    setArmed(null)
    setNotice(null)
    setBusy(row.id)
    const failed: string[] = []
    let last = ''
    for (const to of targets) {
      try {
        last = await syncOne(row, to)
      } catch (err) {
        failed.push(`${PROVIDER_LABEL[to]}: ${err instanceof Error ? err.message : err}`)
      }
    }
    setBusy(null)
    if (failed.length > 0) {
      setNotice({ text: `Couldn't sync "${row.name}" — ${failed.join(' · ')}`, kind: 'error' })
    } else {
      setNotice({ text: last, kind: 'ok' })
    }
    reload()
  }

  /** Fill every gap in a group, additively — an existing definition is never replaced. */
  const alignGroup = async (rows: readonly ParityRow[]): Promise<void> => {
    const gaps = rows.flatMap((row) =>
      isInstructions(row)
        ? []
        : PROVIDERS.filter((p) => row.cells[p].state === 'missing').map((to) => ({ row, to }))
    )
    if (gaps.length === 0) return
    setNotice(null)
    setBusy(rows[0].kind)
    const failed: string[] = []
    let done = 0
    for (const { row, to } of gaps) {
      try {
        await syncOne(row, to)
        done++
      } catch (err) {
        failed.push(`${row.name} → ${PROVIDER_LABEL[to]}: ${err instanceof Error ? err.message : err}`)
      }
    }
    setBusy(null)
    setNotice({
      text:
        failed.length === 0
          ? `Filled ${done} gap${done === 1 ? '' : 's'} — restart the agents to pick them up.`
          : `Filled ${done}, ${failed.length} failed — ${failed.join(' · ')}`,
      kind: failed.length === 0 ? 'ok' : 'error'
    })
    reload()
  }

  return (
    <>
      <p className="ns-hint">
        Every shared thing across your agents, side by side. <strong>✓</strong> the agent has it,{' '}
        <strong>≠</strong> it has a different definition, <strong>+</strong> it&apos;s missing —
        click <strong>+</strong> to copy it over, or open a row to see exactly what differs. MCP
        servers and skills are written straight into each agent&apos;s config; plugins and
        marketplaces are installed by running that agent&apos;s own CLI.
      </p>

      <div className="cmp-bar">
        <span className="cmp-counts">
          <strong>{report.total}</strong> shared
          <em className="cmp-ok">{report.aligned} aligned</em>
          <em className="cmp-warn">{report.diverged} differ</em>
          <em className="cmp-dim">{report.incomplete} incomplete</em>
        </span>
        <label className="cmp-toggle">
          <input
            type="checkbox"
            checked={onlyDiff}
            onChange={(e) => setOnlyDiff(e.target.checked)}
          />
          Only differences
        </label>
        <button className="btn-ghost small" title="Re-read every agent's config" onClick={reload}>
          Refresh
        </button>
      </div>

      {report.total === 0 && (
        <div className="tree-empty">
          nothing shared yet — add an MCP server, a skill or a plugin to any agent and it shows up
          here
        </div>
      )}

      {report.total > 0 && shown.length === 0 && (
        <div className="tree-empty">
          every agent matches on all {report.total} shared items — untick “Only differences” to see
          them
        </div>
      )}

      {KIND_ORDER.map((kind) => {
        const rows = shown.filter((r) => r.kind === kind)
        if (rows.length === 0) return null
        const gaps = rows
          .filter((r) => !isInstructions(r))
          .reduce((n, r) => n + PROVIDERS.filter((p) => r.cells[p].state === 'missing').length, 0)
        return (
          <section key={kind} className="cmp-group" aria-label={KIND_LABEL[kind]}>
            <div className="cmp-group-head">
              <h3 className="ns-label">{KIND_LABEL[kind]}</h3>
              <span className="repo-count">{rows.length}</span>
              {gaps > 0 && (
                <button
                  className="btn-ghost small"
                  disabled={busy !== null}
                  title="Copy every missing item to the agents that don't have it — nothing already configured is replaced"
                  onClick={() => void alignGroup(rows)}
                >
                  {busy === kind ? 'filling…' : `Fill ${gaps} gap${gaps === 1 ? '' : 's'}`}
                </button>
              )}
            </div>
            <div className="cmp-table" role="table" aria-label={`${KIND_LABEL[kind]} by agent`}>
              <div className="cmp-row cmp-head" role="row">
                <span role="columnheader">Name</span>
                {PROVIDERS.map((p) => (
                  <span key={p} role="columnheader" className="cmp-col">
                    <span className={`plogo plogo-${p}`} aria-hidden="true">
                      <ProviderLogo p={p} size={13} />
                    </span>
                    {PROVIDER_LABEL[p]}
                  </span>
                ))}
                <span role="columnheader" className="sr-only">
                  Details
                </span>
              </div>
              {rows.map((row) => (
                <Row
                  key={row.id}
                  row={row}
                  busy={busy === row.id}
                  disabled={busy !== null}
                  armed={armed}
                  open={expanded === row.id}
                  onToggle={() => setExpanded(expanded === row.id ? null : row.id)}
                  onArm={arm}
                  onSync={(targets) => void run(row, targets)}
                  onOpenInstructions={() => onOpenTab('instructions')}
                />
              ))}
            </div>
          </section>
        )
      })}
    </>
  )
}

function Row({
  row,
  open,
  armed,
  onToggle,
  onArm,
  onSync,
  onOpenInstructions,
  ...flags
}: {
  row: ParityRow
  open: boolean
  armed: string | null
  /** this row is mid-sync */
  busy: boolean
  /** some row is mid-sync — every action is inert until it lands */
  disabled: boolean
  onToggle: () => void
  onArm: (key: string | null) => void
  onSync: (targets: readonly Provider[]) => void
  onOpenInstructions: () => void
}): JSX.Element {
  const { busy, disabled } = flags
  const targets = syncTargets(row)
  const instructions = isInstructions(row)
  return (
    <>
      <div className={`cmp-row ${row.diverged ? 'diverged' : ''}`} role="row">
        <span role="rowheader" className="cmp-name-cell">
          <button className="cmp-name" aria-expanded={open} onClick={onToggle} title={row.name}>
            <span className={`cmp-caret ${open ? 'open' : ''}`} aria-hidden="true">
              ▸
            </span>
            {row.name}
          </button>
        </span>
        {PROVIDERS.map((p) => {
          const cell = row.cells[p]
          const label = `${PROVIDER_LABEL[p]} ${STATE_WORD[cell.state]}`
          if (cell.state === 'missing' && row.reference) {
            return (
              <span key={p} role="cell" className="cmp-cell missing">
                <button
                  className="cmp-add"
                  disabled={disabled}
                  aria-label={
                    instructions
                      ? 'Write the shared baseline into every agent file'
                      : `Add ${row.name} to ${PROVIDER_LABEL[p]} from ${PROVIDER_LABEL[row.reference]}`
                  }
                  title={
                    instructions
                      ? 'Applies to every agent file at once — per-file control lives in the Instructions tab'
                      : `Copy from ${PROVIDER_LABEL[row.reference]}`
                  }
                  onClick={() => onSync([p])}
                >
                  {busy ? '…' : '+'}
                </button>
              </span>
            )
          }
          return (
            <span
              key={p}
              role="cell"
              className={`cmp-cell ${cell.state}`}
              title={cell.reason ?? cell.detail ?? label}
              aria-label={`${label}${cell.detail ? ` — ${cell.detail}` : ''}`}
            >
              {STATE_GLYPH[cell.state]}
            </span>
          )
        })}
        <span role="cell" className="cmp-cell-actions">
          {targets.length > 1 && (
            <button
              className="btn-ghost small"
              disabled={disabled}
              title={
                instructions
                  ? 'Write the shared baseline into every agent file'
                  : `Give every agent that is missing ${row.name} the ${PROVIDER_LABEL[row.reference ?? 'claude']} definition — nothing configured is replaced`
              }
              onClick={() =>
                onSync(instructions ? targets : targets.filter((t) => row.cells[t].state === 'missing'))
              }
            >
              {busy ? 'syncing…' : 'Sync all'}
            </button>
          )}
        </span>
      </div>
      {open && (
        <div className="cmp-diff" role="row">
          <Diff
            row={row}
            armed={armed}
            disabled={disabled}
            onArm={onArm}
            onSync={onSync}
            onOpenInstructions={onOpenInstructions}
          />
        </div>
      )}
    </>
  )
}

/**
 * The row opened up: one line per field, one column per agent, with any field the
 * agents disagree on marked. This is the answer to "what actually differs" — the
 * matrix only says *that* something does.
 */
function Diff({
  row,
  armed,
  disabled,
  onArm,
  onSync,
  onOpenInstructions
}: {
  row: ParityRow
  armed: string | null
  disabled: boolean
  onArm: (key: string | null) => void
  onSync: (targets: readonly Provider[]) => void
  onOpenInstructions: () => void
}): JSX.Element {
  const holders = PROVIDERS.filter((p) => row.cells[p].state !== 'missing' && row.cells[p].state !== 'na')
  return (
    <div className="cmp-diff-body">
      {row.fields.length === 0 ? (
        <p className="ns-hint">
          Nothing to compare — {row.name} is recorded by name only in each agent.
        </p>
      ) : (
        <table className="cmp-diff-table">
          <thead>
            <tr>
              <th scope="col">field</th>
              {holders.map((p) => (
                <th key={p} scope="col" className={`tint-${p}`}>
                  {PROVIDER_LABEL[p]}
                  {p === row.reference && <span className="cmp-ref"> reference</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {row.fields.map((field) => {
              const values = holders.map((p) => row.cells[p].fields[field] ?? '')
              const same = values.every((v) => v === values[0])
              return (
                <tr key={field} className={same ? '' : 'differs'}>
                  <th scope="row">{field}</th>
                  {holders.map((p, i) => (
                    <td key={p} title={values[i]}>
                      {values[i] || <span className="cmp-none">—</span>}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      )}

      {isInstructions(row) ? (
        <div className="cmp-diff-actions">
          <button className="btn-ghost small" onClick={onOpenInstructions}>
            Edit in Instructions
          </button>
          <button className="btn-ghost small" disabled={disabled} onClick={() => onSync(syncTargets(row))}>
            Re-apply to all
          </button>
        </div>
      ) : (
        <div className="cmp-diff-actions">
          {PROVIDERS.filter((p) => row.cells[p].state === 'differs').map((p) => {
            const key = `${row.id}|${p}`
            const isArmed = armed === key
            return (
              <button
                key={p}
                className={`btn-ghost small ${isArmed ? 'armed' : ''}`}
                disabled={disabled}
                title={`Overwrite ${PROVIDER_LABEL[p]}'s definition with ${PROVIDER_LABEL[row.reference ?? 'claude']}'s`}
                aria-label={
                  isArmed
                    ? `Confirm replacing ${row.name} in ${PROVIDER_LABEL[p]}`
                    : `Replace ${row.name} in ${PROVIDER_LABEL[p]}`
                }
                onBlur={() => {
                  if (isArmed) onArm(null)
                }}
                onClick={() => (isArmed ? onSync([p]) : onArm(key))}
              >
                {isArmed ? 'replace?' : `Replace ${PROVIDER_LABEL[p]}'s`}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
