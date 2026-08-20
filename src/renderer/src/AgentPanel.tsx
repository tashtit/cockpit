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
import type { McpProbeResult, PanelKind, Provider } from '../../shared/types'
import { api } from './api'
import { InstructionsEditor } from './InstructionsEditor'
import { ProviderLogo, PROVIDER_LABEL } from './logos'

/**
 * The panel: everything the agents share, one row per thing.
 *
 * A row is an object, and everything about that object lives in it — where it runs,
 * what each agent is actually running, whether the server answers, how to remove it.
 * There is one navigation layer (the sections) rather than a scope switch over tabs
 * over section pills: three stacked ways to say "where am I" is none.
 *
 * Each agent is a chip that says its own name, so a row needs no column header and no
 * lane to track down. You read "who runs this" as three brand-coloured tokens, which
 * is the vocabulary the rest of the app already uses for an agent.
 */

/** What the row says when an agent disagrees — with its switch, or with its peers. */
const STATE_WORD: Partial<Record<AgentState, string>> = {
  pending: 'not applied',
  changed: 'differs',
  extra: 'added outside'
}

const MCP_STATUS_LABEL: Record<McpProbeResult['status'], string> = {
  ok: 'answers',
  'needs-auth': 'needs login',
  error: 'unreachable'
}

/** The pill says the state; this says what actually happened. Never both the same. */
const MCP_STATUS_SAID: Record<McpProbeResult['status'], string> = {
  ok: 'It answered a handshake.',
  'needs-auth': 'It answered, but wants you to sign in first.',
  error: 'It didn’t answer.'
}

/** Agents whose CLI has an `mcp login` command */
const LOGIN_AGENTS: readonly Provider[] = ['claude', 'codex']

/** Turning these off runs an uninstall, so they ask first. */
const CONFIRM_OFF: readonly PanelKind[] = ['plugin', 'marketplace']

type Section = PanelKind | 'attention' | 'removed'

type Notice = { text: string; kind: 'ok' | 'error' } | null

function cellKey(row: PanelRow, agent: Provider): string {
  return `${row.id}|${agent}`
}

