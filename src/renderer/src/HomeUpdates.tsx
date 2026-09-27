import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import type { UpdateSuggestion, UpdatesDigest } from '../../shared/types'
import { SUGGESTION_TAG, digestHeadline } from '../../shared/updates-digest'
import { api } from './api'
import { ipcErrorText } from './ipc-error'
import { ProviderLogo, PROVIDER_LABEL } from './logos'

/**
 * What is out of date, on the one screen that opens when nothing else is.
 *
 * Cockpit could already answer this four times over — Settings › About for itself,
 * Settings › Accounts for the agent CLIs, the Agents panel for a pinned MCP server
 * and for what the agents disagree on — and a person had to tour all four to find
 * out. This is the strip that asks them together: one line while it is closed,
 * because the home belongs to the board and the composer, and the list only when the
 * person opens it.
 *
 * It renders nothing at all when nothing is out of date. A quiet machine's home is
 * exactly the home it was before this existed.
 */

/** Open or closed is the person's, and it outlives the visit. */
const OPEN_KEY = 'cockpit:home-updates-open'

/**
 * The last answer, kept for the window's lifetime: coming home again paints the strip
 * at once and refreshes behind it, rather than flashing the row back in a beat later.
 * Main caches the gathering itself — this is only so the second mount has a first frame.
 */
let lastDigest: UpdatesDigest | null = null

/**
 * Ask when the window has a moment. A launch opens on this view with an index to scan
 * and a board to paint, and the digest spawns three CLIs and touches two registries —
 * it is the one thing on the page that can wait. jsdom has no idle callback, so the
 * component tests take the immediate path.
 */
function whenIdle(run: () => void): () => void {
  if (typeof window.requestIdleCallback !== 'function') {
    const timer = setTimeout(run, 0)
    return () => clearTimeout(timer)
  }
  const id = window.requestIdleCallback(run, { timeout: 3000 })
  return () => window.cancelIdleCallback?.(id)
}

/** Where a row is settled, when Cockpit can't settle it in place. */
export type UpdatesJump = {
  /** the Agents view, Global scope — where what the agents disagree on is settled */
  readonly agents: () => void
  /** Settings › About — the app's own update */
  readonly about: () => void
}

export function HomeUpdates({ jump }: { jump: UpdatesJump }): JSX.Element | null {
  const [digest, setDigest] = useState<UpdatesDigest | null>(lastDigest)
  const [open, setOpen] = useState(() => window.localStorage.getItem(OPEN_KEY) === '1')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)

  const load = useCallback((force: boolean): void => {
    const asked = api.getUpdatesDigest?.(force)
    if (!asked) return
    if (force) setBusy('all')
    void asked
      .then((next) => {
        lastDigest = next
        if (!alive.current) return
        setDigest(next)
        setError(null)
      })
      .catch((err) => alive.current && setError(ipcErrorText(err)))
      .finally(() => alive.current && setBusy(null))
  }, [])

  useEffect(() => {
    alive.current = true
    const cancel = whenIdle(() => load(false))
    return () => {
      alive.current = false
      cancel()
    }
  }, [load])

  const act = async (item: UpdateSuggestion, run: () => Promise<unknown>): Promise<void> => {
    setBusy(item.id)
    setError(null)
    try {
      await run()
      // main forgot its gathering when the write landed, so a plain ask is a fresh one —
      // `force` would pull every marketplace again, which is Check again's to do
      load(false)
    } catch (err) {
      setError(ipcErrorText(err))
      setBusy(null)
    }
  }

  const items = digest?.items ?? []
  const headline = digestHeadline(items)
  // nothing to say, and nothing on screen to say it in: the home is unchanged
  if (headline === null) return null

  const toggle = (): void => {
    setOpen((was) => {
      window.localStorage.setItem(OPEN_KEY, was ? '0' : '1')
      return !was
    })
  }

  return (
    <section className="home-news" aria-label="Updates">
      {/* `aria-controls` only while the list is there: a relationship pointing at an
          id that is not in the document is a dead "go to the controlled element" */}
      <button
        className="home-news-head"
        aria-expanded={open}
        {...(open ? { 'aria-controls': 'home-news-list' } : {})}
        onClick={toggle}
      >
        <span className={`home-news-caret ${open ? 'open' : ''}`} aria-hidden="true">
          ▸
        </span>
        <span className="home-news-lead">{headline}</span>
        <span className="home-news-more">{open ? 'hide' : 'show'}</span>
      </button>
      {open && (
        <ul className="home-news-list" id="home-news-list">
          {items.map((item) => (
            <Row key={item.id} item={item} busy={busy} jump={jump} onAct={act} />
          ))}
          {digest !== null && (
            <li className="home-news-foot">
              <span className="home-news-note">
                {digest.problems.length > 0
                  ? digest.problems.join(' · ')
                  : 'The app, your agent CLIs, pinned MCP servers, plugins and what the agents disagree on.'}
              </span>
              <button
                className="link-btn"
                disabled={busy !== null}
                title="Asks every source again, and pulls each agent’s marketplaces first"
                onClick={() => load(true)}
              >
                {busy === 'all' ? 'checking…' : 'Check again'}
              </button>
            </li>
          )}
          {error && (
            <li className="home-news-foot">
              <span className="home-news-note danger" role="alert">
                {error}
              </span>
            </li>
          )}
        </ul>
      )}
    </section>
  )
}

