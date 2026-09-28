import { useRef, useState, type JSX, type RefObject } from 'react'
import { PROVIDERS, RECOMMENDED_MARKETPLACE, agentHasIt, type PanelReport } from '../../shared/library'
import { matchesCatalogQuery } from '../../shared/marketplace'
import type { CatalogInstall, CatalogPlugin, MarketplaceCatalog, Provider } from '../../shared/types'
import { api } from './api'
import { disarmOn } from './disarm'
import { ipcErrorText } from './ipc-error'
import type { Notice } from './notice'
import { ProviderLogo, PROVIDER_LABEL } from './logos'
import { useLoaded } from './use-loaded'

/**
 * Browse: what the marketplaces hold, before any agent holds it.
 *
 * Every other section of this panel is a mirror — it can only show what the agents
 * already have. This is the one that can show what they don't, which is what makes
 * "where do plugins come from?" answerable inside Cockpit instead of in three CLIs'
 * `--help`. It lists each marketplace the machine knows, reads the catalogue out of
 * the clone the agent already made (no network, ever), and adds by the same chip
 * click the rest of the panel switches with.
 *
 * A marketplace with no clone here — one nobody has added yet — has a catalogue only
 * its repository can answer for, so that is a **Look it up** button and never an
 * automatic fetch: browsing must not quietly call out to the internet.
 *
 * Nothing the person is on is disabled under them. While a lookup or an add runs, the
 * line stays typeable and the buttons say they are busy (`aria-disabled`, with a guard)
 * rather than dropping keyboard focus to the page; an add that lands, lighting the chip
 * it was made from, hands focus to its row.
 */

/**
 * The machine's own list with this visit's lookups laid over it. A re-read (every add
 * moves the report, which re-reads) knows only the clones here, so a catalogue read from
 * its repository would vanish with the first add. It stays in place of a row that still
 * has no catalogue of its own — taking that row's word for who has it now — and ahead of
 * the list when the machine doesn't know it at all. A clone read here wins once there is one.
 */
function withLookedUp(
  read: readonly MarketplaceCatalog[],
  lookedUp: readonly MarketplaceCatalog[]
): MarketplaceCatalog[] {
  const found = (name: string): MarketplaceCatalog | undefined => lookedUp.find((c) => c.name === name)
  const merged = read.map((c) => {
    const remote = c.origin === 'local' ? undefined : found(c.name)
    return remote ? { ...remote, agents: c.agents, ...(c.source ? { source: c.source } : {}) } : c
  })
  return [...lookedUp.filter((f) => !read.some((c) => c.name === f.name)), ...merged]
}

