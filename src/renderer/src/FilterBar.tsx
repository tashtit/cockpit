import { useEffect, useId, useRef, useState, type JSX, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * The filter bar: one sticky row of dimension pills, each summarising its own
 * selection, over a shared popover that can both include and exclude values.
 *
 * The pill *is* the active-filter chip — there is no second row of "you have
 * filtered by…" tokens to keep in sync, which is what makes a bar with six
 * dimensions still read at a glance. Dimensions are pinned onto the bar through
 * "Add filter"; a dimension carrying a value is always shown whether pinned or
 * not, so what you see can never misrepresent what is being filtered.
 *
 * Semantics are OR within a dimension, AND across dimensions (see `matchesFilters`).
 * An empty list always means "no constraint", never "match nothing".
 */

export type FilterOption = {
  readonly value: string
  readonly label: string
  /** Rendered before the label — an agent logo, a repo glyph */
  readonly icon?: ReactNode
}

/**
 * One dimension, fully self-describing: the bar renders whatever it is handed and
 * owns none of the state, so the same component serves every list in the app.
 */
export type FilterGroup = {
  readonly id: string
  readonly label: string
  readonly options: readonly FilterOption[]
  readonly included: readonly string[]
  readonly excluded: readonly string[]
  readonly onChange: (included: readonly string[], excluded: readonly string[]) => void
}

/** Longer option lists get their own search box inside the popover. */
const SEARCHABLE_FROM = 8

export function groupActiveCount(g: FilterGroup): number {
  return g.included.length + g.excluded.length
}

export function anyActive(groups: readonly FilterGroup[]): boolean {
  return groups.some((g) => groupActiveCount(g) > 0)
}

const labelFor = (g: FilterGroup, value: string): string =>
  g.options.find((o) => o.value === value)?.label ?? value

/**
 * What the pill says instead of its value list: "Any" → "web" → "not docs" →
 * "3 selected" → "2 selected, 1 excluded". Naming one selection outright is worth
 * far more than a count, and it is the common case.
 */
export function summarizeGroup(g: FilterGroup): string {
  const { included, excluded } = g
  if (included.length === 0 && excluded.length === 0) return 'Any'
  if (included.length === 1 && excluded.length === 0) return labelFor(g, included[0])
  if (included.length === 0 && excluded.length === 1) return `not ${labelFor(g, excluded[0])}`
  if (excluded.length === 0) return `${included.length} selected`
  if (included.length === 0) return `${excluded.length} excluded`
  return `${included.length} selected, ${excluded.length} excluded`
}

/**
 * OR within a dimension, AND across dimensions. `valuesFor` hands back every value
 * a row carries for that dimension, so a dimension may be multi-valued (a worktree
 * is both "external" and "unpushed") without changing the rule.
 */
export function matchesFilters(
  groups: readonly FilterGroup[],
  valuesFor: (groupId: string) => readonly string[]
): boolean {
  for (const g of groups) {
    if (groupActiveCount(g) === 0) continue
    const values = valuesFor(g.id)
    if (g.included.length > 0 && !values.some((v) => g.included.includes(v))) return false
    if (g.excluded.length > 0 && values.some((v) => g.excluded.includes(v))) return false
  }
  return true
}

/**
 * Popover plumbing shared by the pill and the add-filter menu: outside mousedown
 * closes, Escape closes and hands focus back, page scroll detaches a fixed panel
 * from its trigger so it closes too — but the panel's own scrolling never does.
 *
 * Escape and the arrow keys are bound on the document, not the panel, because the
 * trigger keeps focus when a panel opens — a handler on the panel alone would
 * never see the key that the user actually pressed.
 */
function useDismissable(
  open: boolean,
  close: (refocus: boolean) => void
): { readonly panelRef: React.RefObject<HTMLDivElement | null> } {
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      if (!panelRef.current?.contains(e.target as Node)) close(false)
    }
    const onAway = (): void => close(false)
    const onScroll = (e: Event): void => {
      if (e.target instanceof Node && panelRef.current?.contains(e.target)) return
      close(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close(true)
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const items = [...(panelRef.current?.querySelectorAll<HTMLElement>('[data-fb-item]') ?? [])]
      if (items.length === 0) return
      e.preventDefault()
      const at = items.indexOf(document.activeElement as HTMLElement)
      const step = e.key === 'ArrowDown' ? 1 : -1
      items[(at + step + items.length) % items.length].focus()
    }
    // mousedown is deferred a tick so the click that opened the panel can't close it
    const t = setTimeout(() => document.addEventListener('mousedown', onDown))
    window.addEventListener('resize', onAway)
    document.addEventListener('scroll', onScroll, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', onAway)
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open, close])

  return { panelRef }
}

