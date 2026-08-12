import { useEffect, useId, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'

export type SelectOption = {
  readonly value: string
  readonly label: string
  /** Right-aligned dim annotation (e.g. a count or state) */
  readonly hint?: string
  /** Tooltip for the option row */
  readonly title?: string
}

/**
 * The app's own dropdown — native <select> popups are OS-rendered and can't match
 * the design system. Trigger button + fixed-position listbox (fixed so cards with
 * overflow:hidden can't clip it), full keyboard support: arrows/Home/End, Enter/
 * Space, Escape (returns focus), type-ahead.
 */
export function Select({
  value,
  options,
  onChange,
  ariaLabel,
  id,
  className = '',
  mono = false,
  quiet = false,
  title
}: {
  value: string
  options: SelectOption[]
  onChange: (value: string) => void
  ariaLabel?: string
  id?: string
  className?: string
  /** Machine identifiers (accounts, branches) render mono */
  mono?: boolean
  /** Borderless trigger for use inside an already-bordered control */
  quiet?: boolean
  title?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; minWidth: number }>()
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const typeahead = useRef({ buf: '', at: 0 })
  const listId = useId()

  const selectedIdx = Math.max(0, options.findIndex((o) => o.value === value))
  const selected = options[selectedIdx]
  // an aria-label on the trigger would *replace* its contents, so the chosen option
  // would never be announced ("Permission mode", never "Auto-edit"). Name the trigger
  // from label + value instead, the way a native <select> reads.
  const nameId = `${listId}-name`
  const valueId = `${listId}-value`
  const popId = `${listId}-pop`

  const openList = (): void => {
    const r = triggerRef.current?.getBoundingClientRect()
    if (!r) return
    const below = window.innerHeight - r.bottom
    // open upward when the space below can't fit a reasonable list
    setPos(
      below < Math.min(300, options.length * 28 + 12) && r.top > below
        ? { bottom: window.innerHeight - r.top + 4, left: r.left, minWidth: r.width }
        : { top: r.bottom + 4, left: r.left, minWidth: r.width }
    )
    setActive(selectedIdx)
    setOpen(true)
  }

  const close = (refocus: boolean): void => {
    setOpen(false)
    if (refocus) triggerRef.current?.focus()
  }

  const pick = (idx: number): void => {
    const o = options[idx]
    if (o) onChange(o.value)
    close(true)
  }

  useEffect(() => {
    if (!open) return
    listRef.current?.focus()
    const onDown = (e: MouseEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node) && !listRef.current?.contains(e.target as Node))
        close(false)
    }
    const onAway = (): void => close(false)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('resize', onAway)
    document.addEventListener('scroll', onAway, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', onAway)
      document.removeEventListener('scroll', onAway, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active, listId])

  const onListKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.stopPropagation()
      close(true)
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(a + 1, options.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(a - 1, 0))
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActive(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      setActive(options.length - 1)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      pick(active)
    } else if (e.key === 'Tab') {
      close(false)
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
      const now = Date.now()
      const t = typeahead.current
      t.buf = (now - t.at < 500 ? t.buf : '') + e.key.toLowerCase()
      t.at = now
      const hit = options.findIndex((o) => o.label.toLowerCase().startsWith(t.buf))
      if (hit >= 0) setActive(hit)
    }
  }

  return (
    <div ref={wrapRef} className={`select-wrap ${mono ? 'mono' : ''} ${className}`}>
      <button
        ref={triggerRef}
        type="button"
        id={id}
        className={`select-trigger ${quiet ? 'quiet' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        aria-labelledby={ariaLabel ? `${nameId} ${valueId}` : undefined}
        title={title ?? selected?.title}
        onClick={() => (open ? close(true) : openList())}
        onKeyDown={(e) => {
          if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            openList()
          }
        }}
      >
        {/* sr-only is position:absolute — out of flow, so it costs no flex width or gap */}
        {ariaLabel && <span id={nameId} className="sr-only">{ariaLabel}</span>}
        <span id={valueId} className="select-value">{selected?.label ?? ''}</span>
        <svg className="select-chev" width="10" height="6" viewBox="0 0 10 6" aria-hidden="true">
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5"
            strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {/* portaled: ancestors with backdrop-filter (chat header) or overflow:hidden
          (composer card) would otherwise trap or clip a fixed popup */}
      {open && pos && createPortal(
        <ul
          ref={listRef}
          id={popId}
          className={`select-pop ${mono ? 'mono' : ''}`}
          role="listbox"
          tabIndex={-1}
          aria-label={ariaLabel}
          aria-activedescendant={`${listId}-${active}`}
          style={{ top: pos.top, bottom: pos.bottom, left: pos.left, minWidth: pos.minWidth }}
          onKeyDown={onListKey}
          onBlur={(e) => {
            if (!wrapRef.current?.contains(e.relatedTarget as Node)) close(false)
          }}
        >
          {options.map((o, i) => (
            <li
              key={o.value}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={o.value === value}
              title={o.title}
              className={`select-opt ${i === active ? 'active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault()
                pick(i)
              }}
            >
              <span className="select-opt-label">{o.label}</span>
              {o.hint && <span className="select-opt-hint">{o.hint}</span>}
              {o.value === value && (
                <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"
                  className="select-check" aria-hidden="true">
                  <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
                </svg>
              )}
            </li>
          ))}
        </ul>,
        document.body
      )}
    </div>
  )
}