export function MarketBrowse({
  report,
  query,
  busy,
  onAdd,
  setNotice
}: {
  /** what the agents already have — a catalogue row says "installed" from this */
  report: PanelReport
  query: string
  /** the panel's busy key, so one write at a time across the whole card */
  busy: string | null
  /** resolves true once the add landed */
  onAdd: (item: CatalogInstall, agent: Provider, said: string) => Promise<boolean>
  setNotice: (n: Notice) => void
}): JSX.Element {
  // read on arrival, and again whenever the panel's report moves: an install is what
  // turns a catalogue row from "add" into "already there"
  const loaded = useLoaded(() => api.listCatalogs(), [report])
  /** catalogues read from their repositories this visit, newest first */
  const [lookedUp, setLookedUp] = useState<readonly MarketplaceCatalog[]>([])
  const catalogs: readonly MarketplaceCatalog[] | null =
    loaded.value === null ? null : withLookedUp(loaded.value, lookedUp)
  /** marketplaces whose plugin list is open, by name */
  const [open, setOpen] = useState<readonly string[]>([])
  /** the source typed into the lookup line */
  const [source, setSource] = useState('')
  const [looking, setLooking] = useState<string | null>(null)

  /** Read one marketplace's catalogue from its repository. The one call that fetches. */
  const lookUp = async (ask: string): Promise<MarketplaceCatalog | null> => {
    const wanted = ask.trim()
    if (wanted === '' || looking !== null) return null
    setLooking(wanted)
    setNotice(null)
    try {
      const found = await api.lookupMarketplace(wanted)
      setLookedUp((list) => [found, ...list.filter((c) => c.name !== found.name)])
      setOpen((names) => (names.includes(found.name) ? names : [...names, found.name]))
      setSource('')
      setNotice({
        text: `${found.name} offers ${found.plugins.length} plugin${found.plugins.length === 1 ? '' : 's'}.`,
        kind: 'ok'
      })
      return found
    } catch (err) {
      setNotice({ text: ipcErrorText(err), kind: 'error' })
      return null
    } finally {
      setLooking(null)
    }
  }

  if (catalogs === null) {
    return (
      <div className="tree-empty">
        {loaded.error ?? 'reading the marketplaces on this machine…'}
      </div>
    )
  }

  const q = query.trim()
  // a search reaches into every catalogue and opens what it matched
  const shown = catalogs
    .map((catalog) => ({
      catalog,
      plugins: catalog.plugins.filter((p) => matchesCatalogQuery(p, q)),
      // a marketplace whose own name is what was typed keeps all of its plugins
      named: q !== '' && catalog.name.toLowerCase().includes(q.toLowerCase())
    }))
    .filter(({ plugins, named }) => q === '' || named || plugins.length > 0)

  return (
    <>
      <div className="market-lookup">
        <label className="ns-label" htmlFor="market-source">
          Look up a marketplace
        </label>
        <div className="market-lookup-row">
          <div className="ns-opt">
            <input
              id="market-source"
              type="text"
              placeholder="owner/repo, or a github.com URL"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void lookUp(source)
              }}
            />
          </div>
          <button
            className="btn-ghost small"
            aria-disabled={source.trim() === '' || looking !== null}
            onClick={() => void lookUp(source)}
          >
            {looking !== null ? 'reading…' : 'Look it up'}
          </button>
        </div>
        <p className="ns-hint">
          Reads that repository’s own <code>marketplace.json</code>. Nothing is installed until you
          click an agent.
        </p>
      </div>

      {shown.length === 0 && (
        <div className="tree-empty">
          {q === ''
            ? 'no marketplaces here yet — look one up above'
            : `nothing in these marketplaces matches “${q}”`}
        </div>
      )}

      {shown.length > 0 && (
      <div className="pnl-list">
        {shown.map(({ catalog, plugins, named }) => (
          <Market
            key={catalog.name}
            catalog={catalog}
            plugins={q === '' || named ? catalog.plugins : plugins}
            report={report}
            busy={busy}
            open={q !== '' || open.includes(catalog.name)}
            looking={looking === catalog.name || looking === catalog.source}
            onToggle={() =>
              setOpen((names) =>
                names.includes(catalog.name)
                  ? names.filter((n) => n !== catalog.name)
                  : [...names, catalog.name]
              )
            }
            onLookUp={() => lookUp(catalog.source ?? '')}
            onAdd={onAdd}
          />
        ))}
      </div>
      )}
    </>
  )
}

