import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatBinding } from './chat-binding'
import { arrive, followMint, NAV_START, type NavEntry, type View } from './nav-history'

/** Where the window is: the view, and for a chat the conversation bound to it. */
export type NavPlace = {
  readonly view: View
  readonly binding: ChatBinding | null
  readonly sessionId: string | null
}

export type NavHistoryControls = {
  /** Step back (-1) or forward (1): the entry landed on, for the caller to restore — or
   *  null, and nothing moves, at either end of history */
  readonly step: (delta: -1 | 1) => NavEntry | null
  /** A conversation's session id was minted: its entries follow it (`followMint`) */
  readonly followMint: (mint: Parameters<typeof followMint>[1]) => void
}

/**
 * The ⌘[/⌘] history. Every arrival lands in it: a push truncates the forward entries,
 * and re-landing on the current entry (a ⌘[/⌘] restore, or a session-id mint already
 * followed in place) dedupes instead of growing the stack.
 */
export function useNavHistory({ view, binding, sessionId }: NavPlace): NavHistoryControls {
  const [nav, setNav] = useState(NAV_START)
  const navRef = useRef(nav)
  navRef.current = nav

  useEffect(() => {
    let entry: NavEntry
    if (view.kind === 'chat') {
      if (!binding) return
      entry = { kind: 'chat', binding, sessionId }
    } else {
      entry = { kind: 'view', view }
    }
    setNav((n) => arrive(n, entry))
  }, [view, binding, sessionId])

  const step = useCallback((delta: -1 | 1): NavEntry | null => {
    const { stack, index } = navRef.current
    const entry = stack[index + delta]
    if (!entry) return null
    setNav({ stack, index: index + delta })
    return entry
  }, [])

  const follow = useCallback((mint: Parameters<typeof followMint>[1]) => {
    setNav((n) => followMint(n, mint))
  }, [])

  return { step, followMint: follow }
}
