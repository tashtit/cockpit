import { app, safeStorage } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * BYOK API keys, encrypted with the OS keychain (Electron safeStorage) and kept in a
 * file separate from cockpit-config.json. Plaintext keys exist only in memory: once
 * at add time (renderer → main over IPC) and per spawn when handed to the CLI's env.
 */

function keysPath(): string {
  return join(app.getPath('userData'), 'endpoint-keys.json')
}

function readAll(): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(keysPath(), 'utf8'))
    return typeof raw === 'object' && raw !== null ? (raw as Record<string, string>) : {}
  } catch {
    return {}
  }
}

function writeAll(map: Record<string, string>): void {
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(keysPath(), JSON.stringify(map, null, 2))
}

export function setEndpointKey(endpointId: string, key: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error(
      'OS keychain encryption is unavailable — cannot store the API key securely.'
    )
  }
  const map = readAll()
  map[endpointId] = safeStorage.encryptString(key).toString('base64')
  writeAll(map)
}

export function getEndpointKey(endpointId: string): string | undefined {
  const enc = readAll()[endpointId]
  if (!enc) return undefined
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    // key from another machine/keychain — treat as absent so callers refuse loudly
    return undefined
  }
}

export function deleteEndpointKey(endpointId: string): void {
  if (!existsSync(keysPath())) return
  const map = readAll()
  if (endpointId in map) {
    delete map[endpointId]
    writeAll(map)
  }
}