/** One marketplace: who has it, how to get it, and — opened — what is in it. */
function Market({
  catalog,
  plugins,
  report,
  busy,
  open,
  looking,
  onToggle,
  onLookUp,
  onAdd
}: {
  catalog: MarketplaceCatalog
  plugins: readonly CatalogPlugin[]
  report: PanelReport
  busy: string | null
  open: boolean
  looking: boolean
  onToggle: () => void
  onLookUp: () => Promise<MarketplaceCatalog | null>
  onAdd: (item: CatalogInstall, agent: Provider, said: string) => Promise<boolean>
}): JSX.Element {
  const item: CatalogInstall = {
    kind: 'marketplace',
    name: catalog.name,
    ...(catalog.source ? { source: catalog.source } : {})
  }
  /** where focus lands once the control it was on goes away — a lit chip, a read catalogue */
  const toggle = useRef<HTMLButtonElement>(null)
  return (
    <>
      <div className={`pnl-row ${open ? 'open' : ''}`}>
        <button ref={toggle} className="pnl-entry" aria-expanded={open} onClick={onToggle}>
          <span className={`pnl-caret ${open ? 'open' : ''}`} aria-hidden="true">
            ▸
          </span>
          <span className="pnl-title">{catalog.name}</span>
          {catalog.recommended && <span className="pnl-rec-tag">recommended</span>}
          <span className="pnl-kind">
            {catalog.plugins.length > 0
              ? `${catalog.plugins.length} plugin${catalog.plugins.length === 1 ? '' : 's'}`
              : 'catalogue not read'}
          </span>
          <span className="pnl-def" title={catalog.source}>
            {catalog.source ?? 'no source recorded'}
          </span>
        </button>
        <AddChips
          agents={catalog.agents}
          busy={busy}
          keyFor={(agent) => `market:${catalog.name}|${agent}`}
          what={`the ${catalog.name} marketplace`}
          where="Marketplaces"
          disabledFor={() => (catalog.source ? null : 'Cockpit has no source to add it from')}
          focusAfterAdd={toggle}
          onAdd={(agent) =>
            onAdd(
              item,
              agent,
              `${catalog.name} is added to ${PROVIDER_LABEL[agent]} — its plugins can be installed there now.`
            )
          }
        />
      </div>
      {open && (
        <div className="pnl-detail">
          <div className="pnl-detail-body">
            {catalog.problem && catalog.plugins.length === 0 && (
              <div className="pnl-ver">
                <span className="pnl-health-what">{catalog.problem}</span>
                <div className="pnl-fix-actions">
                  {catalog.recommended && (
                    <button
                      className="link-btn"
                      onClick={() => void api.openExternal(RECOMMENDED_MARKETPLACE.page)}
                    >
                      What’s in it
                    </button>
                  )}
                  {catalog.source && (
                    // named for its marketplace: the lookup line above and every unread
                    // row carry the same visible words
                    <button
                      className="btn-ghost small"
                      aria-label={looking ? undefined : `Look it up: ${catalog.name}`}
                      aria-disabled={looking}
                      // a read catalogue takes this button away: focus goes back to the row
                      onClick={() => void onLookUp().then((found) => found && toggle.current?.focus())}
                    >
                      {looking ? 'reading…' : 'Look it up'}
                    </button>
                  )}
                </div>
              </div>
            )}
            {plugins.length > 0 && (
              <ul className="market-plugins">
                {plugins.map((plugin) => (
                  <Plugin
                    key={plugin.id}
                    plugin={plugin}
                    market={catalog}
                    report={report}
                    busy={busy}
                    onAdd={onAdd}
                  />
                ))}
              </ul>
            )}
            {catalog.origin === 'remote' && (
              <p className="pnl-note">
                Read from the repository just now — this machine has no clone of{' '}
                <strong>{catalog.name}</strong> yet. Adding it to an agent makes one.
              </p>
            )}
          </div>
        </div>
      )}
    </>
  )
}

/** One plugin in a catalogue: what it is, and the agents it can be installed in. */
function Plugin({
  plugin,
  market,
  report,
  busy,
  onAdd
}: {
  plugin: CatalogPlugin
  /** the marketplace it comes from — an agent without that can't be given the plugin */
  market: MarketplaceCatalog
  report: PanelReport
  busy: string | null
  onAdd: (item: CatalogInstall, agent: Provider, said: string) => Promise<boolean>
}): JSX.Element {
  const row = report.rows.find((r) => r.kind === 'plugin' && r.name === plugin.id)
  const has = PROVIDERS.filter((p) => row !== undefined && agentHasIt(row.cells[p].state))
  // a catalogue card has no toggle of its own: its name takes focus once an add lands
  const title = useRef<HTMLSpanElement>(null)
  return (
    <li className="market-plugin">
      <span className="market-plugin-body">
        <span className="market-plugin-head">
          <span ref={title} className="pnl-title" tabIndex={-1}>
            {plugin.name}
          </span>
          {plugin.version && <span className="market-ver">v{plugin.version}</span>}
          {plugin.category && <span className="pnl-kind">{plugin.category}</span>}
        </span>
        {plugin.description && <span className="market-plugin-what">{plugin.description}</span>}
      </span>
      <AddChips
        agents={has}
        busy={busy}
        keyFor={(agent) => `plugin:${plugin.id}|${agent}`}
        what={plugin.name}
        where="Plugins"
        // an install only ever works from a marketplace that agent already has, so
        // the chip says which one to add first rather than failing on the click
        disabledFor={(agent) =>
          market.agents.includes(agent)
            ? null
            : `${PROVIDER_LABEL[agent]} hasn’t got the ${market.name} marketplace yet — add it on the row above`
        }
        focusAfterAdd={title}
        onAdd={(agent) =>
          onAdd(
            { kind: 'plugin', name: plugin.id },
            agent,
            `${plugin.name} is installed in ${PROVIDER_LABEL[agent]} — restart that CLI to pick it up.`
          )
        }
      />
    </li>
  )
}

