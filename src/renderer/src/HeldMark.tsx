import type { JSX } from 'react'
import { HeldIcon } from './logos'

/**
 * Who drives a session, on its row: Cockpit's hexagon, marked only where Cockpit does —
 * the exception in lists mostly read from terminals and the agents' own apps — and said
 * in words beside it. `mute` drops the words where the row's own name already says them
 * (a palette option's `aria-label`).
 */
export function HeldMark({ mute = false }: { readonly mute?: boolean }): JSX.Element {
  return (
    <>
      <span className="held-mark" aria-hidden="true">
        <HeldIcon size={10} />
      </span>
      {!mute && <span className="sr-only">(in Cockpit)</span>}
    </>
  )
}
