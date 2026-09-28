import { useEffect, useRef, useState, type JSX } from 'react'
import { agentHasIt, PROVIDERS, type PanelReport } from '../../shared/library'
import { MCP_KIND_TAG } from '../../shared/mcp-source'
import type { Provider, RegistryAdd, RegistryInput, RegistryServer } from '../../shared/types'
import { api } from './api'
import { useArmedConfirm } from './ConfirmRemove'
import { plural } from './format'
import { ipcErrorText } from './ipc-error'
import type { Notice } from './notice'
import { PROVIDER_LABEL } from './logos'
import { AddChips } from './MarketBrowse'

/**
 * Browse › MCP servers: what the MCP Registry offers, before any agent runs it.
 *
 * The registry is the open catalogue MCP servers are published to — so this is the one
 * place in the panel that shows servers nobody here has. A search is the only thing
 * that reaches the network, and only on the person's submit. What an add writes is
 * decided in main from the registry's own entry; this view names the server and hands
 * over what was typed for its inputs.
 *
 * Anyone can publish there, which is why every row says who published it (the
 * registry name's namespace) and links its repository, and why a server Cockpit can't
 * write faithfully — a container image, a sign-in header — says so instead of adding
 * something that won't start.
 *
 * What an add writes is on the row before it is written: the pinned release, the
 * command line with every argument the publisher fixed, and the env it sets. The first
 * add of a server that downloads and runs a package is an armed confirm naming that
 * command, like every other click here that runs code.
 *
 * Keyboard focus is never dropped under the person: the search line stays typeable
 * while a search runs, busy buttons are `aria-disabled` rather than disabled, an add that
 * lands hands focus to its row, and how many servers came back is said politely.
 */

type Search = {
  readonly query: string
  readonly servers: readonly RegistryServer[]
  readonly next?: string
}

/**
 * The last search, kept for the window's lifetime: flipping to Plugins and back, or
 * leaving the panel, must not throw away an answer that took the network to get.
 */
let lastSearch: Search | null = null

