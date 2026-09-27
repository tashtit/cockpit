import type { JSX } from 'react'
import { railBounds, setRailWidth, useRailWidth } from './rail'
import { Sash, type SashBounds } from './Sash'

/** The rail's bounds are the window's: `.app`'s clamp asks the viewport, and so does this. */
const bounds = (): SashBounds => railBounds(window.innerWidth)

/** A drag moves the grid itself — `--rail` on `.app`, which App sets from the store too. */
const preview = (px: number, rail: HTMLElement): void => {
  rail.closest<HTMLElement>('.app')?.style.setProperty('--rail', `${px}px`)
}

/**
 * The sash on the rail's right edge (`Sash.tsx`): the sidebar is as wide as the person
 * drags it, between `rail.ts`'s bounds.
 */
export function RailResizer(): JSX.Element {
  const stored = useRailWidth()
  return (
    <Sash
      edge="right"
      className="rail-resizer"
      label="Sidebar width"
      title="Drag to resize the sidebar · double-click to reset"
      bounds={bounds}
      stored={stored}
      preview={preview}
      commit={setRailWidth}
    />
  )
}
