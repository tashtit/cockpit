import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { SessionMessage } from '../../shared/types'
import type { TranscriptAnchor } from './chat-binding'
import { announceChat } from './chat-log'
import { findAnchor } from './transcript-anchor'

/** Rows kept above a message a search landed on, so it reads in its context */
const ANCHOR_CONTEXT = 8
/** How long the ring stays on a message a search landed on */
const ANCHOR_RING_MS = 3_000

/**
 * A transcript-search hit: find the message it meant once the log is in, bring it
 * into the DOM window, scroll it to the middle and ring it for a moment. Applied once
 * per anchor — the log keeps growing under a live session and must not re-scroll.
 *
 * Returns the key of the row to ring (`data-log-key`), or null once the ring is over.
 */
export function useTranscriptAnchor(
  anchor: TranscriptAnchor | null,
  {
    log,
    keys,
    limit,
    raise,
    scrollRef,
    atBottomRef
  }: {
    readonly log: readonly SessionMessage[]
    readonly keys: readonly number[]
    /** The transcript window's size — the row is scrolled to once it is inside it */
    readonly limit: number
    /** Widens the transcript window to at least this many rows */
    readonly raise: (to: number) => void
    readonly scrollRef: RefObject<HTMLElement | null>
    /** The transcript's pinned-to-the-bottom flag: a landing unpins it */
    readonly atBottomRef: RefObject<boolean>
  }
): number | null {
  const [anchoredKey, setAnchoredKey] = useState<number | null>(null)
  const appliedAnchor = useRef<TranscriptAnchor | null>(null)
  const scrolledKey = useRef<number | null>(null)
  useEffect(() => {
    // a new anchor, or none (every open sets one): the old ring and scroll are forgotten
    // first, so the apply below — same commit, declared after — is what a new one gets
    setAnchoredKey(null)
    scrolledKey.current = null
    appliedAnchor.current = null
  }, [anchor])
  useEffect(() => {
    // the log lands after the binding and the anchor do, so this waits for it
    if (!anchor || anchor === appliedAnchor.current || log.length === 0) return
    appliedAnchor.current = anchor
    const idx = findAnchor(log, anchor)
    if (idx < 0) return
    raise(log.length - idx + ANCHOR_CONTEXT)
    setAnchoredKey(keys[idx] ?? null)
  }, [anchor, log, keys, raise])
  useLayoutEffect(() => {
    if (anchoredKey === null || scrolledKey.current === anchoredKey) return
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-log-key="${anchoredKey}"]`)
    if (!el) return
    scrolledKey.current = anchoredKey
    atBottomRef.current = false
    el.scrollIntoView({ block: 'center' })
    announceChat('Showing the message that matched your search')
  }, [anchoredKey, limit])
  useEffect(() => {
    if (anchoredKey === null) return
    const t = setTimeout(() => setAnchoredKey(null), ANCHOR_RING_MS)
    return () => clearTimeout(t)
  }, [anchoredKey])
  return anchoredKey
}
