import type { RepoGroup, SessionControl, SessionHolder, SessionProvider } from '../../shared/types'
import { PROVIDER_LABEL } from './logos'
import { storedValue } from './stored-value'

/**
 * Who drives a session, in words — and the tree's filter on it.
 *
 * A session is either held by Cockpit (it started it, or the person took it over) or
 * with its agent (it came from a terminal or the provider's own app, or was released
 * back there). Main owns the record (`SessionMeta.control`); this is how the renderer
 * says it, so the rows, the chat header and the filter speak the same sentence.
 */

/**
 * Where a session with its agent lives, when its log says where it was opened: "the
 * Claude app", "a terminal". Null for Cockpit's own, for a released one (it went
 * wherever it was resumed next), for a headless run (nowhere to go back to) and for a
 * client no log has named yet.
 */
export function placeOf(control: SessionControl, provider: SessionProvider): string | null {
  if (control.holder !== 'agent' || control.how !== 'outside') return null
  const agent = PROVIDER_LABEL[provider]
  switch (control.surface) {
    case 'app':
      return `the ${agent} app`
    case 'terminal':
      return 'a terminal'
    case 'ide':
      return 'an editor'
    case 'browser':
      return 'a browser extension'
    case 'cli':
      return `the ${agent} CLI`
    default:
      return null
  }
}

/** The holder as a short name — the chip: "In Cockpit", "In the Claude app", "In Codex". */
export function holderName(control: SessionControl, provider: SessionProvider): string {
  if (control.holder === 'cockpit') return 'In Cockpit'
  return `In ${placeOf(control, provider) ?? PROVIDER_LABEL[provider]}`
}

/** The whole story in one line — a row's tooltip, the chip's title. */
export function holdSentence(control: SessionControl, provider: SessionProvider): string {
  const agent = PROVIDER_LABEL[provider]
  switch (control.how) {
    case 'started':
      return 'In Cockpit — started here; Cockpit sends its turns'
    case 'taken-over':
      return `In Cockpit — taken over from ${agent}; Cockpit sends its turns`
    case 'released':
      return `In ${agent} — released from Cockpit; Cockpit only follows its log`
    case 'outside':
      return control.surface === 'headless'
        ? `In ${agent} — run headless outside Cockpit; Cockpit only follows its log`
        : `${holderName(control, provider)} — opened outside Cockpit; Cockpit only follows its log`
  }
}

/**
 * Which sessions the tree shows by who drives them: every one, only those Cockpit
 * holds, or only those still with their agent. A view preference for this machine,
 * like the folds (`families.ts`), so it lives in localStorage (`stored-value.ts`) rather
 * than in config — and it survives a restart, which is why the tree says so while it is on.
 */
const holderFilter = storedValue<SessionHolder | null>('cockpit:holder-filter', {
  parse: (raw) => (raw === 'cockpit' || raw === 'agent' ? raw : undefined),
  serialize: (holder) => holder,
  fallback: null
})

/** The holder the tree is narrowed to, or null for every session. */
export function useHolderFilter(): SessionHolder | null {
  return holderFilter.use()
}

export function setHolderFilter(holder: SessionHolder | null): void {
  holderFilter.set(holder)
}

/** How many of a project's active sessions the filter lets through. */
export function heldSessions(repo: RepoGroup, holder: SessionHolder | null): number {
  if (holder === 'cockpit') return repo.heldCount
  if (holder === 'agent') return repo.sessionCount - repo.heldCount
  return repo.sessionCount
}

/** The filter's words, one name per state — the chip, the rows' tooltips and the docs agree. */
export const HOLDER_FILTER_LABEL: Record<SessionHolder, string> = {
  cockpit: 'In Cockpit',
  agent: 'Outside Cockpit'
}
