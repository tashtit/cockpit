/**
 * Maps whose key order is their recency, newest last, capped to the newest few: which
 * provider, lineage and holder each session has. JSON keeps a map's key order, so the
 * recency survives the config file, and the cap keeps a years-old install's config from
 * growing with every session it ever ran. IO-free.
 */

/** The newest `cap` entries. */
export function capRecent<T>(map: Readonly<Record<string, T>>, cap: number): Record<string, T> {
  const entries = Object.entries(map)
  return Object.fromEntries(entries.slice(Math.max(0, entries.length - cap)))
}

/** The map with `id` set to `value`, re-inserted last so key order stays recency, capped to the newest `cap`. */
export function withRecent<T>(
  map: Readonly<Record<string, T>>,
  entry: { readonly id: string; readonly value: T; readonly cap: number }
): Record<string, T> {
  const kept = Object.entries(map).filter(([k]) => k !== entry.id)
  kept.push([entry.id, entry.value])
  return capRecent(Object.fromEntries(kept), entry.cap)
}

/** Whether the newest entry already is `id` → `value`: a write that would change nothing. */
export function isLatest<T>(map: Readonly<Record<string, T>>, id: string, value: T): boolean {
  const last = Object.entries(map).at(-1)
  return last !== undefined && last[0] === id && last[1] === value
}
