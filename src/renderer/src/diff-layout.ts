import { storedValue } from './stored-value'

/**
 * How a diff reads — one column with removals over additions, or the two texts
 * side by side. A reading preference, not machine state → localStorage
 * (`stored-value.ts`), like the chat column width; one choice, shared by every diff
 * surface in the app.
 */
export type DiffLayout = 'unified' | 'split'

export const DIFF_LAYOUT_LABEL: Record<DiffLayout, string> = {
  unified: 'Unified',
  split: 'Split'
}

export const DIFF_LAYOUTS: readonly DiffLayout[] = ['unified', 'split']

const layout = storedValue<DiffLayout>('cockpit:diff-layout', {
  parse: (raw) => (raw === 'split' || raw === 'unified' ? raw : undefined),
  serialize: (l) => l,
  fallback: 'unified'
})

/** Live layout preference — flipping it in one diff re-lays every open diff. */
export function useDiffLayout(): DiffLayout {
  return layout.use()
}

export function setDiffLayout(l: DiffLayout): void {
  layout.set(l)
}

/** Tests only: re-read localStorage after a test cleared it. */
export function reloadDiffLayout(): void {
  layout.reload()
}