/** "Claude and Codex", "Claude, Codex and Copilot" — never "A and B and C". */
function listOf(names: readonly string[]): string {
  if (names.length < 3) return names.join(' and ')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

export function AgentPanel({
  repoRoot,
  query,
  setNotice
}: {
  repoRoot: string | null
  /** search text, owned by the card so it can share the scope line */
  query: string
  setNotice: (n: Notice) => void
}): JSX.Element {
  const [report, setReport] = useState<PanelReport | null>(null)
  const [section, setSection] = useState<Section | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  /** cell key or row id currently being written */
  const [busy, setBusy] = useState<string | null>(null)
  /** key whose destructive action is in its armed step */
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
        : `${row.name} is off for ${PROVIDER_LABEL[agent]}. Cockpit kept a copy, so you can put it back.`
    )
  }

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
    void run(row.id, () => api.restorePanelEntry(target(row)), `Put ${row.name} back.`)

  if (!report) return <div className="tree-empty">reading every agent’s config…</div>

  // instructions always has a section, even before a baseline exists: writing one is
  // the point, and an empty screen should be an invitation rather than an absence
  const kinds = KIND_ORDER.filter(
    (k) => k === 'instructions' || report.rows.some((r) => r.kind === k)
  )
  const driftRows = report.rows.filter((r) => r.drift.length > 0)
  const q = query.trim().toLowerCase()
  const current: Section | null =
    section ?? (driftRows.length > 0 ? 'attention' : (kinds[0] ?? null))
  // a search looks everywhere: you rarely know which section a thing ended up in
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
      <div className="pnl-tabs" role="tablist" aria-label="Sections">
        {driftRows.length > 0 && (
          <Pill
            label="Needs you"
            count={driftRows.length}
            tone="warn"
            active={current === 'attention'}
            onClick={() => setSection('attention')}
          />
        )}
        {kinds.map((kind) => (
          <Pill
            key={kind}
            label={KIND_LABEL[kind]}
            count={report.rows.filter((r) => r.kind === kind).length}
            dot={report.rows.some((r) => r.kind === kind && r.drift.length > 0)}
            active={current === kind}
            onClick={() => setSection(kind)}
          />
        ))}
        {report.removed.length > 0 && (
          <Pill
            label="Removed"
            count={report.removed.length}
            active={current === 'removed'}
            onClick={() => setSection('removed')}
          />
        )}
      </div>

      {/* the instructions editor opens with its own explanation — a section blurb
          above it would say the same thing twice */}
      {(q !== '' || current !== 'instructions') && (
      <p className="pnl-blurb">
        {q
          ? `${rows.length} match${rows.length === 1 ? '' : 'es'} for “${query.trim()}”`
          : current === 'removed'
            ? 'Taken out of every agent. Cockpit kept a copy of each, so you can put them back.'
            : current === 'attention'
              ? 'Something here disagrees — with where it’s switched on, or with the other agents.'
              : current
                ? KIND_BLURB[current]
                : ''}
      </p>
      )}

      {!q && current === 'instructions' && (
        <InstructionsEditor repoRoot={repoRoot} setNotice={setNotice} onSaved={load} />
      )}

      {!q && current === 'removed' && (
        <div className="pnl-list">
          {report.removed.map((row) => (
            <div key={row.id} className="pnl-row">
              <span className="pnl-entry">
                <span className="pnl-title">{row.name}</span>
                <span className="pnl-kind">{KIND_LABEL[row.kind]}</span>
                <span className="pnl-def">{row.saved.detail}</span>
              </span>
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

      {q && rows.length === 0 && (
        <div className="tree-empty">nothing here matches “{query.trim()}”</div>
      )}

      {rows.length > 0 && (
        <div className="pnl-list">
          {rows.map((row) => (
            <Row
              key={row.id}
              row={row}
              repoRoot={repoRoot}
              showKind={q !== '' || current === 'attention'}
              armed={armed}
              busy={busy}
              open={open === row.id}
              onToggle={() => setOpen(open === row.id ? null : row.id)}
              onFlip={flip}
              onMatch={match}
              onRemove={remove}
              onArm={arm}
              setNotice={setNotice}
            />
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
          {listOf(report.globalOnly.map((k) => KIND_LABEL[k]))} are installed per machine, so a repo
          can’t change them. They live in <strong>Global</strong>.
        </p>
      )}
    </>
  )
}

function Pill({
  label,
  count,
  active,
  onClick,
  ...marks
}: {
  label: string
  count: number
  active: boolean
  onClick: () => void
  tone?: 'warn'
  dot?: boolean
}): JSX.Element {
  return (
    <button
      role="tab"
      aria-selected={active}
      className={`pnl-pill ${marks.tone === 'warn' ? 'attention' : ''} ${active ? 'active' : ''}`}
      onClick={onClick}
    >
      {label}
      <span className="pnl-pill-n">{count}</span>
      {marks.dot && <i className="pnl-pill-dot" aria-label="needs attention" />}
    </button>
  )
}

function Row({
  row,
  repoRoot,
  showKind,
  open,
  armed,
  busy,
  onToggle,
  onFlip,
  onMatch,
  onRemove,
  onArm,
  setNotice
}: {
  row: PanelRow
  repoRoot: string | null
  /** the cross-kind views mix sections, so each row says which one it is */
  showKind: boolean
  open: boolean
  armed: string | null
  busy: string | null
  onToggle: () => void
  onFlip: (row: PanelRow, agent: Provider, on: boolean) => void
  onMatch: (row: PanelRow, source: Provider) => void
  onRemove: (row: PanelRow) => void
  onArm: (key: string | null) => void
  setNotice: (n: Notice) => void
}): JSX.Element {
  // one word for the whole row: the amber chip already says which agent
  const flag = row.drift.length > 0 ? STATE_WORD[row.cells[row.drift[0]].state] : null
  const armedHere = armed !== null && armed.startsWith(`${row.id}|`)
  return (
    <>
      <div className={`pnl-row ${open ? 'open' : ''}`}>
        <button className="pnl-entry" aria-expanded={open} onClick={onToggle}>
          <span className={`pnl-caret ${open ? 'open' : ''}`} aria-hidden="true">
            ▸
          </span>
          <span className="pnl-title">{row.name}</span>
          {showKind && <span className="pnl-kind">{KIND_LABEL[row.kind]}</span>}
          <span className="pnl-def" title={row.saved.detail}>
            {row.saved.detail}
          </span>
        </button>
        <span className="pnl-chips">
          {PROVIDERS.map((p) => {
            const cell = row.cells[p]
            const key = cellKey(row, p)
            if (cell.state === 'na') {
              return (
                <span key={p} className="ag-chip na" title={cell.reason}>
                  <ProviderLogo p={p} size={11} />
                  {PROVIDER_LABEL[p]}
                </span>
              )
            }
            const isArmed = armed === key
            return (
              <button
                key={p}
                role="switch"
                aria-checked={cell.desired}
                aria-label={`${row.name} in ${PROVIDER_LABEL[p]}`}
                title={
                  isArmed
                    ? 'Click again to remove it from this agent'
                    : cell.detail || (cell.desired ? 'on' : 'off')
                }
                disabled={busy !== null}
                className={`ag-chip ag-${p} ${cell.desired ? 'on' : 'off'} ${
                  isDrift(cell.state) ? 'drift' : ''
                } ${isArmed ? 'armed' : ''} ${busy === key ? 'working' : ''}`}
                onBlur={() => {
                  if (isArmed) onArm(null)
                }}
                onClick={() => onFlip(row, p, !cell.desired)}
              >
                <ProviderLogo p={p} size={11} />
                {PROVIDER_LABEL[p]}
              </button>
            )
          })}
        </span>
        <span className="pnl-state">
          {armedHere ? (
            <em className="pnl-flag danger">click again to remove</em>
          ) : (
            flag && (
              <button className="pnl-flag" onClick={onToggle} title="Open the row to settle it">
                {flag}
              </button>
            )
          )}
        </span>
      </div>
      {open && (
        <div className="pnl-detail">
          <Detail
            row={row}
            repoRoot={repoRoot}
            armed={armed}
            busy={busy}
            onFlip={onFlip}
            onMatch={onMatch}
            onRemove={onRemove}
            onArm={onArm}
            setNotice={setNotice}
          />
        </div>
      )}
    </>
  )
}

/**
 * The row opened up: what each agent actually runs, what to do about a
 * disagreement, and — for a server — whether it answers at all. Everything about the
 * object is here, because the object is the row.
 */
function Detail({
  row,
  repoRoot,
  armed,
  busy,
  onFlip,
  onMatch,
  onRemove,
  onArm,
  setNotice
}: {
  row: PanelRow
  repoRoot: string | null
  armed: string | null
  busy: string | null
  onFlip: (row: PanelRow, agent: Provider, on: boolean) => void
  onMatch: (row: PanelRow, source: Provider) => void
  onRemove: (row: PanelRow) => void
  onArm: (key: string | null) => void
  setNotice: (n: Notice) => void
}): JSX.Element {
  const holders = PROVIDERS.filter((p) => agentHasIt(row.cells[p].state))
  const removeArmed = armed === row.id
  return (
    <div className="pnl-detail-body">
      {row.kind === 'mcp' && <McpHealth row={row} repoRoot={repoRoot} setNotice={setNotice} />}

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
              .filter((field) => holders.some((p) => (row.cells[p].fields[field] ?? '') !== ''))
              .map((field) => {
                // a field one agent simply doesn't record is unknown, not a difference
                const values = holders
                  .filter((p) => field in row.cells[p].fields)
                  .map((p) => row.cells[p].fields[field])
                return (
                  <tr key={field} className={values.some((v) => v !== values[0]) ? 'differs' : ''}>
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

      {row.disagree && (
        <div className="pnl-fix">
          <span className="pnl-fix-what">
            {listOf(row.holders.map((p) => PROVIDER_LABEL[p]))} don’t run the same {row.name}. Which
            one is right?
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
                ? `${PROVIDER_LABEL[p]} doesn’t have ${row.name}, but it’s switched on.`
                : `${PROVIDER_LABEL[p]} has ${row.name} even though it’s switched off.`}
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

      {row.kind !== 'instructions' && (
        <div className="pnl-detail-actions">
          <button
            className={`btn-ghost small ${removeArmed ? 'armed' : ''}`}
            disabled={busy !== null}
            aria-label={
              removeArmed
                ? `Confirm removing ${row.name} everywhere`
                : `Remove ${row.name} everywhere`
            }
            title="Take it out of every agent. Cockpit keeps a copy, so you can put it back."
            onBlur={() => {
              if (removeArmed) onArm(null)
            }}
            onClick={() => (removeArmed ? onRemove(row) : onArm(row.id))}
          >
            {removeArmed ? 'remove everywhere?' : 'Remove everywhere'}
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Whether the server answers — the one thing no switch can tell you. It lives on the
 * server's own row rather than in a tab of its own, because it is a fact about this
 * server and nothing else.
 */
function McpHealth({
  row,
  repoRoot,
  setNotice
}: {
  row: PanelRow
  repoRoot: string | null
  setNotice: (n: Notice) => void
}): JSX.Element {
  const [status, setStatus] = useState<McpProbeResult | 'checking' | null>(null)
  const [loginBusy, setLoginBusy] = useState<Provider | null>(null)

  const check = async (): Promise<void> => {
    setStatus('checking')
    try {
      setStatus(await api.checkMcp(row.name))
    } catch (err) {
      setStatus({ status: 'error', detail: err instanceof Error ? err.message : String(err) })
    }
  }

  const login = async (agent: Provider): Promise<void> => {
    setNotice({
      text: `Logging in to “${row.name}” with ${PROVIDER_LABEL[agent]} — finish the flow in your browser.`,
      kind: 'ok'
    })
    setLoginBusy(agent)
    try {
      setNotice({ text: await api.loginMcp(row.name, agent, repoRoot ?? undefined), kind: 'ok' })
      void check()
    } catch (err) {
      setNotice({ text: `Login failed: ${err instanceof Error ? err.message : err}`, kind: 'error' })
    } finally {
      setLoginBusy(null)
    }
  }

  const result = status === 'checking' || status === null ? null : status
  return (
    <div className="pnl-health">
      <span className="pnl-health-what">
        {status === null
          ? 'Cockpit hasn’t asked this server anything yet.'
          : status === 'checking'
            ? 'Asking the server…'
            : (result!.detail ?? MCP_STATUS_SAID[result!.status])}
      </span>
      {result && (
        <span className={`mcp-status ${result.status}`}>{MCP_STATUS_LABEL[result.status]}</span>
      )}
      <div className="pnl-fix-actions">
        {result?.status === 'needs-auth' &&
          row.holders
            .filter((a) => LOGIN_AGENTS.includes(a))
            .map((a) => (
              <button
                key={a}
                className="btn-ghost small"
                disabled={loginBusy !== null}
                title={`Run “${a} mcp login ${row.name}” — opens your browser`}
                onClick={() => void login(a)}
              >
                {loginBusy === a ? 'waiting…' : `Log in · ${PROVIDER_LABEL[a]}`}
              </button>
            ))}
        <button
          className="btn-ghost small"
          disabled={status === 'checking'}
          title="Run the configured command, or hit the URL"
          onClick={() => void check()}
        >
          {status === 'checking' ? 'checking…' : 'Check'}
        </button>
      </div>
    </div>
  )
}
