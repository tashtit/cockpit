import { describe, it, expect, vi } from 'vitest'
import {
  accountOptions,
  chosenAccount,
  rememberAccount,
  rememberChoice,
  rememberMode,
  savedAccount,
  savedMode,
  savedProvider
} from '../../src/renderer/src/agent-choice'
import type { AccountsSnapshot } from '../../src/shared/types'

const snap: AccountsSnapshot = {
  accounts: [
    {
      provider: 'claude',
      path: '/home/dev/.claude',
      label: 'claude-default',
      identity: 'dev@example.com',
      isDefault: true
    },
    {
      provider: 'claude',
      path: '/home/dev/.claude-work',
      label: 'claude-work',
      identity: 'work@corp.com',
      isDefault: false
    },
    {
      provider: 'copilot',
      path: '/home/dev/.copilot',
      label: 'copilot-default',
      identity: 'octo',
      users: ['octo', 'hubot'],
      isDefault: true
    }
  ],
  githubUser: 'octo'
}

describe('accountOptions', () => {
  it('returns nothing before the snapshot loads', () => {
    expect(accountOptions(null, 'claude')).toEqual([])
  })

  it('flattens claude accounts; only non-default homes carry a configDir and label suffix', () => {
    const opts = accountOptions(snap, 'claude')
    expect(opts).toHaveLength(2)
    expect(opts[0]).toMatchObject({
      key: '/home/dev/.claude',
      display: 'dev@example.com',
      configDir: undefined
    })
    expect(opts[1]).toMatchObject({
      key: '/home/dev/.claude-work',
      display: 'work@corp.com · claude-work',
      configDir: '/home/dev/.claude-work'
    })
  })

  it('expands each logged-in copilot user into its own option', () => {
    const opts = accountOptions(snap, 'copilot')
    expect(opts.map((o) => o.key)).toEqual([
      '/home/dev/.copilot|octo',
      '/home/dev/.copilot|hubot'
    ])
    expect(opts[1]).toMatchObject({ display: '@hubot', copilotUser: 'hubot', configDir: undefined })
  })
})

describe('savedAccount', () => {
  it('falls back to the first option when nothing is saved', () => {
    expect(savedAccount(snap, 'claude')?.key).toBe('/home/dev/.claude')
  })

  it('honors the saved key for the provider', () => {
    window.localStorage.setItem('cockpit:account:claude', '/home/dev/.claude-work')
    expect(savedAccount(snap, 'claude')?.key).toBe('/home/dev/.claude-work')
  })

  it('ignores a stale saved key that no longer resolves', () => {
    window.localStorage.setItem('cockpit:account:claude', '/gone/.claude')
    expect(savedAccount(snap, 'claude')?.key).toBe('/home/dev/.claude')
  })
})

describe('chosenAccount', () => {
  it('runs as the account picked on the form', () => {
    expect(chosenAccount(snap, 'claude', '/home/dev/.claude-work')?.key).toBe('/home/dev/.claude-work')
  })

  it('falls back to the saved account when nothing is picked, or the pick is gone', () => {
    window.localStorage.setItem('cockpit:account:claude', '/home/dev/.claude-work')
    expect(chosenAccount(snap, 'claude', undefined)?.key).toBe('/home/dev/.claude-work')
    expect(chosenAccount(snap, 'claude', '/gone/.claude')?.key).toBe('/home/dev/.claude-work')
  })

  it('never takes a pick made for another agent', () => {
    expect(chosenAccount(snap, 'copilot', '/home/dev/.claude-work')?.key).toBe('/home/dev/.copilot|octo')
  })
})

describe('savedProvider', () => {
  it('opens on the agent the last session started with', () => {
    window.localStorage.setItem('cockpit:provider', 'codex')
    expect(savedProvider()).toBe('codex')
  })

  it('falls back to Claude when what is stored is not an agent', () => {
    window.localStorage.setItem('cockpit:provider', 'aider')
    expect(savedProvider()).toBe('claude')
  })

  // an agent Cockpit otherwise only reads is remembered as picked; the form opens on it
  // only while an ACP agent drives it (useAgentChoice), and on Claude until then
  it('remembers an agent Cockpit only reads, for when an ACP agent drives it', () => {
    window.localStorage.setItem('cockpit:provider', 'gemini')
    expect(savedProvider()).toBe('gemini')
  })
})

describe('storage that refuses access', () => {
  /** A private window, or site data blocked: every storage call throws. */
  function refuseStorage(): () => void {
    const denied = (): never => {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    }
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(denied)
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(denied)
    return () => {
      read.mockRestore()
      write.mockRestore()
    }
  }

  it('reads as nothing remembered', () => {
    const restore = refuseStorage()
    try {
      expect(savedProvider()).toBe('claude')
      expect(savedMode()).toBe('auto-edit')
      expect(savedAccount(snap, 'claude')?.key).toBe('/home/dev/.claude')
    } finally {
      restore()
    }
  })

  it('never throws from a mode picked in a chat that cannot be remembered', () => {
    const restore = refuseStorage()
    try {
      expect(() => rememberMode('yolo')).not.toThrow()
    } finally {
      restore()
    }
  })

  // the one way to keep a preference here (storedValue): what storage refused to save
  // still holds for this run, so the next form opens on what was just picked
  it('keeps a choice it could not save for the rest of the run', () => {
    const restore = refuseStorage()
    try {
      rememberChoice({ provider: 'codex', mode: 'safe', account: undefined })
      expect(savedProvider()).toBe('codex')
      expect(savedMode()).toBe('safe')
    } finally {
      restore()
    }
    // and storage that takes the next save holds that one
    rememberMode('auto-edit')
    expect(window.localStorage.getItem('cockpit:mode')).toBe('auto-edit')
    expect(savedMode()).toBe('auto-edit')
  })

  it('stores each choice as the plain text earlier builds wrote', () => {
    rememberChoice({ provider: 'gemini', mode: 'yolo', account: accountOptions(snap, 'gemini')[0] })
    rememberAccount('claude', '/home/dev/.claude-work')
    expect(window.localStorage.getItem('cockpit:provider')).toBe('gemini')
    expect(window.localStorage.getItem('cockpit:mode')).toBe('yolo')
    expect(window.localStorage.getItem('cockpit:account:claude')).toBe('/home/dev/.claude-work')
  })

  it('never stops a start that cannot be remembered', () => {
    const restore = refuseStorage()
    try {
      expect(() =>
        rememberChoice({ provider: 'claude', mode: 'yolo', account: accountOptions(snap, 'claude')[1] })
      ).not.toThrow()
    } finally {
      restore()
    }
  })
})
