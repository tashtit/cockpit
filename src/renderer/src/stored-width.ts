import { storedValue } from './stored-value'

/**
 * A width the person dragged something to, remembered for this machine (`stored-value.ts`):
 * the width that suits one screen is the wrong one for the next Mac's. `null` is "never
 * dragged", and then the stylesheet's own default decides — the layout every audit and
 * every screenshot is taken of.
 *
 * The rail (`rail.ts`) and the side panel (`panel.ts`) each keep one.
 */
type StoredWidth = {
  /** The width the person chose, or null while the stylesheet decides. */
  readonly use: () => number | null
  /** Remember a width — or forget it (`null`) and let the stylesheet decide again. */
  readonly set: (px: number | null) => void
}

/**
 * The store under `key`, holding what it reads and writes to `min`–`max`. Only the
 * floor refuses a value: under it a stored number is no width a drag could leave, while
 * one past the ceiling is the ceiling.
 */
export function storedWidth(key: string, bounds: { readonly min: number; readonly max: number }): StoredWidth {
  const held = (px: number): number => Math.min(bounds.max, Math.max(bounds.min, Math.round(px)))
  const width = storedValue<number | null>(key, {
    parse: (raw) => {
      const n = Number(raw)
      // a hand-mangled value is no width
      return Number.isFinite(n) && n >= bounds.min ? held(n) : undefined
    },
    serialize: (px) => (px === null ? null : String(held(px))),
    fallback: null
  })
  return { use: width.use, set: width.set }
}
