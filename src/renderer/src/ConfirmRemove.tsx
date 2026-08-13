import { useEffect, useRef, useState, type JSX } from 'react'

const CONFIRM_TIMEOUT_MS = 4000

export type ConfirmRemoveProps = {
  /** Distinguishes this row from the others sharing one armed slot */
  readonly id: string
  readonly armed: string | null
  /** Screen-reader label for the un-armed button */
  readonly label: string
  /** Screen-reader label and hover copy for the armed button */
  readonly confirmLabel: string
  readonly confirmTitle: string
  readonly onArm: (id: string) => void
  readonly onDisarm: () => void
  readonly onConfirm: () => void
}

/**
 * Two-step destructive remove: the first click arms, the second commits, and the
 * armed state backs out on blur or Escape. One component for every such row — the
 * disarm rules gate destructive actions, so two hand-synced copies is how one row
 * ends up behaving differently from its neighbour.
 */
export function ConfirmRemove({
  id,
  armed,
  label,
  confirmLabel,
  confirmTitle,
  onArm,
  onDisarm,
  onConfirm
}: ConfirmRemoveProps): JSX.Element {
  if (armed !== id) {
    return (
      <button className="btn-ghost danger small" aria-label={label} onClick={() => onArm(id)}>
        Remove
      </button>
    )
  }
  return (
    <button
      className="btn-danger"
      aria-label={confirmLabel}
      title={confirmTitle}
      onBlur={onDisarm}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation()
          onDisarm()
        }
      }}
      onClick={onConfirm}
    >
      Remove?
    </button>
  )
}

/** Which row (if any) is armed, with the auto-disarm timer that goes with it. */
export function useArmedConfirm(): {
  armed: string | null
  arm: (id: string) => void
  disarm: () => void
} {
  const [armed, setArmed] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const clear = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  const disarm = (): void => {
    clear()
    setArmed(null)
  }
  const arm = (id: string): void => {
    clear()
    setArmed(id)
    timer.current = setTimeout(() => setArmed(null), CONFIRM_TIMEOUT_MS)
  }
  useEffect(() => clear, [])
  return { armed, arm, disarm }
}
