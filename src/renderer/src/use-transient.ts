import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'

/**
 * A value that clears itself `ms` after it was set — a "copied" that says a click
 * worked, a ring around the row something opened at. Null is "nothing showing": set
 * it to clear at once. Setting it again to what it already holds changes nothing, the
 * timer included.
 */
export function useTransient<T>(ms: number): readonly [T | null, Dispatch<SetStateAction<T | null>>] {
  const [value, setValue] = useState<T | null>(null)
  useEffect(() => {
    if (value === null) return
    const t = setTimeout(() => setValue(null), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return [value, setValue]
}
