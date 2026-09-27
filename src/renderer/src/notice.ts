/**
 * The one line the Agents card shows above its panel: what the last action did, or why
 * it failed. The card owns it; the panel, the instructions editor and the rows below
 * them all report through the same setter.
 *
 * `link` is for an outcome that lives somewhere else — a PR the share just opened.
 */
export type Notice = {
  readonly text: string
  readonly kind: 'ok' | 'error'
  readonly link?: { readonly href: string; readonly label: string }
} | null
