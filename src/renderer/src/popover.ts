import { useEffect, useRef, type RefObject } from 'react'

type DismissOptions = {
  /** Mousedowns in here are not "outside" either — a trigger wrapped with its panel */
  readonly inside?: RefObject<HTMLElement | null>
  /** Listen for the outside mousedown only from the next tick, so the click that
   *  opened the panel can't close it */
  readonly deferMouseDown?: boolean
  /** Bind Escape (close, refocus the trigger) and ↑/↓ (move focus between the
   *  panel's elements matching this selector) on the document — for a panel whose
   *  trigger keeps focus. A panel that takes focus handles its own keys instead. */
  readonly keyItems?: string
}

/**
 * Popover plumbing shared by the app's portaled panels: outside mousedown closes,
 * a resize closes, page scroll detaches a fixed panel from its trigger so it closes
 * too — but the panel's own scrolling never does.
 *
 * Escape and the arrow keys (`keyItems`) are bound on the document, not the panel,
 * because the trigger keeps focus when a panel opens — a handler on the panel alone
 * would never see the key that the user actually pressed.
 *
 * The listeners are re-bound whenever `close` changes identity: pass a stable one
 * unless re-binding on every render is what the caller wants.
 */
export function useDismissable<T extends HTMLElement = HTMLDivElement>(
  open: boolean,
  close: (refocus: boolean) => void,
  { inside, deferMouseDown = false, keyItems }: DismissOptions = {}
): { readonly panelRef: RefObject<T | null> } {
  const panelRef = useRef<T>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node
      if (!panelRef.current?.contains(target) && !inside?.current?.contains(target)) close(false)
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
      if (keyItems === undefined || (e.key !== 'ArrowDown' && e.key !== 'ArrowUp')) return
      const items = [...(panelRef.current?.querySelectorAll<HTMLElement>(keyItems) ?? [])]
      if (items.length === 0) return
      e.preventDefault()
      const at = items.indexOf(document.activeElement as HTMLElement)
      const step = e.key === 'ArrowDown' ? 1 : -1
      items[(at + step + items.length) % items.length].focus()
    }
    // a deferred mousedown waits a tick so the click that opened the panel can't close it
    const t = deferMouseDown
      ? setTimeout(() => document.addEventListener('mousedown', onDown))
      : undefined
    if (!deferMouseDown) document.addEventListener('mousedown', onDown)
    window.addEventListener('resize', onAway)
    document.addEventListener('scroll', onScroll, true)
    if (keyItems !== undefined) document.addEventListener('keydown', onKey, true)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', onAway)
      document.removeEventListener('scroll', onScroll, true)
      if (keyItems !== undefined) document.removeEventListener('keydown', onKey, true)
    }
  }, [open, close, inside, deferMouseDown, keyItems])

  return { panelRef }
}

export type Anchor = { readonly top: number; readonly left: number }

/** Where a panel goes: under its trigger, nudged left when the window would clip it. */
export function anchorTo(el: HTMLElement | null, width: number): Anchor | null {
  const r = el?.getBoundingClientRect()
  if (!r) return null
  return { top: r.bottom + 4, left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)) }
}
