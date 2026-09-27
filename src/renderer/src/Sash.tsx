import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
  type PointerEvent
} from 'react'

/** The widths a pane may take. */
export type SashBounds = { readonly min: number; readonly max: number }

/** One arrow key's worth. */
export const SASH_STEP = 16

/** A width held to the bounds, in whole pixels. */
export function clampTo(px: number, bounds: SashBounds): number {
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(px)))
}

export type SashProps = {
  /** The edge of its pane the sash sits on. The pane is its parent element. */
  readonly edge: 'left' | 'right'
  /** Where it sits on that edge (style.css); `.sash` is the look */
  readonly className: string
  /** What it sizes, for a screen reader: "Sidebar width" */
  readonly label: string
  readonly title: string
  /** The pane's id, where it has one */
  readonly controls?: string
  /**
   * The widths the pane may take, given the element it is laid out in. A module-level
   * function: it is what the sash re-measures by.
   */
  readonly bounds: (container: HTMLElement) => SashBounds
  /** The width stored now, or null — the pane moves when it does, and the sash re-measures */
  readonly stored: number | null
  /**
   * Where a drag has taken the pane, set straight on the layout while the pointer
   * moves: through the store, every move was a localStorage write and a render at the
   * pointer's rate, 60–120 times a second. The store takes the width once, where the
   * drag ends (`commit`).
   */
  readonly preview: (px: number, pane: HTMLElement) => void
  /** Remember a width — or forget it (`null`) and let the stylesheet decide */
  readonly commit: (px: number | null) => void
}

type Reading = SashBounds & { readonly width: number }

/**
 * A sash on one edge of a pane: drag it, or with it focused press ← → (a step of 16px,
 * four with ⇧) and Home / End (the pane's narrowest and widest); a double-click forgets
 * the width. The rail's (`RailResizer.tsx`) and the side panel's (`SidePanel.tsx`).
 *
 * It reports what the pane *measures*, not what was stored — a stored width past what
 * the layout can spare is held back by the stylesheet's clamp, and the number a screen
 * reader hears has to be the one on screen. So it re-measures whenever the store moves,
 * or the pane or what it is laid out in changes size: a window resize, a zoom, the
 * other pane's drag.
 */
export function Sash({ edge, className, label, title, controls, bounds, stored, preview, commit }: SashProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [at, setAt] = useState<Reading>({ width: 0, min: 0, max: 0 })
  const [dragging, setDragging] = useState(false)
  /** Where the drag started — the pointer, the pane and its bounds — and where it has taken the pane */
  const drag = useRef<{
    readonly x: number
    readonly width: number
    readonly bounds: SashBounds
    /** Mutable: the width the last move set, which the release commits (null: none yet) */
    px: number | null
  } | null>(null)
  // growing is away from the pane: rightward from its right edge, leftward from its left
  const grow = edge === 'right' ? 1 : -1

  /** The pane, what it is laid out in, and what it measures there now. */
  const read = useCallback((): (Reading & { readonly pane: HTMLElement }) | null => {
    const pane = ref.current?.parentElement
    const container = pane?.parentElement
    if (!pane || !container) return null
    // the border box: that is the grid track, or the flex basis under border-box sizing
    return { pane, width: Math.round(pane.getBoundingClientRect().width), ...bounds(container) }
  }, [bounds])
  const measure = useCallback((): void => {
    const now = read()
    if (!now) return
    setAt((was) =>
      was.width === now.width && was.min === now.min && was.max === now.max
        ? was
        : { width: now.width, min: now.min, max: now.max }
    )
  }, [read])

  // a stored width lands on the layout in the same commit that hands it here
  useLayoutEffect(() => {
    measure()
  }, [measure, stored])
  useEffect(() => {
    const pane = ref.current?.parentElement
    // jsdom has no ResizeObserver, and no layout for one to observe
    if (!pane || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(pane)
    if (pane.parentElement) observer.observe(pane.parentElement)
    return () => observer.disconnect()
  }, [measure])
  // while a drag runs the whole window is the sash: the cursor holds across the other
  // pane and the text under it is not selected on the way (style.css, body.sash-dragging)
  useEffect(() => {
    document.body.classList.toggle('sash-dragging', dragging)
    return () => document.body.classList.remove('sash-dragging')
  }, [dragging])

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    const now = read()
    if (e.button !== 0 || !now) return
    // neither a text selection starting under the pointer nor focus leaving the
    // composer for an 8px strip — the sash is a handle, not a destination
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, width: now.width, bounds: now, px: null }
    setDragging(true)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const from = drag.current
    const pane = ref.current?.parentElement
    if (!from || !pane) return
    const px = clampTo(from.width + grow * (e.clientX - from.x), from.bounds)
    if (px === from.px) return
    from.px = px
    preview(px, pane)
    setAt((was) => ({ ...was, width: px }))
  }
  const endDrag = (): void => {
    const from = drag.current
    if (!from) return
    drag.current = null
    setDragging(false)
    if (from.px !== null) commit(from.px)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const now = read()
    if (!now) return
    const step = e.shiftKey ? SASH_STEP * 4 : SASH_STEP
    let next: number
    switch (e.key) {
      case 'ArrowLeft':
        next = clampTo(now.width - grow * step, now)
        break
      case 'ArrowRight':
        next = clampTo(now.width + grow * step, now)
        break
      case 'Home':
        next = now.min
        break
      case 'End':
        next = now.max
        break
      default:
        return
    }
    e.preventDefault()
    commit(next)
  }

  return (
    <div
      ref={ref}
      className={`sash ${className}${dragging ? ' dragging' : ''}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controls}
      aria-valuemin={at.min}
      aria-valuemax={at.max}
      aria-valuenow={at.width}
      tabIndex={0}
      title={title}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={() => commit(null)}
    />
  )
}
