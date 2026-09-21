import type { Provider } from '../shared/types'
import { execText } from './env'
import { claudeSignIn, codexSignIn, signInCommand, type SignInState } from './agent-auth-core'

/**
 * Whether an agent CLI is signed in under one config home, asked of the CLI itself —
 * Cockpit's accounts view reads the identity a config file remembers, which outlives
 * an expired session. Never throws; see agent-auth-core for what counts.
 */
export async function signInState(provider: Provider, configDir?: string): Promise<SignInState> {
  const cmd = signInCommand(provider)
  if (!cmd) return 'unknown'
  const env: NodeJS.ProcessEnv = {}
  if (configDir) env[provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'] = configDir
  const r = await execText(cmd[0], cmd.slice(1), { env, timeoutMs: 10_000 })
  return provider === 'claude' ? claudeSignIn(r.stdout) : codexSignIn(`${r.stdout}\n${r.stderr}`, r.ok)
}
