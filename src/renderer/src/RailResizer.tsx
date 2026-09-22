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
import { clampRail, railBounds, RAIL_STEP, setRailWidth, useRailWidth } from './rail'

/**
 * The sash on the rail's right edge: drag it, or with it focused press ← → (a step of
 * 16px, four with ⇧) and Home / End (the bounds); a double-click forgets the width.
 *
 * It reports what the rail *measures*, not what was stored — a stored width past what
 * this window can spare is held back by the stylesheet's clamp, and the number a screen
 * reader hears has to be the one on screen. The rail's width only ever moves with the
 * store or the viewport (it is a clamp() of the two), so a re-measure on each is all
 * the tracking it takes.
 */
export function RailResizer(): JSX.Element {
  const stored = useRailWidth()
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [viewport, setViewport] = useState(() => window.innerWidth)
  const [dragging, setDragging] = useState(false)
  /** Where the drag started: the pointer, and the rail. */
  const drag = useRef<{ x: number; width: number } | null>(null)

  /** What the rail measures now — its border box is the grid track. */
  const measure = useCallback((): number => {
    const rail = ref.current?.parentElement
    return rail ? Math.round(rail.getBoundingClientRect().width) : 0
  }, [])

  // re-measured after every commit that can have moved the rail: a stored width landing
  // on `.app` (App reads the same store, so it is the same commit) or a window resize —
  // which is also how a zoom change arrives
  useLayoutEffect(() => {
    setWidth(measure())
  }, [measure, stored, viewport])
  useEffect(() => {
    const onResize = (): void => setViewport(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  // while a drag runs the whole window is the sash: the cursor holds across the deck
  // and the text under it is not selected on the way (style.css, body.rail-dragging)
  useEffect(() => {
    document.body.classList.toggle('rail-dragging', dragging)
    return () => document.body.classList.remove('rail-dragging')
  }, [dragging])

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    // neither a text selection starting under the pointer nor focus leaving the
    // composer for an 8px strip — the sash is a handle, not a destination
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, width: measure() }
    setDragging(true)
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const from = drag.current
    if (!from) return
    setRailWidth(clampRail(from.width + (e.clientX - from.x), window.innerWidth))
  }
  const endDrag = (): void => {
    if (!drag.current) return
    drag.current = null
    setDragging(false)
  }
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const vw = window.innerWidth
    const step = e.shiftKey ? RAIL_STEP * 4 : RAIL_STEP
    let next: number
    switch (e.key) {
      case 'ArrowLeft':
        next = clampRail(measure() - step, vw)
        break
      case 'ArrowRight':
        next = clampRail(measure() + step, vw)
        break
      case 'Home':
        next = railBounds(vw).min
        break
      case 'End':
        next = railBounds(vw).max
        break
      default:
        return
    }
    e.preventDefault()
    setRailWidth(next)
  }

  const bounds = railBounds(viewport)
  return (
    <div
      ref={ref}
      className={dragging ? 'rail-resizer dragging' : 'rail-resizer'}
      role="separator"
      aria-orientation="vertical"
      aria-label="Sidebar width"
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize the sidebar · double-click to reset"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onKeyDown={onKeyDown}
      onDoubleClick={() => setRailWidth(null)}
    />
  )
}
