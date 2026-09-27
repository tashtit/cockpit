/**
 * Mirror something main owns: ask for its current value once, and follow every push
 * after. The two race — a push that lands before the seed answers is newer than it, so
 * the seed then yields rather than overwrite it. A seed main refuses is dropped: the
 * next push brings the value. Returns the unsubscribe, after which nothing lands.
 */
export function seedThenFollow<T>(
  seed: () => Promise<T>,
  follow: (on: (value: T) => void) => () => void,
  apply: (value: T) => void
): () => void {
  let live = true
  let pushed = false
  const off = follow((value) => {
    pushed = true
    apply(value)
  })
  seed().then(
    (value) => {
      if (live && !pushed) apply(value)
    },
    () => {}
  )
  return () => {
    live = false
    off()
  }
}
