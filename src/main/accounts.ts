import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AccountInfo, AccountsSnapshot, SourceDir } from '../shared/types'
import { throttled } from './cache'
import { execText } from './env'
import { defaultConfigHome } from './paths'
import { parseJsonc, readJsoncFile } from './parsers/util'
import { replaceFile } from './replace-file'
import { isDrivable } from '../shared/providers'

/**
 * Who is each agent CLI signed in as?
 *   claude  — <config>/.claude.json (or ~/.claude.json for the default home): oauthAccount.emailAddress
 *   codex   — <config>/auth.json: JWT id_token payload email
 *   copilot — <config>/config.json: lastLoggedInUser + loggedInUsers (native multi-account)
 * GitHub identity for repo operations comes from `gh api user`.
 */

/** copilot's config.json starts with // comment lines — strip before parsing. */
export const readJsonc = parseJsonc

const readJsonFile = readJsoncFile

/** ~/.claude.json is often multi-MB (per-project history) and accounts:get runs on
 *  every index update — cache the parsed identity on (mtime,size) like the indexer. */
const claudeIdCache = new Map<string, { mtime: number; size: number; value: string | null }>()

export function claudeIdentity(configDir: string): string | null {
  const isDefault = configDir === defaultConfigHome('claude')
  const statePath = isDefault ? join(homedir(), '.claude.json') : join(configDir, '.claude.json')
  let st
  try {
    st = statSync(statePath)
  } catch {
    return null
  }
  const hit = claudeIdCache.get(statePath)
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.value
  const j = readJsonFile(statePath)
  const value = typeof j?.oauthAccount?.emailAddress === 'string' ? j.oauthAccount.emailAddress : null
  claudeIdCache.set(statePath, { mtime: st.mtimeMs, size: st.size, value })
  return value
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
  // the file holds every signed-in user: a write cut short would sign them all out
  replaceFile(path, header + JSON.stringify(j, null, 2) + '\n')
}

/** Who `gh` is signed in as, asked at most every five minutes; signed out is an answer too. */
const ghLogin = throttled(300_000, async (): Promise<string | null> => {
  const r = await execText('gh', ['api', 'user', '-q', '.login'], { timeoutMs: 10_000 })
  return r.ok ? r.stdout.trim() || null : null
})

export function ghUser(): Promise<string | null> {
  return ghLogin()
}

export async function getAccounts(sources: SourceDir[]): Promise<AccountsSnapshot> {
  const accounts: AccountInfo[] = []
  for (const s of sources) {
    // accounts are the CLIs Cockpit signs in and runs; an agent it only reads has none here
    const provider = s.provider
    if (!isDrivable(provider) || !existsSync(s.path)) continue
    const base = {
      provider,
      path: s.path,
      label: s.label,
      isDefault: s.path === defaultConfigHome(provider)
    }
    if (provider === 'claude') {
      accounts.push({ ...base, identity: claudeIdentity(s.path) })
    } else if (provider === 'codex') {
      accounts.push({ ...base, identity: codexIdentity(s.path) })
    } else {
      const { users, active } = copilotUsers(s.path)
      accounts.push({ ...base, identity: active, users, activeUser: active })
    }
  }
  return { accounts, githubUser: await ghUser() }
}