function listOf(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** The id of a row's toggle — where focus goes when the control it was on goes away. */
function rowDomId(server: RegistryServer): string {
  return `registry-row-${server.id}@${server.version}`.replace(/[^A-Za-z0-9_-]/g, '-')
}

/** The chip's key, shared with the panel's busy key so the one being written pulses. */
function chipKey(server: RegistryServer, agent: Provider): string {
  return `registry:${server.id}|${agent}`
}

/**
 * What the row says it is: the package and the release it pins, or the host a remote
 * server is reached at — the part of a url that says where it connects.
 */
function defOf(server: RegistryServer): string {
  if (!server.what) return server.id
  if (server.kind === 'remote') {
    try {
      return new URL(server.what).host
    } catch {
      return server.what
    }
  }
  return server.release ? `${server.what} ${server.release}` : server.what
}

function matches(server: RegistryServer, q: string): boolean {
  if (q === '') return true
  return [server.title, server.id, server.description, server.what ?? '']
    .join(' ')
    .toLowerCase()
    .includes(q.toLowerCase())
}

export function McpBrowse({
  report,
  query,
  busy,
  onAdd,
  setNotice
}: {
  /** what the agents already have — a result that is already here says so from this */
  report: PanelReport
  /** the card's search: it narrows the results shown, never asks the registry again */
  query: string
  busy: string | null
  /** resolves true once the add landed */
  onAdd: (req: RegistryAdd, said: string) => Promise<boolean>
  setNotice: (n: Notice) => void
}): JSX.Element {
  const [typed, setTyped] = useState(lastSearch?.query ?? '')
  const [search, setSearch] = useState<Search | null>(lastSearch)
  const [searching, setSearching] = useState<'first' | 'more' | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  /** what was typed for each server's inputs, by server id — kept in memory, never stored */
  const [values, setValues] = useState<Readonly<Record<string, Readonly<Record<string, string>>>>>({})
  /** the chip whose add is in its confirm step */
  const { armed, arm, disarm } = useArmedConfirm()
  /** the row to focus once the next page is on screen — More results goes away on the last */
  const focusNext = useRef<string | null>(null)

  useEffect(() => {
    if (focusNext.current === null) return
    document.getElementById(focusNext.current)?.focus()
    focusNext.current = null
  }, [search])

  const run = async (more: boolean): Promise<void> => {
    const q = more ? (search?.query ?? '') : typed.trim()
    if (q === '' || searching !== null) return
    setSearching(more ? 'more' : 'first')
    setNotice(null)
    try {
      const page = await api.searchMcpRegistry(q, more ? search?.next : undefined)
      const next: Search = {
        query: q,
        servers: more ? [...(search?.servers ?? []), ...page.servers] : page.servers,
        ...(page.next ? { next: page.next } : {})
      }
      lastSearch = next
      if (more && page.servers[0]) focusNext.current = rowDomId(page.servers[0])
      setSearch(next)
      if (!more) setOpen(null)
    } catch (err) {
      setNotice({ text: ipcErrorText(err), kind: 'error' })
    } finally {
      setSearching(null)
    }
  }

  /** Who already runs it: the panel's own row when there is one, else what the search saw. */
  const holders = (server: RegistryServer): Provider[] => {
    const row = report.rows.find((r) => r.kind === 'mcp' && r.name === server.name)
    return row ? PROVIDERS.filter((p) => agentHasIt(row.cells[p].state)) : [...server.agents]
  }

  /** Resolves true once the server was added — false when the click only asked or armed. */
  const add = (server: RegistryServer, agent: Provider): Promise<boolean> => {
    const had = holders(server)
    const given = values[server.id] ?? {}
    // a server already here brings its own env: its inputs were answered the first time
    const missing =
      had.length > 0 ? [] : server.inputs.filter((i) => i.required && (given[i.name] ?? '').trim() === '')
    if (missing.length > 0) {
      setOpen(server.id)
      setNotice({
        text: `${server.title} needs ${listOf(missing.map((i) => i.name))} before it can be added — fill ${missing.length === 1 ? 'it' : 'them'} in on its row.`,
        kind: 'error'
      })
      return Promise.resolve(false)
    }
    // the first add of a server that downloads and runs a package asks, naming it
    const key = chipKey(server, agent)
    if (had.length === 0 && server.commandLine !== undefined && armed !== key) {
      arm(key)
      setOpen(server.id)
      return Promise.resolve(false)
    }
    disarm()
    const filled = Object.fromEntries(Object.entries(given).filter(([, v]) => v.trim() !== ''))
    return onAdd(
      { id: server.id, version: server.version, agent, values: had.length > 0 ? {} : filled },
      `${server.name} is on for ${PROVIDER_LABEL[agent]} — restart that CLI to pick it up.`
    )
  }

  const q = query.trim()
  const shown = (search?.servers ?? []).filter((s) => matches(s, q))

  return (
    <>
      <div className="market-lookup">
        <label className="ns-label" htmlFor="registry-query">
          Search the MCP Registry
        </label>
        <div className="market-lookup-row">
          <div className="ns-opt">
            <input
              id="registry-query"
              type="text"
              placeholder="what it does, or who makes it — github, postgres, browser…"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void run(false)
              }}
            />
          </div>
          <button
            className="btn-ghost small"
            aria-disabled={typed.trim() === '' || searching !== null}
            onClick={() => void run(false)}
          >
            {searching === 'first' ? 'searching…' : 'Search'}
          </button>
        </div>
        <p className="ns-hint">
          Anyone can publish to the registry — check who made a server before you add it. Nothing is
          added until you click an agent.
        </p>
        {/* how many came back, said once the answer is in — the list itself is silent */}
        <p className="sr-only" role="status">
          {search !== null && searching === null ? plural(search.servers.length, 'server') : ''}
        </p>
      </div>

      {search === null && (
        <div className="tree-empty">search for a server by what it does, or by who makes it</div>
      )}
      {search !== null && search.servers.length === 0 && (
        <div className="tree-empty">nothing in the registry matches “{search.query}”</div>
      )}
      {search !== null && search.servers.length > 0 && shown.length === 0 && (
        <div className="tree-empty">none of these match “{q}”</div>
      )}

      {shown.length > 0 && (
        <div className="pnl-list">
          {shown.map((server) => (
            <Server
              key={`${server.id}@${server.version}`}
              server={server}
              had={holders(server)}
              open={open === server.id}
              busy={busy}
              armed={armed}
              onDisarm={disarm}
              values={values[server.id] ?? {}}
              onToggle={() => setOpen(open === server.id ? null : server.id)}
              onType={(name, value) =>
                setValues((all) => ({ ...all, [server.id]: { ...(all[server.id] ?? {}), [name]: value } }))
              }
              onAdd={(agent) => add(server, agent)}
            />
          ))}
        </div>
      )}

      {search?.next && q === '' && (
        <div className="registry-more">
          <button className="btn-ghost small" aria-disabled={searching !== null} onClick={() => void run(true)}>
            {searching === 'more' ? 'reading…' : 'More results'}
          </button>
        </div>
      )}
    </>
  )
}

