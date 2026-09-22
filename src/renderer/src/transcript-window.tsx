import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX, type RefObject } from 'react'
import { ArrowDownIcon } from './logos'

/**
 * The two things a bounded, auto-scrolling transcript owes its reader, shared by the
 * chat and the roundtable so the two can never drift:
 *
 * - a way *up*: the DOM renders only the newest rows, and the line that says so is a
 *   control that shows the next batch — without moving what is on screen, since the
 *   rows land above it (`useTranscriptWindow`);
 * - a way *down*: while the reader is scrolled up and the agent writes, the auto-scroll
 *   deliberately stays off (never hijack a scroll-up) — so a key says new rows arrived
 *   below and takes them there (`useUnseenBelow`, `JumpToLatest`).
 */

/**
 * How many of the newest rows render. Starts at `step`, grows by `step` per
 * `showEarlier`, and resets when `resetKey` changes (a different conversation).
 * `raise` is for a caller that needs a particular older row on screen (an anchor).
 *
 * Growing prepends rows above the viewport, which would otherwise carry the reader
 * to the top: the scroll offset is kept by re-adding the height that landed above it,
 * in a layout effect so the frame never paints the jump. `.messages` turns the
 * browser's own scroll anchoring off (`overflow-anchor: none`), so this is the one
 * adjustment made rather than two.
 */
export function useTranscriptWindow(
  scrollRef: RefObject<HTMLElement | null>,
  step: number,
  resetKey: unknown
): { readonly limit: number; readonly showEarlier: () => void; readonly raise: (to: number) => void } {
  const [limit, setLimit] = useState(step)
  const keep = useRef<{ readonly top: number; readonly height: number } | null>(null)
  useEffect(() => {
    setLimit(step)
  }, [resetKey, step])
  useLayoutEffect(() => {
    const el = scrollRef.current
    const k = keep.current
    if (!el || !k) return
    keep.current = null
    el.scrollTop = k.top + (el.scrollHeight - k.height)
  }, [limit, scrollRef])
  const showEarlier = useCallback(() => {
    const el = scrollRef.current
    if (el) keep.current = { top: el.scrollTop, height: el.scrollHeight }
    setLimit((l) => l + step)
  }, [scrollRef, step])
  const raise = useCallback((to: number) => setLimit((l) => Math.max(l, to)), [])
  return { limit, showEarlier, raise }
}

/** The line at the top of a capped transcript: what is shown, and the way to more. */
export function EarlierRow({
  shown,
  total,
  step,
  onShow
}: {
  shown: number
  total: number
  step: number
  onShow: () => void
}): JSX.Element {
  const more = Math.min(step, total - shown)
  return (
    <div className="sys-row">
      showing the last {shown.toLocaleString()} of {total.toLocaleString()} messages ·{' '}
      <button type="button" className="link-btn" onClick={onShow}>
        show {more.toLocaleString()} earlier
      </button>
    </div>
  )
}

/**
 * Whether rows arrived below a reader who has scrolled up. `signal` is the transcript
 * (or whatever grows with it): every change while the scroller is not at the bottom
 * marks rows unseen; reaching the bottom, by scroll or by `jump`, clears it. The
 * scroller's own `onScroll` keeps `atBottomRef` and calls `settle` when it gets there.
 */
export function useUnseenBelow(
  scrollRef: RefObject<HTMLElement | null>,
  atBottomRef: RefObject<boolean>,
  signal: unknown
): {
  readonly unseen: boolean
  readonly jump: () => void
  readonly settle: () => void
  /** For a second thing that grows below (a roundtable's live blocks beside its entries) */
  readonly markUnseen: () => void
} {
  const [unseen, setUnseen] = useState(false)
  const first = useRef(true)
  const markUnseen = useCallback(() => {
    if (!atBottomRef.current) setUnseen(true)
  }, [atBottomRef])
  useEffect(() => {
    // the transcript's first arrival is the conversation opening, not news
    if (first.current) {
      first.current = false
      return
    }
    markUnseen()
  }, [signal, markUnseen])
  const settle = useCallback(() => setUnseen(false), [])
  const jump = useCallback(() => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight })
    atBottomRef.current = true
    setUnseen(false)
  }, [scrollRef, atBottomRef])
  return { unseen, jump, settle, markUnseen }
}

/**
 * The key that takes a scrolled-up reader to what arrived below. Rendered as the
 * transcript's last child: a sticky, zero-height line whose key floats above the
 * scroller's bottom edge, so showing and hiding it never moves a row. Hidden it is
 * `visibility: hidden` — out of the tab order and the accessibility tree — and the
 * `aria-live` status already said the turn ended, so the key is the way there, not
 * the announcement.
 */
export function JumpToLatest({ on, onJump }: { on: boolean; onJump: () => void }): JSX.Element {
  return (
    <div className={`jump-latest${on ? ' on' : ''}`}>
      <button type="button" className="btn-ghost small" tabIndex={on ? 0 : -1} onClick={onJump}>
        <ArrowDownIcon size={12} />
        New messages
      </button>
    </div>
  )
}
