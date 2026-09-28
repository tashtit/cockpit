import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import type { SessionMessage } from '../../shared/types'
import { announceChat } from './chat-log'
import { commandKey } from './command-key'

/**
 * Moving between the messages the person sent, in a transcript that has grown long: the
 * rail of marks beside it (`PromptRail.tsx`) and ⌥⌘↑ / ⌥⌘↓. A jump puts the message at
 * the top of the transcript, so what the agent answered reads under it.
 *
 * Where each message sits is read off the DOM, never estimated — rows are every height
 * from one line to a folded twelve-step run. A message older than the DOM window has no
 * element, and counts as above everything on screen (it is): a jump to it raises the
 * window first, as a transcript-search hit does.
 */

/** One message the person sent: the key its row renders under and its place in the log. */
export type Prompt = {
  readonly key: number
  /** Its offset in the log — how far back the DOM window must reach to hold it */
  readonly index: number
  readonly text: string
}

/** Where a jump puts a message: the transcript's own top padding (`--s5`) below its edge. */
export const JUMP_MARGIN = 16
/** Rows kept above a message a jump brought into the DOM window */
const JUMP_CONTEXT = 8
/** How far down the viewport a message may start and still be the one being read */
const READ_LINE = 1 / 3

/** The rows the transcript draws as the person's own bubble — `Message`'s user branch. */
export function isPrompt(m: SessionMessage): boolean {
  return m.role === 'user' && m.kind !== 'tool_call' && m.kind !== 'tool_result' && m.kind !== 'system'
}

export function promptsOf(log: readonly SessionMessage[], keys: readonly number[]): readonly Prompt[] {
  const out: Prompt[] = []
  log.forEach((m, i) => {
    if (isPrompt(m)) out.push({ key: keys[i] ?? i, index: i, text: m.text })
  })
  return out
}

/** The same messages under the same keys, in the same places — nothing the rail draws moved. */
export function samePrompts(a: readonly Prompt[], b: readonly Prompt[]): boolean {
  return (
    a.length === b.length &&
    a.every((p, i) => p.key === b[i].key && p.index === b[i].index && p.text === b[i].text)
  )
}

/** A message on one line, cut to `max` characters — a label, not the message. */
export function promptLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/**
 * The message whose exchange is on screen. `tops` is each message's top edge against the
 * scroller's, null for one older than the DOM window. At the end of the transcript it is
 * the latest message, however far up it started; otherwise the last one that starts above
 * the reading line — the upper third, where a reader's eye sits. None when every message
 * starts below it: the reader is above the first.
 */
export function currentPrompt(
  tops: readonly (number | null)[],
  view: { readonly height: number; readonly atEnd: boolean }
): number | null {
  if (tops.length === 0) return null
  if (view.atEnd) return tops.length - 1
  const line = view.height * READ_LINE
  let found: number | null = null
  for (let i = 0; i < tops.length; i++) {
    const top = tops[i]
    if (top !== null && top > line) break
    found = i
  }
  return found
}

/**
 * Where one step goes from the message being read (`top`: where it starts, null when
 * older than the DOM window). Down is always the next message. Up is the previous one —
 * unless the reader is part-way through this one's answer, where the way back starts at
 * the message itself.
 */
export function stepPrompt(
  current: number | null,
  top: number | null,
  opts: { readonly count: number; readonly dir: 1 | -1 }
): number | null {
  const { count, dir } = opts
  if (count === 0) return null
  if (dir > 0) return current === null ? 0 : current + 1 < count ? current + 1 : null
  if (current === null) return null
  if (top === null || top < JUMP_MARGIN - 1) return current
  return current > 0 ? current - 1 : null
}

/**
 * The navigation itself: which message is being read (`current`), a jump to any one, and a
 * step to the one before or after. ⌥⌘↑ / ⌥⌘↓ step while the transcript is on screen.
 *
 * A jump is remembered while the transcript stays where the jump put it, and steps go on
 * from there: near the end a message cannot reach the top — the scroller runs out first —
 * so reading positions back would land on the same message again.
 */
