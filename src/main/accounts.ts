import { execFile } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AccountInfo, AccountsSnapshot, Provider, SourceDir } from '../shared/types'
import { cliEnv } from './env'

/**
 * Who is each agent CLI signed in as?
 *   claude  — <config>/.claude.json (or ~/.claude.json for the default home): oauthAccount.emailAddress
 *   codex   — <config>/auth.json: JWT id_token payload email
 *   copilot — <config>/config.json: lastLoggedInUser + loggedInUsers (native multi-account)
 * GitHub identity for repo operations comes from `gh api user`.
 */

/** copilot's config.json starts with // comment lines — strip before parsing. */
export function readJsonc(raw: string): any | null {
  try {
    return JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''))
  } catch {
    return null
  }
}

function readJsonFile(path: string): any | null {
  try {
    return readJsonc(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

export function claudeIdentity(configDir: string): string | null {
  const isDefault = configDir === join(homedir(), '.claude')
  const statePath = isDefault ? join(homedir(), '.claude.json') : join(configDir, '.claude.json')
  const j = readJsonFile(statePath)
  return typeof j?.oauthAccount?.emailAddress === 'string' ? j.oauthAccount.emailAddress : null
}

/** Decode a JWT payload without verification — display only. */
export function jwtEmail(token: string): string | null {
  try {
    const payload = token.split('.')[1]
    const pad = payload + '='.repeat((4 - (payload.length % 4)) % 4)
    const j = JSON.parse(Buffer.from(pad, 'base64url').toString('utf8'))
    return typeof j.email === 'string' ? j.email : null
  } catch {
    return null
  }
}

export function codexIdentity(configDir: string): string | null {
  const j = readJsonFile(join(configDir, 'auth.json'))
  const token = j?.tokens?.id_token
  if (typeof token === 'string') return jwtEmail(token)
  if (typeof j?.OPENAI_API_KEY === 'string' && j.OPENAI_API_KEY) return '(api key)'
  return null
}

export function copilotUsers(configDir: string): { users: string[]; active: string | null } {
  const j = readJsonFile(join(configDir, 'config.json'))
  const users = Array.isArray(j?.loggedInUsers)
    ? j.loggedInUsers.map((u: any) => String(u?.login ?? '')).filter(Boolean)
    : []
  const active = typeof j?.lastLoggedInUser?.login === 'string' ? j.lastLoggedInUser.login : null
  return { users, active }
}

/**
 * Select which logged-in GitHub user copilot runs as (what `copilot` itself does
 * when switching accounts). Only ever set to a login that is already logged in.
 */
export function setCopilotActiveUser(configDir: string, login: string): void {
  const path = join(configDir, 'config.json')
  const raw = readFileSync(path, 'utf8')
  const j = readJsonc(raw)
  if (!j) throw new Error('cannot parse copilot config.json')
  const match = (Array.isArray(j.loggedInUsers) ? j.loggedInUsers : []).find(
    (u: any) => u?.login === login
  )
  if (!match) throw new Error(`copilot is not logged in as "${login}"`)
  if (j.lastLoggedInUser?.login === login) return
  j.lastLoggedInUser = match
  const header = raw.match(/^(\s*\/\/.*\n)+/)?.[0] ?? ''
  writeFileSync(path, header + JSON.stringify(j, null, 2) + '\n')
}

let ghUserCache: { at: number; login: string | null } | null = null

export function ghUser(): Promise<string | null> {
  if (ghUserCache && Date.now() - ghUserCache.at < 300_000) {
    return Promise.resolve(ghUserCache.login)
  }
  return new Promise((res) => {
    execFile('gh', ['api', 'user', '-q', '.login'], { env: cliEnv(), timeout: 10_000 }, (err, out) => {
      const login = err ? null : out.trim() || null
      ghUserCache = { at: Date.now(), login }
      res(login)
    })
  })
}

export async function getAccounts(sources: SourceDir[]): Promise<AccountsSnapshot> {
  const defaults: Record<Provider, string> = {
    claude: join(homedir(), '.claude'),
    codex: join(homedir(), '.codex'),
    copilot: join(homedir(), '.copilot')
  }
  const accounts: AccountInfo[] = []
  for (const s of sources) {
    if (!existsSync(s.path)) continue
    const base: AccountInfo = {
      provider: s.provider,
      path: s.path,
      label: s.label,
      identity: null,
      isDefault: s.path === defaults[s.provider]
    }
    if (s.provider === 'claude') base.identity = claudeIdentity(s.path)
    else if (s.provider === 'codex') base.identity = codexIdentity(s.path)
    else {
      const { users, active } = copilotUsers(s.path)
      base.identity = active
      base.users = users
      base.activeUser = active
    }
    accounts.push(base)
  }
  return { accounts, githubUser: await ghUser() }
}
