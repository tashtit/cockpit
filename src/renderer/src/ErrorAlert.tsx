import type { JSX, ReactNode } from 'react'

/**
 * A failure said where it happened, never as a toast: `.new-error`, announced as it
 * appears. `id` is for the field that points at it (`aria-describedby`).
 */
export function ErrorAlert({ id, children }: { readonly id?: string; readonly children: ReactNode }): JSX.Element {
  return (
    <div id={id} role="alert" className="new-error">
      {children}
    </div>
  )
}