type Anchor = { readonly top: number; readonly left: number }

/** Where a panel goes: under its trigger, nudged left when the window would clip it. */
function anchorTo(el: HTMLElement | null, width: number): Anchor | null {
  const r = el?.getBoundingClientRect()
  if (!r) return null
  return { top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) }
}

const PANEL_WIDTH = 232

function Chevron(): JSX.Element {
  return (
    <svg className="select-chev" width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
      <path
        d="M1 1l4 4 4-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** The ⊘ that turns an option into an exclusion — quiet until the row is hovered. */
function BanIcon(): JSX.Element {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.8 3.8l8.4 8.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

function FilterPill({
  group,
  onUnpin
}: {
  group: FilterGroup
  onUnpin?: () => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [pos, setPos] = useState<Anchor | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const ids = useId()
  const active = groupActiveCount(group)

  const close = (refocus: boolean): void => {
    setOpen(false)
    setQuery('')
    if (refocus) triggerRef.current?.focus()
  }
  const { panelRef } = useDismissable(open, close)

  const shown = query.trim()
    ? group.options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase()))
    : group.options

  const set = (value: string, to: 'include' | 'exclude' | 'off'): void => {
    const included = group.included.filter((v) => v !== value)
    const excluded = group.excluded.filter((v) => v !== value)
    if (to === 'include') included.push(value)
    if (to === 'exclude') excluded.push(value)
    group.onChange(included, excluded)
  }

  return (
    <div className="fb-pill-wrap">
      <button
        ref={triggerRef}
        type="button"
        className={`fb-pill ${active > 0 ? 'on' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `${ids}-panel` : undefined}
        aria-labelledby={`${ids}-label ${ids}-value`}
        onClick={() => {
          if (open) return close(true)
          setPos(anchorTo(triggerRef.current, PANEL_WIDTH))
          setOpen(true)
        }}
      >
        <span id={`${ids}-label`} className="fb-pill-label">
          {group.label}
        </span>
        <span id={`${ids}-value`} className="fb-pill-value">
          {summarizeGroup(group)}
        </span>
        <Chevron />
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            id={`${ids}-panel`}
            role="dialog"
            aria-label={`${group.label} filter`}
            className="fb-panel"
            style={{ top: pos.top, left: pos.left, width: PANEL_WIDTH }}
          >
            {group.options.length >= SEARCHABLE_FROM && (
              <input
                className="fb-search"
                type="search"
                autoFocus
                aria-label={`Filter ${group.label.toLowerCase()} options`}
                placeholder={`Filter ${group.label.toLowerCase()}…`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            )}
            <div className="fb-options">
              {shown.map((o) => {
                const included = group.included.includes(o.value)
                const excluded = group.excluded.includes(o.value)
                return (
                  <div key={o.value} className="fb-option">
                    <button
                      type="button"
                      data-fb-item
                      className={`fb-option-in ${included ? 'on' : ''} ${excluded ? 'out' : ''}`}
                      aria-pressed={included}
                      onClick={() => set(o.value, included ? 'off' : 'include')}
                    >
                      {o.icon}
                      <span className="fb-option-label">{o.label}</span>
                    </button>
                    <button
                      type="button"
                      className={`fb-option-ex ${excluded ? 'on' : ''}`}
                      aria-pressed={excluded}
                      aria-label={`Exclude ${o.label}`}
                      title={`Exclude ${o.label}`}
                      onClick={() => set(o.value, excluded ? 'off' : 'exclude')}
                    >
                      <BanIcon />
                    </button>
                  </div>
                )
              })}
              {shown.length === 0 && <p className="fb-none">No matches</p>}
            </div>
            <div className="fb-panel-foot">
              <button
                type="button"
                className="link-btn"
                disabled={active === 0}
                onClick={() => group.onChange([], [])}
              >
                Clear
              </button>
              {onUnpin && (
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    group.onChange([], [])
                    onUnpin()
                    close(false)
                  }}
                >
                  Remove from bar
                </button>
              )}
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}

function AddFilterMenu({
  groups,
  pinned,
  onPin,
  onUnpin
}: {
  groups: readonly FilterGroup[]
  pinned: ReadonlySet<string>
  onPin: (id: string) => void
  onUnpin: (id: string) => void
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<Anchor | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const ids = useId()
  const close = (refocus: boolean): void => {
    setOpen(false)
    if (refocus) triggerRef.current?.focus()
  }
  const { panelRef } = useDismissable(open, close)

  return (
    <div className="fb-pill-wrap">
      <button
        ref={triggerRef}
        type="button"
        className="fb-add"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Add filter"
        onClick={() => {
          if (open) return close(true)
          setPos(anchorTo(triggerRef.current, PANEL_WIDTH))
          setOpen(true)
        }}
      >
        <span aria-hidden="true">+</span> Add filter
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={panelRef}
            id={`${ids}-panel`}
            role="dialog"
            aria-label="Filters on the bar"
            className="fb-panel"
            style={{ top: pos.top, left: pos.left, width: PANEL_WIDTH }}
          >
            <div className="fb-options">
              {groups.map((g) => {
                const on = pinned.has(g.id)
                const active = groupActiveCount(g)
                return (
                  <button
                    key={g.id}
                    type="button"
                    role="switch"
                    data-fb-item
                    aria-checked={on}
                    disabled={g.options.length === 0}
                    className="fb-switch"
                    onClick={() => (on ? onUnpin(g.id) : onPin(g.id))}
                  >
                    <span className={`fb-switch-box ${on ? 'on' : ''}`} aria-hidden="true" />
                    <span className="fb-option-label">{g.label}</span>
                    <span className="fb-switch-hint">
                      {active > 0 ? `${active} active` : g.options.length}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>,
          document.body
        )}
    </div>
  )
}

/**
 * `search` occupies the leftmost slot, divided from the pills — free text narrows
 * the same list but is not a dimension, so it never becomes a pill. `right` is for
 * controls that reorder or reshape rather than narrow, which belong outside the bar.
 */
export function FilterBar({
  groups,
  defaultPinned,
  search,
  right
}: {
  groups: readonly FilterGroup[]
  defaultPinned: readonly string[]
  search?: {
    readonly value: string
    readonly onChange: (value: string) => void
    readonly label: string
    readonly placeholder: string
  }
  right?: ReactNode
}): JSX.Element {
  const [pinned, setPinned] = useState<ReadonlySet<string>>(() => new Set(defaultPinned))
  // a dimension carrying a value is always on the bar, pinned or not — otherwise the
  // bar would quietly hide a filter that is shaping the list
  const shown = groups.filter((g) => pinned.has(g.id) || groupActiveCount(g) > 0)
  const active = anyActive(groups)

  const clearAll = (): void => {
    for (const g of groups) if (groupActiveCount(g) > 0) g.onChange([], [])
    if (search) search.onChange('')
  }

  return (
    <div className="fb-bar">
      {search && (
        <>
          <input
            className="fb-query"
            type="search"
            aria-label={search.label}
            placeholder={search.placeholder}
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
          />
          <span className="fb-divider" aria-hidden="true" />
        </>
      )}
      <AddFilterMenu
        groups={groups}
        pinned={pinned}
        onPin={(id) => setPinned((p) => new Set(p).add(id))}
        onUnpin={(id) =>
          setPinned((p) => {
            const next = new Set(p)
            next.delete(id)
            return next
          })
        }
      />
      {shown.map((g) => (
        <FilterPill
          key={g.id}
          group={g}
          onUnpin={() =>
            setPinned((p) => {
              const next = new Set(p)
              next.delete(g.id)
              return next
            })
          }
        />
      ))}
      {(active || (search?.value ?? '') !== '') && (
        <button type="button" className="fb-clear" onClick={clearAll}>
          Clear all
        </button>
      )}
      {right && <div className="fb-right">{right}</div>}
    </div>
  )
}
