import { useEffect, useRef, useState, type JSX } from 'react'
import { disarmOn } from './disarm'

const CONFIRM_TIMEOUT_MS = 4000

/** The one armed slot a group of two-step buttons shares — what `useArmedConfirm` returns. */
type ArmedSlot = {
  readonly armed: string | null
  readonly arm: (id: string) => void
  readonly disarm: () => void
}

type ArmedButtonProps = {
  /** Distinguishes this button from the others sharing one armed slot */
  readonly id: string
  readonly slot: ArmedSlot
  readonly onConfirm: () => void
  /** The resting button's words, and its screen-reader name when they are not enough */
  readonly rest: string
  readonly restLabel?: string
  /** The armed question, its screen-reader name, and hover copy saying what it takes */
  readonly ask: string
  readonly askLabel?: string
  readonly title: string
  readonly disabled?: boolean
  /** The row-sized resting button — a per-row remove rather than a list's action */
  readonly small?: boolean
}

/**
 * Two-step destructive button: the first click arms, the second commits, and the
 * armed state backs out on blur or Escape. One component for every such button — the
 * disarm rules gate destructive actions, so two hand-synced copies is how one button
 * ends up behaving differently from its neighbour.
 */
export function ArmedButton({
  id,
  slot,
  onConfirm,
  rest,
  restLabel,
  ask,
  askLabel,
  title,
  disabled,
  small = false
}: ArmedButtonProps): JSX.Element {
  if (slot.armed !== id) {
    return (
      <button
        className={small ? 'btn-ghost danger small' : 'btn-ghost danger'}
        aria-label={restLabel}
        disabled={disabled}
        onClick={() => slot.arm(id)}
      >
        {rest}
      </button>
    )
  }
  return (
    <button
      className="btn-danger"
      aria-label={askLabel}
      title={title}
      {...disarmOn(slot.disarm)}
      onClick={onConfirm}
    >
      {ask}
    </button>
  )
}

type ConfirmRemoveProps = {
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

/** A row's own Remove → Remove? — the `ArmedButton` every removable row shares. */
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
  return (
    <ArmedButton
      id={id}
      slot={{ armed, arm: onArm, disarm: onDisarm }}
      onConfirm={onConfirm}
      small
      rest="Remove"
      restLabel={label}
      ask="Remove?"
      askLabel={confirmLabel}
      title={confirmTitle}
    />
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
