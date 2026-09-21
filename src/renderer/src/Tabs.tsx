import { Fragment, useLayoutEffect, useRef, type JSX, type KeyboardEvent, type ReactNode } from 'react'

/**
 * The card views' one navigation: a row of `.pnl-pill` tabs over one panel. Settings,
 * Agents, Profile and Cleanup all page this way — a tab replaces the panel under it,
 * it never scrolls to a heading further down the card. A jump that scrolled took the
 * title, the row and Close off screen with it, and a card of four lists read as one
 * long page nobody could hold in their head.
 */

export type TabDef<T extends string> = {
  readonly id: T
  readonly label: string
  /** How many things the tab holds; left off at zero ("Worktrees 0" reads as a fault) */
  readonly count?: number
  /** `warn` voices the whole pill amber — Agents' "Needs you" */
  readonly tone?: 'warn'
  /** An amber dot: something behind this tab needs a look */
  readonly dot?: boolean
}

const tabId = (id: string, tab: string): string => `${id}-tab-${tab}`
const panelId = (id: string, tab: string): string => `${id}-panel-${tab}`

/**
 * One tab stop for the whole row (roving `tabIndex`); ←/→ wrap, Home/End jump to the
 * ends, and moving selects. Only the selected tab carries `aria-controls`: the other
 * panels are not in the DOM, and a tab naming one that is not there is a dead "go to
 * the controlled element".
 */
export function TabList<T extends string>({
  id,
  label,
  tabs,
  selected,
  onSelect
}: {
  /** Prefix for the tab and panel ids — pair it with the `TabPanel` below the row */
  id: string
  /** The row's accessible name ("Settings sections") */
  label: string
  tabs: readonly TabDef<T>[]
  selected: T
  onSelect: (tab: T) => void
}): JSX.Element {
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return
    const all = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]'))
    const at = all.indexOf(document.activeElement as HTMLButtonElement)
    if (at < 0) return
    e.preventDefault()
    const to =
      e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? all.length - 1
          : (at + (e.key === 'ArrowRight' ? 1 : all.length - 1)) % all.length
    all[to]?.focus()
    all[to]?.click()
  }
  return (
    <div className="pnl-tabs ns-tabs" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((t) => {
        const on = t.id === selected
        return (
          <button
            key={t.id}
            role="tab"
            id={tabId(id, t.id)}
            aria-selected={on}
            aria-controls={on ? panelId(id, t.id) : undefined}
            tabIndex={on ? 0 : -1}
            className={`pnl-pill ${t.tone === 'warn' ? 'attention' : ''} ${on ? 'active' : ''}`}
            onClick={() => onSelect(t.id)}
          >
            {t.label}
            {(t.count ?? 0) > 0 && <span className="pnl-pill-n">{t.count}</span>}
            {t.dot && <i className="pnl-pill-dot" role="img" aria-label="needs attention" />}
          </button>
        )
      })}
    </div>
  )
}

/**
 * The open tab's panel, named by its tab. A tab is a fresh page, in two senses:
 *
 * - its contents mount anew. Two panels built alike (Cleanup's lists each open with a
 *   `FilterBar`) would otherwise be reconciled as one, and the second would inherit the
 *   first one's internal state — the worktrees bar wearing the sessions bar's pins.
 * - the card's scroller (`.settings-view`, what every card view is) goes back to the
 *   top, so no panel is entered half-scrolled because the one before it was long.
 *   Layout, not effect — a paint at the old scrollTop is the flash this is here to stop.
 */
export function TabPanel({
  id,
  selected,
  children
}: {
  id: string
  selected: string
  children: ReactNode
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const view = ref.current?.closest('.settings-view')
    if (view) view.scrollTop = 0
  }, [selected])
  return (
    <div
      ref={ref}
      className="tab-panel"
      role="tabpanel"
      id={panelId(id, selected)}
      aria-labelledby={tabId(id, selected)}
    >
      <Fragment key={selected}>{children}</Fragment>
    </div>
  )
}
