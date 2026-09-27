import { describe, it, expect, vi } from 'vitest'
import {
  accountOptions,
  rememberChoice,
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

describe('savedProvider', () => {
  it('opens on the agent the last session started with', () => {
    window.localStorage.setItem('cockpit:provider', 'codex')
    expect(savedProvider()).toBe('codex')
  })

  it('falls back to Claude when what is stored is not an agent', () => {
    window.localStorage.setItem('cockpit:provider', 'gemini')
    expect(savedProvider()).toBe('claude')
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