/**
 * The panel's own chip, add-only. An agent that already has this is shown lit and
 * inert: taking something out is the owning section's job (Plugins, Marketplaces,
 * MCP servers), where it is an armed confirm — a browse surface must not be able to
 * uninstall by a mis-click on the row you were reading. Both halves of Browse use it.
 *
 * An add that writes code to run (a registry server launched by `npx -y` or `uvx`) asks
 * first: `armed` is the chip in its confirm step, which backs out on blur or Escape.
 *
 * While any write runs the chips are `aria-disabled`, not disabled — the one clicked
 * keeps keyboard focus — and a click then does nothing. The add that lands lights the
 * chip, which is inert from then on, so focus moves to `focusAfterAdd` first.
 */
export function AddChips({
  agents,
  busy,
  keyFor,
  what,
  where,
  disabledFor,
  onAdd,
  armed = null,
  armedSays,
  onDisarm,
  focusAfterAdd
}: {
  /** agents that already have it */
  agents: readonly Provider[]
  busy: string | null
  keyFor: (agent: Provider) => string
  /** what a chip's label says it adds — for the screen reader and the tooltip */
  what: string
  /** the section that can switch it off again — "Plugins", "Marketplaces", "MCP servers" */
  where: string
  /** why this agent can't be given it, when it can't */
  disabledFor: (agent: Provider) => string | null
  /** resolves true once the add landed */
  onAdd: (agent: Provider) => Promise<boolean>
  /** where focus goes once an add lands: the row's toggle, or the card's name */
  focusAfterAdd?: RefObject<HTMLElement | null>
  /** the chip key in its confirm step, if any */
  armed?: string | null
  /** what the armed chip asks — its screen-reader name and its tooltip */
  armedSays?: (agent: Provider) => string
  onDisarm?: () => void
}): JSX.Element {
  return (
    <span className="pnl-chips">
      {PROVIDERS.map((p) => {
        const had = agents.includes(p)
        const refused = had ? null : disabledFor(p)
        const key = keyFor(p)
        const isArmed = armed === key && !had && refused === null
        const asks = isArmed && armedSays ? armedSays(p) : null
        return (
          <button
            key={p}
            className={`ag-chip ag-${p} ${had ? 'on' : 'off'} ${isArmed ? 'armed' : ''} ${busy === key ? 'working' : ''}`}
            aria-label={
              had ? `${what} is in ${PROVIDER_LABEL[p]}` : (asks ?? `Add ${what} to ${PROVIDER_LABEL[p]}`)
            }
            title={
              had
                ? `already in ${PROVIDER_LABEL[p]} — switch it off under ${where}`
                : (refused ?? asks ?? `Add ${what} to ${PROVIDER_LABEL[p]}`)
            }
            disabled={had || refused !== null}
            aria-disabled={busy !== null}
            {...(isArmed && onDisarm ? disarmOn(onDisarm) : {})}
            onClick={() => {
              if (busy !== null) return
              void onAdd(p).then((added) => {
                if (added) focusAfterAdd?.current?.focus()
              })
            }}
          >
            <ProviderLogo p={p} size={11} />
            {PROVIDER_LABEL[p]}
          </button>
        )
      })}
    </span>
  )
}
