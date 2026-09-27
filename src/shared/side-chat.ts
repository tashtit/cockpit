import type { Provider } from './types'

/**
 * Side chat: questions about a session, answered from a throwaway copy of it.
 *
 * Only an agent whose CLI can copy a session and save nothing has one — Claude
 * (`--resume <id> --fork-session --no-session-persistence`) and Codex (`exec fork <id>
 * --ephemeral`; `exec resume --ephemeral` still appends to the rollout it resumed).
 * Copilot can neither copy a session nor run without saving one, so its sessions have no
 * side chat rather than one that writes into them.
 */
export const SIDE_CHAT_PROVIDERS: readonly Provider[] = ['claude', 'codex']

export function sideChatSupported(provider: Provider): boolean {
  return SIDE_CHAT_PROVIDERS.includes(provider)
}

/** The longest side question, in characters — the composer stops there and main refuses past it */
export const SIDE_QUESTION_MAX = 4_000
