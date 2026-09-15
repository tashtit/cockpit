import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const CONFIG = fileURLToPath(new URL('../electron-builder.config.js', import.meta.url))
const APPLE: readonly string[] = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']
const ALL: Record<string, string> = Object.fromEntries(APPLE.map((k) => [k, k === 'APPLE_TEAM_ID' ? 'ABCDE12345' : 'x']))

type Loaded =
  | { readonly ok: true; readonly force: boolean; readonly notarize: boolean; readonly discovery: string | undefined }
  | { readonly ok: false; readonly stderr: string }

/**
 * The config normalizes process.env as it loads, so every case gets a fresh node process
 * whose Apple variables are exactly the ones given — none inherited from this shell.
 */
function load(env: Record<string, string>): Loaded {
  const script =
    `const c = require(${JSON.stringify(CONFIG)}); process.stdout.write(JSON.stringify({ ` +
    'force: c.forceCodeSigning, notarize: c.mac.notarize, discovery: process.env.CSC_IDENTITY_AUTO_DISCOVERY }))'
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !APPLE.includes(k) && k !== 'CSC_IDENTITY_AUTO_DISCOVERY')
  )
  const r = spawnSync(process.execPath, ['-e', script], { env: { ...inherited, ...env }, encoding: 'utf8' })
  return r.status === 0 ? { ok: true, ...JSON.parse(r.stdout) } : { ok: false, stderr: r.stderr }
}

describe('electron-builder.config.js Apple credentials', () => {
  it('without them: ad-hoc build, no notarization, identity discovery pinned off', () => {
    expect(load({})).toEqual({ ok: true, force: false, notarize: false, discovery: 'false' })
  })

  it('with all five: signing is mandatory, notarization on, the imported certificate is discoverable', () => {
    expect(load(ALL)).toEqual({ ok: true, force: true, notarize: true, discovery: 'true' })
  })

  it('treats the empty strings GitHub passes for unset secrets as absent', () => {
    const empty = Object.fromEntries(APPLE.map((k) => [k, '']))
    expect(load(empty)).toEqual({ ok: true, force: false, notarize: false, discovery: 'false' })
  })

  it('refuses a partial set at load and names what is missing', () => {
    const { APPLE_TEAM_ID: _team, APPLE_ID: _id, ...partial } = ALL
    const result = load(partial)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.stderr).toContain('all-or-nothing')
    expect(result.stderr).toContain('APPLE_ID, APPLE_TEAM_ID missing')
  })
})
