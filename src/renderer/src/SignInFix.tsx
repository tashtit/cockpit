import type { JSX } from 'react'
import type { Provider } from '../../shared/types'
import { signInCommandLine } from '../../shared/agent-auth'

/**
 * The fix for a lapsed sign-in, as a sentence with the command set as code — the one
 * rendering everywhere Cockpit says an agent can't run (the roundtable form and table,
 * Settings › Accounts), so the words and the command never drift apart.
 */
export function SignInFix({
  provider,
  configHome
}: {
  provider: Provider
  /** The seat's or row's own config home; absent = the agent's default */
  configHome?: string
}): JSX.Element {
  return (
    <>
      Run <code className="signin-cmd">{signInCommandLine(provider, configHome)}</code> in a
      terminal to sign in again.
    </>
  )
}
