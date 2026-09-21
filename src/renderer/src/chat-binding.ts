import type { AcpPermissionOption, AgentOptions, Provider } from '../../shared/types'

/**
 * What a chat view is bound to — which agent, in which directory, as whom — and what
 * a live turn is currently blocked on.
 *
 * These live here rather than in App.tsx so ChatView can name them without importing
 * its own parent: App renders ChatView, so the types travelling the other way were a
 * cycle. Anything that renders a chat depends on this module; this module depends
 * only on the shared vocabulary.
 */
/**
 * A permission request a live ACP turn is blocked on, and the answers it will take.
 *
 * Not to be confused with `AskPrompt` / `AskPicker`: that is a question *read out of a
 * transcript*, answered by composing the next message, and it works for sessions Cockpit
 * never spawned. This one is a process Cockpit is holding open — the answer goes back
 * down the protocol, and nothing in the turn moves until it does.
 */
export type PendingPermission = {
  readonly turnId: string
  readonly requestId: string
  readonly toolName: string
  /** The agent's own one-line headline for what it wants to do */
  readonly preview: string
  /** The raw tool input behind the headline — the tooltip, so a click is informed */
  readonly detail: string
  readonly options: readonly AcpPermissionOption[]
}

export type ChatBinding = {
  readonly provider: Provider
  readonly cwd: string
  readonly nativeSessionId: string | null
  readonly title: string
  readonly branch: string | null
  readonly repoRoot: string | null
  /** Per-agent options chosen at session start; reused for every turn */
  readonly options?: AgentOptions
  /** Account chosen at session start (config home + copilot user) */
  readonly configDir?: string
  readonly copilotUser?: string
  /** Human-readable identity shown in the chat header */
  readonly accountLabel?: string
  /** Lineage chip: the session this one was handed off from */
  readonly continuedFrom?: { readonly id: string; readonly provider: Provider }
  /** Parent chip: the session that started this one (`SessionMeta.parentId`), set once
   *  the parent is found in the index — a parent Cockpit can't open gets no chip */
  readonly startedBy?: { readonly id: string; readonly provider: Provider; readonly title: string }
  /** Roundtable seat-session: view only, no composer (main refuses sends there too) */
  readonly readOnly?: boolean
}
