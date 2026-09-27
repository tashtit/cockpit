import type { Provider, ReadOnlyProvider, SessionProvider } from './types'

/**
 * Which agents Cockpit knows, split by what it can do with them: the three it drives
 * and the ones it only reads. A session's `provider` is any of them; everything that
 * spawns a CLI takes a `Provider` and asks `isDrivable` first.
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
