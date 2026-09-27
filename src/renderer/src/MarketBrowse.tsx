import { useCallback, useEffect, useState, type JSX } from 'react'
import { PROVIDERS, RECOMMENDED_MARKETPLACE, agentHasIt, type PanelReport } from '../../shared/library'
import { matchesCatalogQuery } from '../../shared/marketplace'
import type { CatalogInstall, CatalogPlugin, MarketplaceCatalog, Provider } from '../../shared/types'
import { api } from './api'
import { ipcErrorText } from './ipc-error'
import { ProviderLogo, PROVIDER_LABEL } from './logos'

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
 */

/** `link` is for an outcome that lives somewhere else — the same shape the card uses. */
type Notice = {
  text: string
  kind: 'ok' | 'error'
  link?: { href: string; label: string }
} | null

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
  onAdd: (item: CatalogInstall, agent: Provider, said: string) => void
  setNotice: (n: Notice) => void
}): JSX.Element {
  const [catalogs, setCatalogs] = useState<readonly MarketplaceCatalog[] | null>(null)
  /** marketplaces whose plugin list is open, by name */
  const [open, setOpen] = useState<readonly string[]>([])
  /** the source typed into the lookup line */
  const [source, setSource] = useState('')
  const [looking, setLooking] = useState<string | null>(null)

  const load = useCallback(() => {
    const asked = api.listCatalogs?.()
    if (!asked) {
      setCatalogs([])
      return
    }
    void asked
      .then((next) => setCatalogs(next))
      .catch((err) => {
        setCatalogs([])
        setNotice({ text: ipcErrorText(err), kind: 'error' })
      })
  }, [setNotice])

  // read on arrival, and again whenever the panel's report moves: an install is what
  // turns a catalogue row from "add" into "already there"
  useEffect(() => load(), [load, report])

  /** Read one marketplace's catalogue from its repository. The one call that fetches. */
  const lookUp = async (ask: string): Promise<void> => {
    const wanted = ask.trim()
    if (wanted === '' || looking !== null) return
    setLooking(wanted)
    setNotice(null)
    try {
      const found = await api.lookupMarketplace(wanted)
      setCatalogs((list) => [found, ...(list ?? []).filter((c) => c.name !== found.name)])
      setOpen((names) => (names.includes(found.name) ? names : [...names, found.name]))
      setSource('')
      setNotice({
        text: `${found.name} offers ${found.plugins.length} plugin${found.plugins.length === 1 ? '' : 's'}.`,
        kind: 'ok'
      })
    } catch (err) {
      setNotice({ text: ipcErrorText(err), kind: 'error' })
    } finally {
      setLooking(null)
    }
  }

  if (catalogs === null) return <div className="tree-empty">reading the marketplaces on this machine…</div>

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
              disabled={looking !== null}
              onChange={(e) => setSource(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void lookUp(source)
              }}
            />
          </div>
          <button
            className="btn-ghost small"
            disabled={source.trim() === '' || looking !== null}
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
            onLookUp={() => void lookUp(catalog.source ?? '')}
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
  onLookUp: () => void
  onAdd: (item: CatalogInstall, agent: Provider, said: string) => void
}): JSX.Element {
  const item: CatalogInstall = {
    kind: 'marketplace',
    name: catalog.name,
    ...(catalog.source ? { source: catalog.source } : {})
  }
  return (
    <>
      <div className={`pnl-row ${open ? 'open' : ''}`}>
        <button className="pnl-entry" aria-expanded={open} onClick={onToggle}>
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
                      disabled={looking}
                      onClick={onLookUp}
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
  onAdd: (item: CatalogInstall, agent: Provider, said: string) => void
}): JSX.Element {
  const row = report.rows.find((r) => r.kind === 'plugin' && r.name === plugin.id)
  const has = PROVIDERS.filter((p) => row !== undefined && agentHasIt(row.cells[p].state))
  return (
    <li className="market-plugin">
      <span className="market-plugin-body">
        <span className="market-plugin-head">
          <span className="pnl-title">{plugin.name}</span>
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
 * inert: taking something out is the Plugins and Marketplaces sections' job, where
 * it is an armed confirm — a browse surface must not be able to uninstall by a
 * mis-click on the row you were reading.
 */
function AddChips({
  agents,
  busy,
  keyFor,
  what,
  where,
  disabledFor,
  onAdd
}: {
  /** agents that already have it */
  agents: readonly Provider[]
  busy: string | null
  keyFor: (agent: Provider) => string
  /** what a chip's label says it adds — for the screen reader and the tooltip */
  what: string
  /** the section that can switch it off again — "Plugins", "Marketplaces" */
  where: string
  /** why this agent can't be given it, when it can't */
  disabledFor: (agent: Provider) => string | null
  onAdd: (agent: Provider) => void
}): JSX.Element {
  return (
    <span className="pnl-chips">
      {PROVIDERS.map((p) => {
        const had = agents.includes(p)
        const refused = had ? null : disabledFor(p)
        const key = keyFor(p)
        return (
          <button
            key={p}
            className={`ag-chip ag-${p} ${had ? 'on' : 'off'} ${busy === key ? 'working' : ''}`}
            aria-label={had ? `${what} is in ${PROVIDER_LABEL[p]}` : `Add ${what} to ${PROVIDER_LABEL[p]}`}
            title={
              had
                ? `already in ${PROVIDER_LABEL[p]} — switch it off under ${where}`
                : (refused ?? `Add ${what} to ${PROVIDER_LABEL[p]}`)
            }
            disabled={had || refused !== null || busy !== null}
            onClick={() => onAdd(p)}
          >
            <ProviderLogo p={p} size={11} />
            {PROVIDER_LABEL[p]}
          </button>
        )
      })}
    </span>
  )
}
