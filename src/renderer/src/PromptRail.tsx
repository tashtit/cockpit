import { memo, useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { promptLine, type Prompt } from './prompt-nav'
import { roveIndex, type RoveKeys } from './roving'

/** The rail's own arrows: up and down the marks, Home and End to either end, no wrap */
const RAIL_KEYS: RoveKeys = { next: 'ArrowDown', prev: 'ArrowUp', ends: true }

/** Where a peek hangs: from its mark's top in the rail's upper half, from its bottom below */
type Peek = { readonly index: number; readonly top?: number; readonly bottom?: number }

/**
 * The person's own messages as a column of marks on the transcript's right edge, one per
 * message — the way back to "what did I ask, and what came of it" in a long session.
 * The mark of the message being read is the accent one, drawn longer so the state is a
 * shape too; pointing at a mark (or reaching it by keyboard) shows the message, a click
 * scrolls to it (`usePromptNav`).
 *
 * One tab stop, as a toolbar is (and says it is — a vertical `toolbar`): ↑ ↓ walk the
 * messages, Home and End take the first and the latest. Every mark names ⌥⌘↑ / ⌥⌘↓, the
 * same step from anywhere in the transcript, in `aria-keyshortcuts` — the peek that shows
 * them is hidden from a screen reader. More messages than the rail holds scroll inside
 * it, keeping the one being read in view.
 */
export const PromptRail = memo(function PromptRail({
  prompts,
  current,
  onJump
}: {
  /** The same array until a message arrives, changes or leaves (ChatView keeps it so) */
  prompts: readonly Prompt[]
  /** The message being read, by its place in `prompts` */
  current: number | null
  /** Stable (`usePromptNav`) — with the two above, what keeps a keystroke or a stream
   *  flush in the chat from redrawing the rail */
  onJump: (i: number) => void
}): JSX.Element {
  // each mark's name, worked out when the messages change rather than on every render
  const labels = useMemo(() => prompts.map((p) => promptLine(p.text, 80)), [prompts])
  const railRef = useRef<HTMLElement>(null)
  const listRef = useRef<HTMLOListElement>(null)
  const [peek, setPeek] = useState<Peek | null>(null)
  const n = prompts.length
  // the one tab stop: the message being read, else the latest
  const stop = current !== null && current < n ? current : n - 1

  // keep the mark being read inside a rail too short for all of them
  useEffect(() => {
    const list = listRef.current
    const item = current === null ? null : (list?.children[current] as HTMLElement | undefined)
    if (!list || !item || list.scrollHeight <= list.clientHeight) return
    const top = item.offsetTop
    if (top >= list.scrollTop && top + item.offsetHeight <= list.scrollTop + list.clientHeight) return
    list.scrollTop = top - (list.clientHeight - item.offsetHeight) / 2
  }, [current])

  const show = (index: number, mark: HTMLElement): void => {
    const rail = railRef.current
    if (!rail) return
    const r = rail.getBoundingClientRect()
    const m = mark.getBoundingClientRect()
    const y = m.top - r.top
    setPeek(y < r.height / 2 ? { index, top: y } : { index, bottom: r.bottom - m.bottom })
  }

  const markAt = (i: number): HTMLButtonElement | null =>
    listRef.current?.children[i]?.querySelector<HTMLButtonElement>('button') ?? null

  const focusMark = (i: number): void => {
    markAt(i)?.focus()
  }

  /** The rail scrolled under a peek: it follows its mark, and goes once the mark does. */
  const follow = (): void => {
    if (!peek) return
    const list = listRef.current
    const mark = markAt(peek.index)
    const l = list?.getBoundingClientRect()
    const m = mark?.getBoundingClientRect()
    if (!mark || !l || !m || m.bottom <= l.top || m.top >= l.bottom) setPeek(null)
    else show(peek.index, mark)
  }

  const shown = peek && peek.index < n ? prompts[peek.index] : null

  return (
    <nav className="prompt-rail" aria-label="Your messages" ref={railRef}>
      <ol
        className="prompt-rail-list"
        ref={listRef}
        role="toolbar"
        aria-orientation="vertical"
        onScroll={follow}
      >
        {prompts.map((p, i) => (
          // a toolbar owns its buttons: the list item is layout, nothing to announce
          <li key={p.key} role="none">
            <button
              type="button"
              className={`prompt-tick${i === current ? ' on' : ''}`}
              tabIndex={i === stop ? 0 : -1}
              aria-label={`Message ${i + 1} of ${n}: ${labels[i]}`}
              aria-keyshortcuts="Alt+Meta+ArrowUp Alt+Meta+ArrowDown"
              aria-current={i === current ? 'location' : undefined}
              onClick={() => onJump(i)}
              onMouseEnter={(e) => show(i, e.currentTarget)}
              onMouseLeave={() => setPeek(null)}
              onFocus={(e) => show(i, e.currentTarget)}
              onBlur={() => setPeek(null)}
              onKeyDown={(e) => {
                // ⌥⌘↑ / ⌥⌘↓ are the transcript's own step, and pass through
                if (e.altKey || e.metaKey || e.ctrlKey) return
                const k = roveIndex(e.key, { at: i, count: n }, RAIL_KEYS)
                if (k === null) return
                e.preventDefault()
                if (k === i) return
                focusMark(k)
                onJump(k)
              }}
            >
              <span className="prompt-tick-mark" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ol>
      {/* the message a mark stands for — its button's name says the same to a screen reader */}
      {shown && peek && (
        <div className="prompt-peek" aria-hidden="true" style={{ top: peek.top, bottom: peek.bottom }}>
          <div className="prompt-peek-head">
            <span>
              {peek.index + 1} of {n}
            </span>
            <kbd>⌥⌘↑ ⌥⌘↓</kbd>
          </div>
          <p className="prompt-peek-text">{promptLine(shown.text, 280)}</p>
        </div>
      )}
    </nav>
  )
})
