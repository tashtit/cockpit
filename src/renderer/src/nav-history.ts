import type { RepoGroup } from '../../shared/types'
import type { ImageAttachment } from './attachments'
import type { ChatBinding } from './chat-binding'
import type { HandoffSourceRef } from './HandoffView'
import type { SettingsSection } from './Settings'

/**
 * Where the window is — which view — and the ⌘[/⌘] history of where it has been. Pure:
 * `use-nav-history.ts` holds the state, App decides what landing on an entry means.
 */

export type View =
  | { kind: 'welcome' }
  | { kind: 'chat' }
  | { kind: 'new'; repo: RepoGroup; draft?: string; draftImages?: readonly ImageAttachment[] }
  | { kind: 'handoff'; source: HandoffSourceRef }
  | { kind: 'new-roundtable' }
  | { kind: 'roundtable'; id: string }
  | { kind: 'settings'; section?: SettingsSection; openCount?: number }
  | { kind: 'cleanup' }
  /** repoRoot null = the global agent setup; otherwise one repo's own */
  | { kind: 'extensions'; repoRoot: string | null }
  | { kind: 'profile' }

/** One place in the ⌘[/⌘] navigation history. Chat entries snapshot the binding
 *  so a previous conversation can be re-materialized; other views restore by kind. */
export type NavEntry =
  | { readonly kind: 'view'; readonly view: Exclude<View, { kind: 'chat' }> }
  | { readonly kind: 'chat'; readonly binding: ChatBinding; readonly sessionId: string | null }

/** The places visited, oldest first, and which of them the window is on. */
export type NavHistory = { readonly stack: readonly NavEntry[]; readonly index: number }

const NAV_MAX = 50

/** A window opens on home, with nowhere to go back to. */
export const NAV_START: NavHistory = { stack: [{ kind: 'view', view: { kind: 'welcome' } }], index: 0 }

/** Same place = landing there again reuses the current entry instead of growing
 *  history. Chats compare by session id (id-less brand-new chats by binding
 *  identity), the new-session form by target repo + draft. */
export function sameNavEntry(a: NavEntry, b: NavEntry): boolean {
  if (a.kind === 'chat' || b.kind === 'chat')
    return (
      a.kind === 'chat' &&
      b.kind === 'chat' &&
      a.sessionId === b.sessionId &&
      (a.sessionId !== null || a.binding === b.binding)
    )
  const av = a.view
  const bv = b.view
  if (av.kind === 'new' || bv.kind === 'new')
    return (
      av.kind === 'new' &&
      bv.kind === 'new' &&
      av.repo.key === bv.repo.key &&
      av.draft === bv.draft &&
      av.draftImages === bv.draftImages
    )
  if (av.kind === 'handoff' || bv.kind === 'handoff')
    return av.kind === 'handoff' && bv.kind === 'handoff' && av.source.id === bv.source.id
  // two different tables are different places — compare by id, not by kind
  if (av.kind === 'roundtable' || bv.kind === 'roundtable')
    return av.kind === 'roundtable' && bv.kind === 'roundtable' && av.id === bv.id
  return av.kind === bv.kind
}

/**
 * History once the window has arrived at `entry`: re-landing on the current entry (a
 * ⌘[/⌘] restore, or a session-id mint `followMint` already patched in) leaves it as it
 * is; anywhere else drops the forward entries and is pushed, the oldest falling off past
 * NAV_MAX.
 */
export function arrive(nav: NavHistory, entry: NavEntry): NavHistory {
  const cur = nav.stack[nav.index]
  if (cur && sameNavEntry(cur, entry)) return nav
  const next = [...nav.stack.slice(0, nav.index + 1), entry].slice(-NAV_MAX)
  return { stack: next, index: next.length - 1 }
}

/**
 * History once a conversation's session id is minted — a new session's first, or the one
 * claude forks for every resumed turn: its entries follow the new id, so restoring one
 * later resumes it rather than forking a pre-turn snapshot. An id-less entry is the
 * conversation only while it holds the same binding.
 */
export function followMint(
  nav: NavHistory,
  mint: {
    readonly oldId: string | null
    readonly newId: string
    readonly nativeSessionId: string
    /** The binding the conversation had before the mint */
    readonly binding: ChatBinding | null
  }
): NavHistory {
  let changed = false
  const stack = nav.stack.map((e) => {
    if (e.kind !== 'chat' || e.sessionId !== mint.oldId) return e
    if (mint.oldId === null && e.binding !== mint.binding) return e
    changed = true
    return {
      ...e,
      sessionId: mint.newId,
      binding: { ...e.binding, nativeSessionId: mint.nativeSessionId }
    }
  })
  return changed ? { stack, index: nav.index } : nav
}
