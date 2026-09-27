import type { Provider, ReadOnlyProvider, SessionProvider } from './types'

/**
 * Which agents Cockpit knows, split by what it can do with them: the three it drives
 * and the ones it only reads. A session's `provider` is any of them; everything that
 * spawns a CLI takes a `Provider` and asks `isDrivable` first.
 *
 * An agent Cockpit only reads is still driven when an ACP agent answers for it (see
 * `acpAgentFor` in main's index.ts, mirrored by the renderer's `acp-readiness.ts`); until
 * then its sessions open read-only, with Continue in… as the way on. Either way its
 * sessions stay out of observed liveness and attention's turn tracking (a turn Cockpit
 * runs over ACP is tracked like any it spawns), the profile, accounts and usage — and
 * cleanup deletes them the way their agent keeps them (`session-disposal.ts`).
 */
export const DRIVABLE_PROVIDERS: readonly Provider[] = ['claude', 'codex', 'copilot']
export const READ_ONLY_PROVIDERS: readonly ReadOnlyProvider[] = ['gemini', 'cursor', 'cline', 'roo', 'opencode', 'antigravity']
export const SESSION_PROVIDERS: readonly SessionProvider[] = [...DRIVABLE_PROVIDERS, ...READ_ONLY_PROVIDERS]

/** What every surface calls an agent — one spelling, whichever process draws it. */
export const AGENT_LABEL: Readonly<Record<SessionProvider, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  copilot: 'Copilot',
  gemini: 'Gemini',
  cursor: 'Cursor',
  cline: 'Cline',
  roo: 'Roo Code',
  opencode: 'opencode',
  antigravity: 'Antigravity'
}

export function isDrivable(p: SessionProvider): p is Provider {
  return (DRIVABLE_PROVIDERS as readonly string[]).includes(p)
}

/** A value off the wire or out of a config file that names an agent this build reads. */
export function isSessionProvider(v: unknown): v is SessionProvider {
  return typeof v === 'string' && (SESSION_PROVIDERS as readonly string[]).includes(v)
}