/** One registry server: what it is, who published it, what it needs, and the agents to add it to. */
function Server({
  server,
  had,
  open,
  busy,
  armed,
  onDisarm,
  values,
  onToggle,
  onType,
  onAdd
}: {
  server: RegistryServer
  /** agents that already run it */
  had: readonly Provider[]
  open: boolean
  busy: string | null
  /** the chip in its confirm step, anywhere in the list */
  armed: string | null
  onDisarm: () => void
  values: Readonly<Record<string, string>>
  onToggle: () => void
  onType: (name: string, value: string) => void
  onAdd: (agent: Provider) => Promise<boolean>
}): JSX.Element {
  // once it runs somewhere its env is settled — the other agents get the same definition
  const inputs = had.length > 0 ? [] : server.inputs
  const toggle = useRef<HTMLButtonElement>(null)
  const asking = PROVIDERS.find((p) => armed === chipKey(server, p))
  const fixed = Object.entries(server.fixedEnv ?? {})
  return (
    <>
      <div className={`pnl-row ${open ? 'open' : ''}`}>
        <button ref={toggle} id={rowDomId(server)} className="pnl-entry" aria-expanded={open} onClick={onToggle}>
          <span className={`pnl-caret ${open ? 'open' : ''}`} aria-hidden="true">
            ▸
          </span>
          <span className="pnl-title">{server.title}</span>
          <span className="pnl-kind">{server.kind ? MCP_KIND_TAG[server.kind] : 'can’t add'}</span>
          <span className="pnl-def" title={defOf(server)}>
            {defOf(server)}
          </span>
        </button>
        <AddChips
          agents={had}
          busy={busy}
          keyFor={(agent) => chipKey(server, agent)}
          what={server.title}
          where="MCP servers"
          disabledFor={(agent) =>
            server.refusal ? `Cockpit can’t add it — ${server.refusal}` : (server.unsupported[agent] ?? null)
          }
          onAdd={onAdd}
          focusAfterAdd={toggle}
          armed={armed}
          armedSays={(agent) =>
            `Add ${server.title} to ${PROVIDER_LABEL[agent]}? It runs ${server.commandLine ?? defOf(server)} — click again to add it`
          }
          onDisarm={onDisarm}
        />
        {asking && (
          <span className="pnl-state">
            <em className="pnl-flag danger">click again to add</em>
          </span>
        )}
      </div>
      {open && (
        <div className="pnl-detail">
          <div className="pnl-detail-body">
            {server.description && <p className="market-plugin-what">{server.description}</p>}
            <p className="pnl-note">
              Published as <code>{server.id}</code> · v{server.version}
              {server.name !== server.title && (
                <>
                  {' '}
                  · added as <code>{server.name}</code>
                </>
              )}
              {(server.repository ?? server.website) && (
                <>
                  {' '}
                  ·{' '}
                  <button
                    className="link-btn"
                    onClick={() => void api.openExternal((server.repository ?? server.website) as string)}
                  >
                    {server.repository ? 'Its repository' : 'Its website'}
                  </button>
                </>
              )}
            </p>
            {asking && server.commandLine && (
              <p className="pnl-note">
                <strong>
                  Adding it to {PROVIDER_LABEL[asking]} downloads {defOf(server)} and runs it whenever{' '}
                  {PROVIDER_LABEL[asking]} starts.
                </strong>{' '}
                Click {PROVIDER_LABEL[asking]} again to add it.
              </p>
            )}
            {server.commandLine && (
              <p className="pnl-note">
                Runs <code>{server.commandLine}</code>
              </p>
            )}
            {server.kind === 'remote' && server.what && (
              <p className="pnl-note">
                Connects to <code>{server.what}</code>
              </p>
            )}
            {fixed.length > 0 && (
              <p className="pnl-note">
                Its publisher sets{' '}
                {fixed.map(([name, value], i) => (
                  <span key={name}>
                    {i > 0 && ', '}
                    <code>
                      {name}={value}
                    </code>
                  </span>
                ))}
                .
              </p>
            )}
            {server.refusal && <p className="pnl-note">Cockpit can’t add it: {server.refusal}.</p>}
            {Object.entries(server.unsupported).map(([agent, why]) => (
              <p key={agent} className="pnl-note">
                {why}.
              </p>
            ))}
            {inputs.length > 0 && (
              <div className="registry-inputs">
                {inputs.map((input) => (
                  <Field
                    key={input.name}
                    server={server}
                    input={input}
                    value={values[input.name] ?? ''}
                    onType={onType}
                  />
                ))}
                <p className="ns-hint">
                  Written into each agent’s own config as {inputs.length === 1 ? 'an environment variable' : 'environment variables'}, the way the agents keep every server’s settings.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}

function Field({
  server,
  input,
  value,
  onType
}: {
  server: RegistryServer
  input: RegistryInput
  value: string
  onType: (name: string, value: string) => void
}): JSX.Element {
  const id = `registry-${server.id}-${input.name}`.replace(/[^A-Za-z0-9_-]/g, '-')
  return (
    <div className="registry-input">
      <label className="ns-label" htmlFor={id}>
        {input.name}
        {!input.required && <span className="registry-optional"> optional</span>}
      </label>
      <div className="ns-opt">
        <input
          id={id}
          type={input.secret ? 'password' : 'text'}
          autoComplete="off"
          spellCheck={false}
          placeholder={input.default ?? ''}
          value={value}
          onChange={(e) => onType(input.name, e.target.value)}
        />
      </div>
      {input.description && <p className="ns-hint">{input.description}</p>}
    </div>
  )
}
