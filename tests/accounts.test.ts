import { describe, it, expect, beforeAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  claudeIdentity,
  codexIdentity,
  copilotUsers,
  jwtEmail,
  readJsonc,
  setCopilotActiveUser
} from '../src/main/accounts'

const root = join(tmpdir(), 'cockpit-accounts-fixtures')

function fakeJwt(payload: object): string {
  const b64 = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`
}

beforeAll(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(join(root, 'claude-x'), { recursive: true })
  writeFileSync(
    join(root, 'claude-x', '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'work@corp.com' } })
  )
  mkdirSync(join(root, 'codex-x'), { recursive: true })
  writeFileSync(
    join(root, 'codex-x', 'auth.json'),
    JSON.stringify({ tokens: { id_token: fakeJwt({ email: 'me@personal.com' }) } })
  )
  mkdirSync(join(root, 'copilot-x'), { recursive: true })
  writeFileSync(
    join(root, 'copilot-x', 'config.json'),
    '// User settings belong in settings.json.\n// This file is managed automatically.\n' +
      JSON.stringify(
        {
          lastLoggedInUser: { host: 'https://github.com', login: 'work-user' },
          loggedInUsers: [
            { host: 'https://github.com', login: 'work-user' },
            { host: 'https://github.com', login: 'personal-user' }
          ],
          trustedFolders: ['/x']
        },
        null,
        2
      )
  )
})

describe('account identities', () => {
  it('reads claude oauth email from a custom config home', () => {
    expect(claudeIdentity(join(root, 'claude-x'))).toBe('work@corp.com')
  })
  it('reads codex email from the auth JWT', () => {
    expect(codexIdentity(join(root, 'codex-x'))).toBe('me@personal.com')
    expect(jwtEmail('garbage')).toBeNull()
  })
  it('reads copilot multi-account logins despite // comment header', () => {
    const { users, active } = copilotUsers(join(root, 'copilot-x'))
    expect(users).toEqual(['work-user', 'personal-user'])
    expect(active).toBe('work-user')
  })
  it('readJsonc tolerates comment lines and rejects garbage', () => {
    expect(readJsonc('// hi\n{"a":1}')).toEqual({ a: 1 })
    expect(readJsonc('nope')).toBeNull()
  })
})

describe('setCopilotActiveUser', () => {
  it('switches to another logged-in user, preserving the comment header', () => {
    setCopilotActiveUser(join(root, 'copilot-x'), 'personal-user')
    const raw = readFileSync(join(root, 'copilot-x', 'config.json'), 'utf8')
    expect(raw.startsWith('// User settings')).toBe(true)
    const { active, users } = copilotUsers(join(root, 'copilot-x'))
    expect(active).toBe('personal-user')
    expect(users).toHaveLength(2)
  })
  it('refuses a login that is not logged in', () => {
    expect(() => setCopilotActiveUser(join(root, 'copilot-x'), 'evil-user')).toThrow(/not logged in/)
  })
})
