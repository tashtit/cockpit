import { useEffect, useRef, type JSX } from 'react'
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

/**
 * While something the person is finishing in Terminal is pending (a sign-in, an
 * update), ask again every few seconds and whenever the window is focused — so
 * Cockpit notices the moment they come back, with no Recheck to press. Gives up
 * after `forMs`; `check` is read fresh each tick.
 */
export function useWatchUntil(
  active: boolean,
  check: () => void,
  opts: { readonly everyMs?: number; readonly forMs?: number } = {}
): void {
  const ref = useRef(check)
  ref.current = check
  useEffect(() => {
    if (!active) return
    const started = Date.now()
    const tick = (): void => {
      if (Date.now() - started <= (opts.forMs ?? 5 * 60_000)) ref.current()
    }
    const timer = setInterval(tick, opts.everyMs ?? 3_000)
    window.addEventListener('focus', tick)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', tick)
    }
  }, [active])
}
