import type { JSX } from 'react'
import type { Provider } from '../../shared/types'
import { ProviderLogo } from './logos'

/**
 * A roundtable's seats as a cluster of agent logos, in seat order — where a session
 * shows its one agent, a table shows everyone at it.
 */
export function SeatCluster({
  providers,
  size = 10,
  className,
  label,
  decorative = false
}: {
  readonly providers: readonly Provider[]
  readonly size?: number
  /** A class beside `rt-seats` — the board puts the cluster in its lead column */
  readonly className?: string
  /** Names the cluster as one image, where nothing around it names the seats */
  readonly label?: string
  /** Hidden from assistive tech, where the row already says who sits at the table */
  readonly decorative?: boolean
}): JSX.Element {
  const a11y = label
    ? { role: 'img', 'aria-label': label }
    : decorative
      ? { 'aria-hidden': true as const }
      : {}
  return (
    <span className={className ? `rt-seats ${className}` : 'rt-seats'} {...a11y}>
      {/* a table can seat the same agent twice: the seat, not the agent, is the key */}
      {providers.map((p, i) => (
        <span key={`${p}-${i}`} className={`rt-seat plogo-${p}`}>
          <ProviderLogo p={p} size={size} />
        </span>
      ))}
    </span>
  )
}
