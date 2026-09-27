/**
 * Cutting text to a length, for anything shown or sent with a cap: a snippet, a title,
 * a briefing. Lengths are UTF-16 units, as `.length` counts them.
 */

/**
 * Slice without splitting a surrogate pair — `.slice()` counts UTF-16 code units,
 * so cutting mid-emoji leaves a lone surrogate that renders as U+FFFD.
 */
export function sliceCodePoints(s: string, end: number): string {
  const cut = end > 0 && end < s.length && /[\uD800-\uDBFF]/.test(s[end - 1]) ? end - 1 : end
  return s.slice(0, cut)
}

export type ClipOptions = {
  /** drop whitespace left at the cut, so the ellipsis sits against the last word */
  readonly trimCut?: boolean
}

/** `text` when it fits in `max`; otherwise its head, cut whole-character, with `…` as the last unit. */
export function clip(text: string, max: number, opts: ClipOptions = {}): string {
  if (text.length <= max) return text
  const head = sliceCodePoints(text, max - 1)
  return `${opts.trimCut ? head.trimEnd() : head}…`
}
