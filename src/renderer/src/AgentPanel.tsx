import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import {
  KIND_BLURB,
  KIND_LABEL,
  KIND_ORDER,
  PROVIDERS,
  RECOMMENDED_MARKETPLACE,
  agentHasIt,
  isDrift,
  isRecommended,
  type AgentState,
  type PanelReport,
  type PanelRow
} from '../../shared/library'
import { fileChange } from '../../shared/instruction-changes'
import type {
  InstructionsState,
  McpProbeResult,
  McpVersion,
  PanelKind,
  Provider
} from '../../shared/types'
import { api } from './api'
import { ipcErrorText } from './ipc-error'
import { useDiffLayout } from './diff-layout'
import { APPLY_LABEL, DiffLayoutToggle, InstructionDiff } from './InstructionDiff'
import { InstructionsEditor } from './InstructionsEditor'
import { ProviderLogo, PROVIDER_LABEL } from './logos'
import { answerRecommendation, recommendationAnswered } from './recommended'
import { TabList, TabPanel, type TabDef } from './Tabs'

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

/** `link` is for an outcome that lives somewhere else — a PR the share just opened. */
type Notice = {
  text: string
  kind: 'ok' | 'error'
  link?: { href: string; label: string }
} | null

function cellKey(row: PanelRow, agent: Provider): string {
  return `${row.id}|${agent}`
}

