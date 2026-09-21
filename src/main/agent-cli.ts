import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CliStatus, Provider } from '../shared/types'
import {
  CLI_PACKAGE,
  compareVersions,
  installMethodOf,
  parseVersion,
  updateCommandFor
} from '../shared/agent-cli'
import { execText } from './env'

const LATEST_TTL_MS = 60 * 60_000
const latestCache = new Map<Provider, { at: number; version: string | null }>()

/**
 * The newest release of a CLI, from the npm registry — every one of the three
 * publishes there, and it is the upstream answer (Homebrew's list lags it until
 * `brew update`). One small JSON read per CLI per hour; unreachable is null, never a throw.
 */
async function latestRelease(provider: Provider, force: boolean): Promise<string | null> {
  // the hermetic seam, like COCKPIT_USER_DATA: the ui-tour and e2e name the "latest"
  // releases so they never reach the network. A JSON map of provider → version.
  const pinned = process.env['COCKPIT_CLI_LATEST']
  if (pinned !== undefined) {
    try {
      const v = (JSON.parse(pinned) as Record<string, unknown>)[provider]
      return typeof v === 'string' ? parseVersion(v) : null
    } catch {
      return null
    }
  }
  const hit = latestCache.get(provider)
  if (!force && hit && Date.now() - hit.at < LATEST_TTL_MS) return hit.version
  let version: string | null = null
  try {
    const res = await fetch(`https://registry.npmjs.org/${CLI_PACKAGE[provider].npm}/latest`, {
      signal: AbortSignal.timeout(8_000),
      headers: { accept: 'application/json' }
    })
    if (res.ok) {
      const j = (await res.json()) as { version?: unknown }
      version = typeof j.version === 'string' ? parseVersion(j.version) : null
    }
  } catch {
    /* offline, or the registry is down — the check says "couldn't check" */
  }
  latestCache.set(provider, { at: Date.now(), version })
  return version
}

/** One CLI as this Mac has it: where, which version, how installed, and whether it is behind. */
export async function cliStatus(provider: Provider, opts: { readonly force?: boolean } = {}): Promise<CliStatus> {
  const found = await execText('/usr/bin/which', [provider], { timeoutMs: 5_000 })
  const bin = found.ok ? found.stdout.trim().split('\n')[0] : ''
  const latest = await latestRelease(provider, opts.force === true)
  if (!bin) {
    return { provider, installed: false, version: null, path: null, install: null, latest, updateAvailable: false, updateCommand: null }
  }
  let real = bin
  try {
    real = realpathSync(bin)
  } catch {
    /* a dangling link still ran `which`; keep what it said */
  }
  const out = await execText(provider, ['--version'], { timeoutMs: 10_000 })
  const version = parseVersion(`${out.stdout}\n${out.stderr}`)
  const install = installMethodOf(real)
  return {
    provider,
    installed: true,
    version,
    path: real,
    install,
    latest,
    updateAvailable: version !== null && latest !== null && compareVersions(latest, version) > 0,
    updateCommand: updateCommandFor(provider, install)
  }
}

export async function listCliStatus(opts: { readonly force?: boolean } = {}): Promise<CliStatus[]> {
  return Promise.all((['claude', 'codex', 'copilot'] as const).map((p) => cliStatus(p, opts)))
}

/**
 * Write a Terminal hand-off script under Cockpit's own userData and return its path —
 * the caller opens it (`.command` files open in Terminal). Owner-only, and rewritten
 * each time, so nothing stale is ever run.
 */
export function writeTerminalScript(dir: string, name: string, content: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = join(dir, `${name}.command`)
  writeFileSync(file, content, { mode: 0o700 })
  chmodSync(file, 0o700)
  return file
}
