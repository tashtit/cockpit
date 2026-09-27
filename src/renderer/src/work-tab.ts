import { useEffect, useLayoutEffect, type RefObject } from 'react'
import type { WorkTab } from '../../shared/work'
import { useTransient } from './use-transient'

/** What the Work panel's tabs share: where the panel was opened, and the ring that shows it. */

export type WorkFocus = {
  readonly tab: WorkTab
  /** The row that opened the panel, if one did — by the key the model names it by
   *  (ChatView keeps its own row keys and translates them at the panel's edge) */
  readonly key: number | null
  /** Bumped on every open, so opening the same row again scrolls to it again */
  readonly at: number
}

/** A path under the session's directory reads relative to it, like the transcript's rows. */
export function relative(path: string, cwd: string): string {
  return path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path
}

/** How long the item a row opened the panel at stays ringed */
export const RING_MS = 2_000

/**
 * A row opened the panel at something this tab `owns` (`focus.key`): bring it into view
 * inside the panel's `scroller` and ring it for a moment. Returns the ringed key — the
 * item carries it as `data-work-key` — or null once the ring is over.
 */
export function useRing(
  scroller: RefObject<HTMLElement | null>,
  focus: WorkFocus,
  owns: (key: number) => boolean
): number | null {
  const [ringed, setRinged] = useTransient<number>(RING_MS)
  useEffect(() => {
    if (focus.key !== null && owns(focus.key)) setRinged(focus.key)
  }, [focus.at])
  useLayoutEffect(() => {
    if (ringed === null) return
    scroller.current?.querySelector(`[data-work-key="${ringed}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [ringed])
  return ringed
}