/**
 * One row, and its one action. An update Cockpit can make itself is made here — the
 * MCP pin and the plugin update the Agents panel makes too, the Terminal a CLI update
 * has always needed. Anything else leads to the view that owns it rather than growing
 * a second place to do it.
 */
function Row({
  item,
  busy,
  jump,
  onAct
}: {
  item: UpdateSuggestion
  busy: string | null
  jump: UpdatesJump
  onAct: (item: UpdateSuggestion, run: () => Promise<unknown>) => Promise<void>
}): JSX.Element {
  const working = busy === item.id
  const action = ((): { label: string; onClick: () => void; title?: string } => {
    switch (item.kind) {
      case 'cli':
        return {
          label: 'Update in Terminal',
          title: 'Opens Terminal on the command this CLI was installed with',
          onClick: () => void onAct(item, () => api.openCliUpdate(item.agents[0]))
        }
      case 'mcp':
        return {
          label: `Update to ${item.latest}`,
          title: 'Rewrites the pinned version wherever this server is switched on',
          onClick: () =>
            void onAct(item, () =>
              api.setMcpVersion({ repoRoot: null, kind: 'mcp', name: item.name }, item.latest ?? '')
            )
        }
      case 'plugin':
        return {
          label: `Update to ${item.latest}`,
          title: 'Updates it in every agent that has it, each through its own CLI — restart them to pick it up',
          onClick: () => void onAct(item, () => api.updatePlugin(item.name))
        }
      case 'app':
        return { label: 'Open About', onClick: jump.about }
      default:
        return { label: 'Settle it', onClick: jump.agents }
    }
  })()
  return (
    <li className="home-news-row">
      <span className="news-tag">{SUGGESTION_TAG[item.kind]}</span>
      {item.agents.length > 0 && (
        <span className="news-agents">
          {item.agents.map((p) => (
            <span key={p} className={`news-agent plogo-${p}`} title={PROVIDER_LABEL[p]}>
              <ProviderLogo p={p} size={11} />
              <span className="sr-only">{PROVIDER_LABEL[p]}</span>
            </span>
          ))}
        </span>
      )}
      <span className="news-name" title={item.name}>
        {item.name}
      </span>
      {item.current && item.latest && (
        <span className="news-jump">
          {item.current} → <strong>{item.latest}</strong>
        </span>
      )}
      <span className="news-detail" title={item.detail}>
        {item.detail}
      </span>
      <button
        className="btn-ghost small"
        disabled={busy !== null}
        title={action.title}
        onClick={action.onClick}
      >
        {working ? 'working…' : action.label}
      </button>
    </li>
  )
}
