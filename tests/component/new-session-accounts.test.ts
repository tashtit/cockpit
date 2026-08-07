import { describe, it, expect } from 'vitest'
import { accountOptions, savedAccount } from '../../src/renderer/src/NewSession'
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
