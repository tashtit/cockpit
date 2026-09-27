import { useEffect, useMemo, useState } from 'react'
import type {
  AccountsSnapshot,
  AgentOptions,
  PermissionMode,
  Provider,
  RepoGroup
} from '../../shared/types'
import { api } from './api'

/**
 * Who runs a new session and how far it may go unasked: the agent, the account it runs as
 * and the permission mode. Home's composer, the New session form and the handoff form all
 * choose them, and all remember them in the same localStorage keys — one memory across
 * every entry point. ChatView reads the mode back, the new-roundtable form the accounts.
 */

export type AccountChoice = {
  readonly configDir?: string
  readonly copilotUser?: string
  /** Human-readable identity, carried onto the session binding for display */
  readonly display?: string
}

export type AccountOption = AccountChoice & {
  readonly key: string
  readonly display: string
  /** Short unique part (email / @login) that must never truncate away */
  readonly identity: string
}

/** Everything needed to start a fresh session (worktree + first prompt). */
export type StartSessionRequest = {
  readonly repo: RepoGroup
  readonly provider: Provider
  /** Optional branch/worktree name; '' lets the workspace pick one */
  readonly name: string
  readonly prompt: string
  readonly mode: PermissionMode
  readonly options: AgentOptions
  readonly account: AccountChoice
  /** Pasted-image paths (saveChatImage) sent with the first prompt */
  readonly images?: readonly string[]
}

/** Flatten the accounts snapshot into selectable options per provider. */
export function accountOptions(snap: AccountsSnapshot | null, provider: Provider): AccountOption[] {
  if (!snap) return []
  const out: AccountOption[] = []
  for (const a of snap.accounts.filter((x) => x.provider === provider)) {
    if (provider === 'copilot' && a.users && a.users.length > 0) {
      for (const login of a.users) {
        out.push({
          key: `${a.path}|${login}`,
          identity: `@${login}`,
          display: `@${login}${a.isDefault ? '' : ` · ${a.label}`}`,
          configDir: a.isDefault ? undefined : a.path,
          copilotUser: login
        })
      }
    } else {
      const identity = a.identity ?? a.label
      out.push({
        key: a.path,
        identity,
        // the label is only appended when it adds information — when the identity is
        // unknown it already falls back to the label, and "label · label" is noise
        display: a.isDefault || identity === a.label ? identity : `${identity} · ${a.label}`,
        configDir: a.isDefault ? undefined : a.path
      })
    }
  }
  return out
}

/** The single account-resolution rule: the user's saved choice, else the first configured. */
export function savedAccount(snap: AccountsSnapshot | null, p: Provider): AccountOption | undefined {
  const opts = accountOptions(snap, p)
  return opts.find((o) => o.key === window.localStorage.getItem(`cockpit:account:${p}`)) ?? opts[0]
}

/** The one permission-mode table — every form and ChatView read it, so wording never drifts. */
export const MODES: Array<{ v: PermissionMode; label: string; hint: string }> = [
  { v: 'safe', label: 'Safe', hint: 'asks you before any tool that needs approval (Codex: blocked headless)' },
  { v: 'auto-edit', label: 'Auto-edit', hint: 'file edits go ahead; commands ask you first (Codex: sandboxed, its reviewer decides the rest)' },
  { v: 'yolo', label: 'YOLO', hint: 'bypass all approvals — trusted repos only' }
]

/**
 * The permission mode the person last sent with, read back from storage — or the default
 * when what is stored is not one of the modes. Storage is anyone's to write (a devtools
 * console, another build, a hand edit), and the mode is what decides what an agent may do
 * unasked, so nothing but a known mode may come out of it.
 */
export function savedMode(): PermissionMode {
  let stored: string | null = null
  try {
    stored = window.localStorage.getItem('cockpit:mode')
  } catch {
    // blocked storage: the default
  }
  return MODES.find((m) => m.v === stored)?.v ?? 'auto-edit'
}

/** The agent the person last started with, or Claude when nothing is stored. */
export function savedProvider(): Provider {
  return (window.localStorage.getItem('cockpit:provider') as Provider) ?? 'claude'
}

/** Remember the account picked for `provider`, for every form to open on. */
export function rememberAccount(provider: Provider, key: string): void {
  window.localStorage.setItem(`cockpit:account:${provider}`, key)
}

/** Remember what a session was started with, for the next form to open on. */
export function rememberChoice(choice: {
  readonly provider: Provider
  readonly mode: PermissionMode
  readonly account: AccountOption | undefined
}): void {
  window.localStorage.setItem('cockpit:provider', choice.provider)
  window.localStorage.setItem('cockpit:mode', choice.mode)
  if (choice.account) rememberAccount(choice.provider, choice.account.key)
}

export const AGENT_BLURB: Record<Provider, string> = {
  claude: 'Deep multi-step coding, hooks & skills',
  codex: 'Fast sandboxed execution',
  copilot: 'GitHub-native, PR-focused'
}

/** A start form's agent, account and permission mode, as chosen so far. */
export type AgentChoice = {
  readonly provider: Provider
  readonly setProvider: (p: Provider) => void
  readonly mode: PermissionMode
  readonly setMode: (m: PermissionMode) => void
  /** Every signed-in account; null while they load, when absence is unknown — not "signed out" */
  readonly accounts: AccountsSnapshot | null
  /** The active agent's accounts to pick from */
  readonly opts: readonly AccountOption[]
  /** The account the session would run as: the one picked here, else the saved one, else the first */
  readonly account: AccountOption | undefined
  readonly setAccount: (key: string) => void
  /** The account an agent's card names — the rule `account` follows for the active agent, so a
   *  card never shows a different account than the one that would actually run */
  readonly accountFor: (p: Provider) => AccountOption | undefined
  /** What the start request carries of the account */
  readonly runAs: AccountChoice
}

/**
 * The agent, account and mode a start form opens on — the saved ones, or `initial`'s agent —
 * and how they change. The accounts are read once; a pick made for one agent is dropped
 * when the agent changes, since accounts differ per agent.
 */
export function useAgentChoice(initial: () => Provider = savedProvider): AgentChoice {
  const [provider, setProvider] = useState<Provider>(initial)
  const [mode, setMode] = useState<PermissionMode>(savedMode)
  const [accounts, setAccounts] = useState<AccountsSnapshot | null>(null)
  const [accountKey, setAccountKey] = useState<string | null>(null)

  const opts = useMemo(() => accountOptions(accounts, provider), [accounts, provider])
  const account = opts.find((o) => o.key === accountKey) ?? savedAccount(accounts, provider)

  useEffect(() => {
    void api.getAccounts().then(setAccounts)
  }, [])

  useEffect(() => {
    setAccountKey(null)
  }, [provider])

  return {
    provider,
    setProvider,
    mode,
    setMode,
    accounts,
    opts,
    account,
    setAccount: setAccountKey,
    accountFor: (p) => (p === provider ? account : savedAccount(accounts, p)),
    runAs: {
      configDir: account?.configDir,
      copilotUser: account?.copilotUser,
      display: account?.display
    }
  }
}