export function usePromptNav(
  scrollRef: RefObject<HTMLElement | null>,
  atBottomRef: RefObject<boolean>,
  opts: {
    readonly prompts: readonly Prompt[]
    /** Rows in the log — with `index`, how far back the DOM window must reach */
    readonly total: number
    /** The DOM window's size, and the way to widen it (`useTranscriptWindow`) */
    readonly limit: number
    readonly raise: (to: number) => void
    /** The transcript is on screen — not the review in its place */
    readonly enabled: boolean
    /** A different conversation: forget the last jump */
    readonly resetKey: unknown
  }
): {
  readonly current: number | null
  readonly jump: (i: number) => void
  readonly step: (dir: 1 | -1) => void
} {
  const { prompts, total, limit, raise, enabled, resetKey } = opts
  const [current, setCurrent] = useState<number | null>(null)
  /** The last jump, while the transcript is still where it put it */
  const cursor = useRef<{ readonly index: number; readonly scrollTop: number } | null>(null)
  /** A jump waiting for the DOM window to reach its message */
  const pending = useRef<number | null>(null)
  const promptsRef = useRef(prompts)
  promptsRef.current = prompts
  const totalRef = useRef(total)
  totalRef.current = total

  const rowOf = useCallback(
    (key: number): HTMLElement | null =>
      scrollRef.current?.querySelector<HTMLElement>(`.msg-user[data-log-key="${key}"]`) ?? null,
    [scrollRef]
  )

  /** Each message's top edge against the scroller's; null for one not in the DOM window. */
  const measure = useCallback((): readonly (number | null)[] => {
    const el = scrollRef.current
    if (!el) return []
    const origin = el.getBoundingClientRect().top
    const rows = new Map<number, HTMLElement>()
    for (const row of el.querySelectorAll<HTMLElement>('.msg-user[data-log-key]'))
      rows.set(Number(row.dataset.logKey), row)
    return promptsRef.current.map((p) => {
      const row = rows.get(p.key)
      return row ? row.getBoundingClientRect().top - origin : null
    })
  }, [scrollRef])

  /** The message being read: the last jump while the view has not moved, else the view's own. */
  const locate = useCallback((): { readonly index: number | null; readonly tops: readonly (number | null)[] } => {
    const el = scrollRef.current
    const tops = measure()
    const kept = cursor.current
    if (kept && (!el || Math.abs(el.scrollTop - kept.scrollTop) > 1 || kept.index >= tops.length))
      cursor.current = null
    if (cursor.current) return { index: cursor.current.index, tops }
    if (!el) return { index: null, tops }
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 2
    return { index: currentPrompt(tops, { height: el.clientHeight, atEnd }), tops }
  }, [scrollRef, measure])

  const refresh = useCallback(() => setCurrent(locate().index), [locate])

  /** Scroll a message that is in the DOM to the top of the transcript. */
  const land = useCallback(
    (i: number, row: HTMLElement) => {
      const el = scrollRef.current
      if (!el) return
      el.scrollTop += row.getBoundingClientRect().top - el.getBoundingClientRect().top - JUMP_MARGIN
      // the auto-scroll must not take a reader back down before the scroll event says
      // where they are — unless the jump ran out at the end, where following is right
      if (el.scrollHeight - el.scrollTop - el.clientHeight >= 2) atBottomRef.current = false
      cursor.current = { index: i, scrollTop: el.scrollTop }
      setCurrent(i)
    },
    [scrollRef, atBottomRef]
  )

  const jump = useCallback(
    (i: number) => {
      const p = promptsRef.current[i]
      if (!p || !scrollRef.current) return
      const row = rowOf(p.key)
      if (row) {
        pending.current = null
        land(i, row)
        return
      }
      pending.current = i
      raise(totalRef.current - p.index + JUMP_CONTEXT)
    },
    [scrollRef, rowOf, land, raise]
  )

  const step = useCallback(
    (dir: 1 | -1) => {
      const n = promptsRef.current.length
      if (n === 0 || !scrollRef.current) return
      const { index, tops } = locate()
      const to = stepPrompt(index, index === null ? null : (tops[index] ?? null), { count: n, dir })
      if (to === null) {
        announceChat(dir < 0 ? 'No earlier message of yours' : 'No later message of yours')
        return
      }
      jump(to)
      announceChat(`Your message ${to + 1} of ${n}`)
    },
    [scrollRef, locate, jump]
  )

  // declared before the measuring effect below, so a new conversation forgets the old
  // jump before the same commit reads where the reader is
  useLayoutEffect(() => {
    cursor.current = null
    pending.current = null
  }, [resetKey])

  // the rows moved: a jump that raised the window lands once its row is drawn, and
  // the message being read is read again
  useLayoutEffect(() => {
    if (!enabled) return
    const i = pending.current
    const p = i === null ? undefined : prompts[i]
    const row = p ? rowOf(p.key) : null
    if (i !== null && row) {
      pending.current = null
      land(i, row)
      return
    }
    refresh()
  }, [prompts, limit, enabled, rowOf, land, refresh])

  // and whenever the reader scrolls, or the transcript is resized — once a frame
  useEffect(() => {
    const el = scrollRef.current
    if (!enabled || !el) return
    let frame = 0
    const later = (): void => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        refresh()
      })
    }
    el.addEventListener('scroll', later, { passive: true })
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(later)
    resize?.observe(el)
    return () => {
      el.removeEventListener('scroll', later)
      resize?.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [enabled, scrollRef, refresh])

  // ⌥⌘↑ / ⌥⌘↓ — Copilot's own keys for the same move (the palette owns the keyboard while
  // it is open, and a control that took the keys for itself keeps them)
  const stepRef = useRef(step)
  stepRef.current = step
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent): void => {
      if (!e.altKey || !commandKey(e) || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
      if (e.defaultPrevented || document.querySelector('[role="dialog"]')) return
      if (promptsRef.current.length === 0 || !scrollRef.current) return
      e.preventDefault()
      stepRef.current(e.key === 'ArrowUp' ? -1 : 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled, scrollRef])

  return { current, jump, step }
}
