import type { CSSProperties, JSX, ReactNode } from 'react'
import { panelBounds, setPanelWidth, usePanelWidth } from './panel'
import { Sash, type SashBounds } from './Sash'

/** The panel's bounds are the deck's — `.work-panel`'s clamp resolves against it. */
const bounds = (deck: HTMLElement): SashBounds => panelBounds(deck.getBoundingClientRect().width)

/** A drag moves the panel itself — `--panel` on the panel, which the store sets too. */
const preview = (px: number, panel: HTMLElement): void => {
  panel.style.setProperty('--panel', `${px}px`)
}

/**
 * The frame beside a conversation — the Work panel's and the roundtable's Evidence
 * panel's: an `aside` in the deck (`.work-panel`) as wide as the person drags it by the
 * sash on its left edge (`panel.ts`), which Escape closes from anywhere inside.
 */
export function SidePanel({
  id,
  label,
  onClose,
  children
}: {
  id: string
  /** The panel's name — the landmark's, and the sash's ("Work panel width") */
  label: string
  onClose: () => void
  children: ReactNode
}): JSX.Element {
  const width = usePanelWidth()
  return (
    <aside
      id={id}
      className="work-panel"
      aria-label={label}
      style={width === null ? undefined : ({ '--panel': `${width}px` } as CSSProperties)}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        e.preventDefault()
        onClose()
      }}
    >
      {/* first: it is the panel's left edge, so Tab meets it between the conversation and the tabs */}
      <Sash
        edge="left"
        className="panel-resizer"
        label={`${label} panel width`}
        title="Drag to resize the panel · double-click to reset"
        controls={id}
        bounds={bounds}
        stored={width}
        preview={preview}
        commit={setPanelWidth}
      />
      {children}
    </aside>
  )
}
