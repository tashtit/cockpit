import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deleteEndpointKey, getEndpointKey, setEndpointKey } from '../src/main/secrets'

/**
 * The wipe-protection paths run before any safeStorage use, so they are testable
 * without an electron runtime (the store dir comes from COCKPIT_USER_DATA).
 */

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cockpit-secrets-'))
  process.env['COCKPIT_USER_DATA'] = dir
})

afterEach(() => {
  delete process.env['COCKPIT_USER_DATA']
  rmSync(dir, { recursive: true, force: true })
})

const keysPath = (): string => join(dir, 'endpoint-keys.json')

describe('endpoint key store corruption', () => {
  it('refuses to overwrite a corrupt store when adding a key', () => {
    writeFileSync(keysPath(), '{ not json')
    expect(() => setEndpointKey('e1', 'sk-test')).toThrow(/unreadable/)
    // the ciphertexts that may still be recoverable from the file must survive
    expect(readFileSync(keysPath(), 'utf8')).toBe('{ not json')
  })

  it('reads keys from a corrupt store as absent (refuse-loudly at preflight)', () => {
    writeFileSync(keysPath(), '{ not json')
    expect(getEndpointKey('e1')).toBeUndefined()
  })

  it('leaves a corrupt store untouched on delete', () => {
    writeFileSync(keysPath(), '{ not json')
    deleteEndpointKey('e1')
    expect(readFileSync(keysPath(), 'utf8')).toBe('{ not json')
  })
})

describe('endpoint key store', () => {
  it('a missing store file reads as absent keys', () => {
    expect(getEndpointKey('nope')).toBeUndefined()
  })

  it('removes only the requested key', () => {
    writeFileSync(keysPath(), JSON.stringify({ a: 'cipher-a', b: 'cipher-b' }))
    deleteEndpointKey('a')
    expect(JSON.parse(readFileSync(keysPath(), 'utf8'))).toEqual({ b: 'cipher-b' })
  })
})