/** "Claude and Codex", "Claude, Codex and Copilot" — never "A and B and C". */
function listOf(names: readonly string[]): string {
  if (names.length < 3) return names.join(' and ')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * Who can run this at all, when not everyone can — "Codex only" for a plugin from a
 * marketplace that ships inside Codex, "Claude only" for an MCP server in a repo scope.
 * A dashed chip alone says this to nobody: it reads as "off" at a glance.
 */
function reachWord(row: PanelRow): string | null {
  const able = PROVIDERS.filter((p) => row.cells[p].state !== 'na')
  if (able.length === PROVIDERS.length || able.length === 0) return null
  return able.length === 1
    ? `${PROVIDER_LABEL[able[0]]} only`
    : `not for ${listOf(
        PROVIDERS.filter((p) => row.cells[p].state === 'na').map((p) => PROVIDER_LABEL[p])
      )}`
}

/** "Copilot runs its own github on purpose" / "Claude and Copilot run their own …". */
function ownWords(agents: readonly Provider[], name: string): string {
  const who = listOf(agents.map((p) => PROVIDER_LABEL[p]))
  return `${who} ${agents.length > 1 ? 'run their own' : 'runs its own'} ${name} on purpose`
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
  /** what the registries said about the version-pinned servers, by server name */
  const [versions, setVersions] = useState<Readonly<Record<string, McpVersion>>>({})
  /** the scope whose registries have been asked — this costs the network, so once */
  const asked = useRef<string | null | undefined>(undefined)
  /** whether this visit offers the recommended marketplace — decided on the first report */
  const [offer, setOffer] = useState<boolean | null>(null)

  const load = useCallback(() => {
    void api
      .getPanel(repoRoot)
      .then((next) => {
        setReport(next)
        // decided with the first report, in the same render — a callout that arrived a
        // frame later would push every row under it down
        setOffer((decided) => decided ?? offerFor(next))
      })
      .catch((err) => setNotice({ text: ipcErrorText(err), kind: 'error' }))
  }, [repoRoot, setNotice])

  /**
   * Ask each registry whether a pinned server has a newer release. Failing soft is
   * the point: offline, the rows still say what they are pinned to.
   */
  const loadVersions = useCallback(() => {
    void api
      .mcpVersions(repoRoot)
      .then((list) => setVersions(Object.fromEntries(list.map((v) => [v.name, v]))))
      .catch(() => setVersions({}))
  }, [repoRoot])

  useEffect(() => {
    setReport(null)
    setOffer(null)
    setSection(null)
    setVersions({})
    asked.current = undefined
    load()
  }, [load])

  // once per scope, and only when it has a server that could have a newer release
  useEffect(() => {
    if (asked.current === repoRoot) return
    if (!report?.rows.some((r) => r.kind === 'mcp')) return
    asked.current = repoRoot
    loadVersions()
  }, [report, repoRoot, loadVersions])

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
      setNotice({ text: ipcErrorText(err), kind: 'error' })
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
        ? row.kind === 'marketplace'
          ? `${row.name} is added to ${PROVIDER_LABEL[agent]} — its plugins can be installed there now.`
          : `${row.name} is on for ${PROVIDER_LABEL[agent]} — restart that CLI to pick it up.`
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

  /** The other answer to "which one is right?": they are meant to differ. */
  const keep = (row: PanelRow, on: boolean): void =>
    void run(
      row.id,
      () => api.keepPanelDifference(target(row), on),
      on
        ? `Kept. ${ownWords(row.drift.filter((p) => row.cells[p].state === 'changed'), row.name)} — it comes back here only if that changes.`
        : `Flagging ${row.name} again wherever the agents differ.`
    )

  const restore = (row: PanelRow): void =>
    void run(row.id, () => api.restorePanelEntry(target(row)), `Put ${row.name} back.`)

  /** Bump a pinned server to the release the registry offers, wherever it runs. */
  const update = (row: PanelRow, version: string): void => {
    void run(
      row.id,
      () => api.setMcpVersion(target(row), version),
      `${row.name} is pinned to ${version} — restart those CLIs to pick it up.`
    ).then(loadVersions)
  }

  if (!report) return <div className="tree-empty">reading every agent’s config…</div>

  // instructions always has a section, even before a baseline exists: writing one is
  // the point, and an empty screen should be an invitation rather than an absence
  const kinds = KIND_ORDER.filter(
    (k) => k === 'instructions' || report.rows.some((r) => r.kind === k)
  )
  const driftRows = report.rows.filter((r) => r.drift.length > 0)
  const q = query.trim().toLowerCase()
  // gone the moment it is removed everywhere: that is an answer too
  const recommended = offer ? report.rows.find(isRecommended) : undefined
  const tabs: TabDef<Section>[] = [
    ...(driftRows.length > 0
      ? [{ id: 'attention' as const, label: 'Needs you', count: driftRows.length, tone: 'warn' as const }]
      : []),
    ...kinds.map((kind) => ({
      id: kind,
      label: KIND_LABEL[kind],
      count: report.rows.filter((r) => r.kind === kind).length,
      dot: report.rows.some((r) => r.kind === kind && r.drift.length > 0)
    })),
    ...(report.removed.length > 0
      ? [{ id: 'removed' as const, label: 'Removed', count: report.removed.length }]
      : [])
  ]
  // a section whose tab has gone — Needs you once the last drift is settled, Removed
  // once the last entry is back — falls through to where the panel would open: the
  // panel must never be named by a tab that is not there. kinds always holds
  // instructions, so there is always a section to land on.
  const current: Section =
    section !== null && tabs.some((t) => t.id === section)
      ? section
      : driftRows.length > 0
        ? 'attention'
        : kinds[0]
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
      {recommended && !q && (
        <Recommendation
          row={recommended}
          armed={armed}
          busy={busy}
          onFlip={flip}
          onArm={arm}
          onAnswer={() => {
            answerRecommendation()
            setOffer(false)
          }}
        />
      )}
      <TabList id="agents" label="Agents sections" tabs={tabs} selected={current} onSelect={setSection} />
      <TabPanel id="agents" selected={current}>
        {/* the instructions editor opens with its own explanation — a section blurb
            above it would say the same thing twice */}
        {(q !== '' || current !== 'instructions') && (
        <p className="pnl-blurb">
          {q
            ? `${rows.length} match${rows.length === 1 ? '' : 'es'} for “${query.trim()}”`
            : current === 'removed'
              ? 'Taken out of every agent. Cockpit kept a copy of each, so you can put them back.'
              : current === 'attention'
                ? 'These don’t match what’s switched on, or the agents don’t match each other. Open a row to settle it.'
                : current
                  ? `${KIND_BLURB[current]} Click an agent to switch it on or off there.`
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

        {/* in its own section the instructions row would echo the editor above it: same
            files, same drift, a second diff. What the editor lacks is only the switches —
            whose file takes part in the baseline — so that line is all that stays */}
        {!q && current === 'instructions' &&
          rows.map((row) => (
            <div key={row.id} className="pnl-sync">
              <span className="pnl-sync-label">Kept in sync for</span>
              <AgentSwitches row={row} armed={armed} busy={busy} onFlip={flip} onArm={arm} />
              {armed !== null && armed.startsWith(`${row.id}|`) && (
                <em className="pnl-flag danger">click again to remove</em>
              )}
            </div>
          ))}

        {rows.length > 0 && !(!q && current === 'instructions') && (
          <div className="pnl-list">
            {rows.map((row) => (
              <Row
                key={row.id}
                row={row}
                repoRoot={repoRoot}
                version={row.kind === 'mcp' ? versions[row.name] : undefined}
                showKind={q !== '' || current === 'attention'}
                armed={armed}
                busy={busy}
                open={open === row.id}
                onToggle={() => setOpen(open === row.id ? null : row.id)}
                onFlip={flip}
                onMatch={match}
                onKeep={keep}
                onRemove={remove}
                onArm={arm}
                onReload={load}
                onUpdate={update}
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
      </TabPanel>
    </>
  )
}

/**
 * Whether this visit offers the recommended marketplace: to someone who runs it in no
 * agent and hasn't answered the offer before. Decided once per visit, so the callout
 * stays while they add it agent by agent, and is gone the next time the panel opens.
 * Its row only exists in Global — marketplaces are per machine.
 */
function offerFor(report: PanelReport): boolean {
  const row = report.rows.find(isRecommended)
  return row !== undefined && row.holders.length === 0 && !recommendationAnswered()
}

/** What the recommended marketplace is, said once for the callout and its own row. */
const RECOMMENDED_PITCH =
  'Open-source plugins for focused commits and pull requests, secure CI, structured logging, API design and code review. Adding the marketplace installs none of them — you choose which, in each agent.'

/**
 * The panel's one recommendation: Tashtit's marketplace, offered to someone who runs it
 * in no agent. It carries the row's own switches, so adding it is an agent's chip — the
 * same reversible click as anywhere in the panel, and never more than the person picks.
 * Answering it (Not now, or Done once added) puts it away for good; the row stays under
 * Marketplaces either way.
 */
function Recommendation({
  row,
  armed,
  busy,
  onFlip,
  onArm,
  onAnswer
}: {
  row: PanelRow
  armed: string | null
  busy: string | null
  onFlip: (row: PanelRow, agent: Provider, on: boolean) => void
  onArm: (key: string | null) => void
  onAnswer: () => void
}): JSX.Element {
  return (
    <section className="pnl-rec" aria-labelledby="pnl-rec-title">
      <div className="pnl-rec-head">
        <h3 id="pnl-rec-title" className="pnl-rec-title">
          Tashtit — engineering standards for your agents
        </h3>
        <span className="pnl-rec-tag">recommended</span>
      </div>
      <p className="pnl-rec-what">{RECOMMENDED_PITCH}</p>
      <div className="pnl-rec-act">
        <span className="pnl-sync-label">Add it to</span>
        <AgentSwitches row={row} armed={armed} busy={busy} onFlip={onFlip} onArm={onArm} />
        {armed !== null && armed.startsWith(`${row.id}|`) && (
          <em className="pnl-flag danger">click again to remove</em>
        )}
        <span className="pnl-rec-more">
          <button className="link-btn" onClick={() => void api.openExternal(RECOMMENDED_MARKETPLACE.page)}>
            What’s in it
          </button>
          <button className="btn-ghost small" disabled={busy !== null} onClick={onAnswer}>
            {row.holders.length > 0 ? 'Done' : 'Not now'}
          </button>
        </span>
      </div>
    </section>
  )
}

/**
 * The row's signature: one self-labelling switch per agent, in that agent's livery.
 * Its own component because the Instructions section shows the switches without the
 * row around them — the editor above already is that row, opened.
 */
function AgentSwitches({
  row,
  armed,
  busy,
  onFlip,
  onArm
}: {
  row: PanelRow
  armed: string | null
  busy: string | null
  onFlip: (row: PanelRow, agent: Provider, on: boolean) => void
  onArm: (key: string | null) => void
}): JSX.Element {
  return (
    <span className="pnl-chips">
      {PROVIDERS.map((p) => {
        const cell = row.cells[p]
        const key = cellKey(row, p)
        if (cell.state === 'na') {
          return (
            <span key={p} className="ag-chip na" title={cell.reason}>
              <ProviderLogo p={p} size={11} />
              {PROVIDER_LABEL[p]}
              <span className="sr-only">: not available — {cell.reason}</span>
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
                : cell.kept
                  ? `${cell.detail || 'on'} — its own definition, kept on purpose`
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
  )
}

function Row({
  row,
  repoRoot,
  version,
  showKind,
  open,
  armed,
  busy,
  onToggle,
  onFlip,
  onMatch,
  onKeep,
  onRemove,
  onArm,
  onReload,
  onUpdate,
  setNotice
}: {
  row: PanelRow
  repoRoot: string | null
  /** what the registry said about this server's pinned version, when it pins one */
  version?: McpVersion
  /** the cross-kind views mix sections, so each row says which one it is */
  showKind: boolean
  open: boolean
  armed: string | null
  busy: string | null
  onToggle: () => void
  onFlip: (row: PanelRow, agent: Provider, on: boolean) => void
  onMatch: (row: PanelRow, source: Provider) => void
  onKeep: (row: PanelRow, on: boolean) => void
  onRemove: (row: PanelRow) => void
  onArm: (key: string | null) => void
  /** something outside the panel's own ops changed an agent — re-read every config */
  onReload: () => void
  onUpdate: (row: PanelRow, version: string) => void
  setNotice: (n: Notice) => void
}): JSX.Element {
  // one word for the whole row: the amber chip already says which agent
  const flag = row.drift.length > 0 ? STATE_WORD[row.cells[row.drift[0]].state] : null
  const armedHere = armed !== null && armed.startsWith(`${row.id}|`)
  const only = reachWord(row)
  return (
    <>
      <div className={`pnl-row ${open ? 'open' : ''}`}>
        <button className="pnl-entry" aria-expanded={open} onClick={onToggle}>
          <span className={`pnl-caret ${open ? 'open' : ''}`} aria-hidden="true">
            ▸
          </span>
          <span className="pnl-title">{row.name}</span>
          {isRecommended(row) && <span className="pnl-rec-tag">recommended</span>}
          {version?.status === 'update' && (
            <span
              className="mcp-bump"
              title={`${version.pkg} ${version.current} is pinned; ${version.registry} offers ${version.latest}`}
            >
              update {version.latest}
            </span>
          )}
          {showKind && <span className="pnl-kind">{KIND_LABEL[row.kind]}</span>}
          <span className="pnl-def" title={row.saved.detail}>
            {row.saved.detail}
          </span>
        </button>
        <AgentSwitches row={row} armed={armed} busy={busy} onFlip={onFlip} onArm={onArm} />
        <span className="pnl-state">
          {armedHere ? (
            <em className="pnl-flag danger">click again to remove</em>
          ) : flag ? (
            <button className="pnl-flag" onClick={onToggle} title="Open the row to settle it">
              {flag}
            </button>
          ) : (
            only && <span className="pnl-only">{only}</span>
          )}
        </span>
      </div>
      {open && (
        <div className="pnl-detail">
          <Detail
            row={row}
            repoRoot={repoRoot}
            version={version}
            armed={armed}
            busy={busy}
            onFlip={onFlip}
            onMatch={onMatch}
            onKeep={onKeep}
            onRemove={onRemove}
            onArm={onArm}
            onReload={onReload}
            onUpdate={onUpdate}
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
  version,
  armed,
  busy,
  onFlip,
  onMatch,
  onKeep,
  onRemove,
  onArm,
  onReload,
  onUpdate,
  setNotice
}: {
  row: PanelRow
  repoRoot: string | null
  version?: McpVersion
  armed: string | null
  busy: string | null
  onFlip: (row: PanelRow, agent: Provider, on: boolean) => void
  onMatch: (row: PanelRow, source: Provider) => void
  onKeep: (row: PanelRow, on: boolean) => void
  onRemove: (row: PanelRow) => void
  onArm: (key: string | null) => void
  onReload: () => void
  onUpdate: (row: PanelRow, version: string) => void
  setNotice: (n: Notice) => void
}): JSX.Element {
  const holders = PROVIDERS.filter((p) => agentHasIt(row.cells[p].state))
  const removeArmed = armed === row.id
  // two agents blocked for the same reason state it once
  const blocked = [
    ...new Set(PROVIDERS.map((p) => row.cells[p].reason).filter((r): r is string => Boolean(r)))
  ]
  return (
    <div className="pnl-detail-body">
      {version && <McpVersionLine row={row} version={version} busy={busy} onUpdate={onUpdate} />}
      {row.kind === 'mcp' && <McpHealth row={row} repoRoot={repoRoot} setNotice={setNotice} />}

      {/* a chip that can't be switched explains itself here as well as in its title:
          a tooltip is not an explanation anyone can read with a keyboard */}
      {blocked.length > 0 && <p className="pnl-note">{blocked.join(' ')}</p>}

      {isRecommended(row) && (
        <p className="pnl-note">
          {RECOMMENDED_PITCH}{' '}
          <button className="link-btn" onClick={() => void api.openExternal(RECOMMENDED_MARKETPLACE.page)}>
            What’s in it
          </button>
        </p>
      )}

      {/* the field table would only list file paths here — the honest comparison for
          instructions is each file against the baseline, line by line */}
      {row.kind === 'instructions' && (
        <InstructionsCompare repoRoot={repoRoot} setNotice={setNotice} onChanged={onReload} />
      )}

      {row.kind !== 'instructions' && row.fields.length > 0 && holders.length > 0 && (
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
            {/* the honest third answer: they are meant to differ. Kept per agent, at
                the definition on screen — a later change is drift again */}
            <button
              className="btn-ghost small"
              disabled={busy !== null}
              title="Remember what each differing agent runs as intended. The row goes quiet until one of them changes."
              onClick={() => onKeep(row, true)}
            >
              Keep as they are
            </button>
          </div>
        </div>
      )}

      {row.kept.length > 0 && (
        <div className="pnl-kept">
          <span className="pnl-kept-what">{ownWords(row.kept, row.name)}.</span>
          <button className="link-btn" disabled={busy !== null} onClick={() => onKeep(row, false)}>
            Treat as drift again
          </button>
        </div>
      )}

      {row.drift
        .filter((p) => row.cells[p].state !== 'changed' && row.kind !== 'instructions')
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
            {removeArmed ? 'Remove everywhere?' : 'Remove everywhere'}
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * The instructions row opened up: what each agent's file holds against the saved
 * baseline, line by line, with the one action that settles it on each. The baseline
 * is the one thing Cockpit really owns a version of, so unlike every other kind the
 * comparison here has a right side — and the fix is always "write it".
 */
function InstructionsCompare({
  repoRoot,
  setNotice,
  onChanged
}: {
  repoRoot: string | null
  setNotice: (n: Notice) => void
  /** an apply rewrote an agent's file — the panel's own row is now stale */
  onChanged: () => void
}): JSX.Element {
  const [state, setState] = useState<InstructionsState | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const layout = useDiffLayout()

  useEffect(() => {
    let dead = false
    void api.getInstructions(repoRoot).then((s) => {
      if (!dead) setState(s)
    })
    return () => {
      dead = true
    }
  }, [repoRoot])

  const act = async (
    path: string,
    op: () => Promise<InstructionsState>,
    ok: string
  ): Promise<void> => {
    setNotice(null)
    setBusy(path)
    try {
      setState(await op())
      setNotice({ text: ok, kind: 'ok' })
      onChanged()
    } catch (err) {
      setNotice({ text: ipcErrorText(err), kind: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const apply = (path: string): Promise<void> =>
    act(path, () => api.applyInstructions(repoRoot, path), 'Applied — restart that agent to pick it up.')

  /** The file is the newer one — a teammate's update that arrived with a pull. */
  const takeFile = (path: string): Promise<void> =>
    act(path, () => api.adoptInstructionsFrom(repoRoot, path), "Taken as the baseline — it's yours now.")

  if (!state) return <div className="tree-empty">reading each agent’s file…</div>
  if (state.baseline.trim() === '') {
    return (
      <p className="pnl-note">
        No shared baseline written yet — the <strong>Instructions</strong> section is where it goes.
      </p>
    )
  }
  const changes = state.files.map((file) => ({ file, change: fileChange(file, state.baseline) }))
  return (
    <>
      {changes.some((c) => c.change.status !== 'synced') && (
        <div className="idiff-tools">
          <DiffLayoutToggle />
        </div>
      )}
    <div className="idiff-list">
      {changes.map(({ file, change }) => {
        return (
          <InstructionDiff
            key={file.path}
            file={file}
            change={change}
            layout={layout}
            action={
              change.status !== 'synced' && (
                <>
                  {change.status === 'drifted' && (
                    <button
                      className="link-btn"
                      disabled={busy !== null}
                      aria-label={`Take the shared block in ${file.path} as the baseline`}
                      onClick={() => void takeFile(file.path)}
                    >
                      use this file&apos;s version
                    </button>
                  )}
                  <button
                    className="btn-ghost small"
                    disabled={busy !== null}
                    onClick={() => void apply(file.path)}
                  >
                    {busy === file.path ? 'applying…' : APPLY_LABEL[change.status]}
                  </button>
                </>
              )
            }
          />
        )
      })}
    </div>
    </>
  )
}

/** What the pill says beside a version line — never the same words as the sentence. */
const VERSION_LABEL: Record<McpVersion['status'], string> = {
  update: 'update',
  current: 'up to date',
  unknown: 'not checked'
}

/**
 * The version question, which only a pinned server has: it runs exactly what the
 * definition says, so "there is a newer one" is news, and one button moves every
 * agent that runs it. An unpinned server installs the latest at each launch and
 * never gets this line — its own label already says so.
 */
function McpVersionLine({
  row,
  version,
  busy,
  onUpdate
}: {
  row: PanelRow
  version: McpVersion
  busy: string | null
  onUpdate: (row: PanelRow, version: string) => void
}): JSX.Element {
  const latest = version.latest
  const said =
    version.status === 'update'
      ? `${version.pkg} is pinned to ${version.current}; ${version.registry} has ${version.latest}.`
      : version.status === 'current'
        ? `${version.current} is the newest ${version.registry} release of ${version.pkg}.`
        : `Couldn’t ask ${version.registry} about ${version.pkg} — ${version.detail ?? 'no answer'}.`
  return (
    <div className="pnl-ver">
      <span className="pnl-health-what">{said}</span>
      <span className={`mcp-status ${version.status}`}>{VERSION_LABEL[version.status]}</span>
      {version.status === 'update' && latest && (
        <div className="pnl-fix-actions">
          <button
            className="btn-ghost small"
            disabled={busy !== null}
            title="Rewrite the pinned version wherever this server is switched on — nothing else in the command changes"
            onClick={() => onUpdate(row, latest)}
          >
            {busy === row.id ? 'pinning…' : `Update to ${latest}`}
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
      setStatus({ status: 'error', detail: ipcErrorText(err) })
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
      setNotice({ text: `Login failed: ${ipcErrorText(err)}`, kind: 'error' })
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
