import { safeStorage } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { userDataDir } from './config'

/**
 * BYOK API keys, encrypted with the OS keychain (Electron safeStorage) and kept in a
 * file separate from cockpit-config.json. Plaintext keys exist only in memory: once
 * at add time (renderer → main over IPC) and per spawn when handed to the CLI's env.
 */

function keysPath(): string {
  return join(userDataDir(), 'endpoint-keys.json')
}

/**
 * null = the file exists but is unreadable/corrupt. Callers must then refuse to
 * write it back — rewriting from an empty map would destroy every stored ciphertext.
 */
function readAll(): Record<string, string> | null {
  let raw: string
  try {
    raw = readFileSync(keysPath(), 'utf8')
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? {} : null
  }
  try {
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : null
  } catch {
    return null
  }
}

function writeAll(map: Record<string, string>): void {
  mkdirSync(userDataDir(), { recursive: true })
  // ciphertext only, but keep it owner-readable regardless; write-then-rename so
  // a crash mid-write can't truncate the store
  const tmp = keysPath() + '.tmp'
  writeFileSync(tmp, JSON.stringify(map, null, 2), { mode: 0o600 })
  renameSync(tmp, keysPath())
}

export function setEndpointKey(endpointId: string, key: string): void {
  const map = readAll()
  if (!map) {
    throw new Error(
      'endpoint-keys.json is unreadable — refusing to overwrite the other stored keys. Fix or remove the file, then retry.'
    )
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS keychain encryption is unavailable — cannot store the API key securely.'
    )
  }
  map[endpointId] = safeStorage.encryptString(key).toString('base64')
  writeAll(map)
}

export function getEndpointKey(endpointId: string): string | undefined {
  const enc = readAll()?.[endpointId]
  if (!enc) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    // key from another machine/keychain — treat as absent so callers refuse loudly
    return undefined
  }
}

export function deleteEndpointKey(endpointId: string): void {
  const map = readAll()
  if (!map) {
    // corrupt store: leave it untouched (nothing in it is usable anyway) rather
    // than blocking the endpoint removal that called us
    console.error('[secrets] endpoint-keys.json is unreadable — key not removed')
    return
  }
  if (endpointId in map) {
    delete map[endpointId]
    writeAll(map)
  }
}
