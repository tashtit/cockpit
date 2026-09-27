import type { UpdateSuggestion, UpdateSuggestionKind } from './types'

/*
 * "Is anything here out of date?" — one answer, for the whole machine.
 *
 * Cockpit already knows the pieces: the app's own update state, each agent CLI against
 * the channel it installed from, a pinned MCP server against its registry, an installed
 * plugin against the marketplace catalogue beside it, and the panel's own disagreements.
 * They were in five places, each of which had to be visited to be asked. This is the
 * fold that puts them in one list — pure, so main can order it and the home can say it
 * in a line without either of them owning the wording.
 *
 * Drift is in the list on purpose. It is not an update, but it answers the same
 * question — "is anything out of step?" — and leaving it out would mean the one place
 * that claims to know still sends you elsewhere to find out.
 */

/** Reading order: the app, then the agents' own tools, then what disagrees. */
export const SUGGESTION_ORDER: readonly UpdateSuggestionKind[] = [
  'app',
  'cli',
  'mcp',
  'plugin',
  'drift'
]

/** The word a row wears — what kind of thing this is, never what to do about it. */
export const SUGGESTION_TAG: Record<UpdateSuggestionKind, string> = {
  app: 'Cockpit',
  cli: 'agent CLI',
  mcp: 'MCP server',
  plugin: 'plugin',
  drift: 'agents differ'
}

/** Everything but drift: a version on offer, somewhere. */
export function isUpdate(item: UpdateSuggestion): boolean {
  return item.kind !== 'drift'
}

export function sortSuggestions(items: readonly UpdateSuggestion[]): UpdateSuggestion[] {
  return [...items].sort(
    (a, b) =>
      SUGGESTION_ORDER.indexOf(a.kind) - SUGGESTION_ORDER.indexOf(b.kind) ||
      a.name.localeCompare(b.name)
  )
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * The one line the home says when something is out of date: how many updates there
 * are, and how many things the agents disagree on — the two are different questions
 * and a single total would hide both. Null when there is nothing to say, which is the
 * state that renders no strip at all.
 */
export function digestHeadline(items: readonly UpdateSuggestion[]): string | null {
  const updates = items.filter(isUpdate).length
  const drift = items.length - updates
  const parts = [
    updates > 0 && plural(updates, 'update', 'updates'),
    drift > 0 && plural(drift, 'agent difference', 'agent differences')
  ].filter((p): p is string => typeof p === 'string')
  return parts.length === 0 ? null : parts.join(' · ')
}
