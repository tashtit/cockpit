import { chmodSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CliStatus, Provider } from '../shared/types'
import {
  CHANNEL_LABEL,
  CLI_PACKAGE,
  compareVersions,
  desktopAppOf,
  installMethodOf,
  parseVersion,
  updateCommandFor
} from '../shared/agent-cli'
import { PROVIDERS } from '../shared/providers'
import { brewVersion } from './agent-cli-core'
import { throttledBy } from './cache'
import { execText, loginPathReady } from './env'

/*
 * The agent CLIs as installed: the version off `--version`, the install method off the
 * binary's real path, and two versions to compare it with — the channel the install can
 * actually update from (Homebrew's own answer for a brew install) and the newest release
 * anywhere (the npm registry). Desktop-owned engines defer updates to their app and
 * are never compared with standalone releases. Updating and signing in need the person, so they run
 * as one-off Terminal scripts (`writeTerminalScript`); Cockpit never handles credentials.
 */

const LATEST_TTL_MS = 60 * 60_000
/** Homebrew's own answer is a local command, so it is re-read often — that is what
 *  lets a row notice a `brew update` the person just ran without asking again. */
const BREW_TTL_MS = 60_000

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
  return latestReleases(provider, { force })
}

/** Unreachable is an answer too — null, kept for the hour like any other. */
const latestReleases = throttledBy(LATEST_TTL_MS, async (provider: Provider): Promise<string | null> => {
  try {
    const res = await fetch(`https://registry.npmjs.org/${CLI_PACKAGE[provider].npm}/latest`, {
      signal: AbortSignal.timeout(8_000),
      headers: { accept: 'application/json' }
    })
    if (!res.ok) return null
    const j = (await res.json()) as { version?: unknown }
    return typeof j.version === 'string' ? parseVersion(j.version) : null
  } catch {
    return null // offline, or the registry is down — the check says "couldn't check"
  }
})

/**
 * What Homebrew has packaged for one CLI. A brew install can only ever get this — the
 * newest release upstream is not an update it can run, which is why it is asked for
 * separately rather than assumed from the registry.
 */
function brewLatest(provider: Provider, cask: boolean, force: boolean): Promise<string | null> {
  return brewPackaged({ token: CLI_PACKAGE[provider].brew, cask }, { force })
}

type BrewPackage = { readonly token: string; readonly cask: boolean }

const brewPackaged = throttledBy(
  BREW_TTL_MS,
  async ({ token, cask }: BrewPackage): Promise<string | null> => {
    const r = await execText('brew', ['info', '--json=v2', cask ? '--cask' : '--formula', token], {
      timeoutMs: 20_000
    })
    return r.ok ? parseVersion(brewVersion(r.stdout) ?? '') : null
  },
  { keyOf: ({ token, cask }) => `${token}|${cask ? 'cask' : 'formula'}` }
)

/** One CLI as this Mac has it: where, which version, how installed, and whether it is behind. */
export async function cliStatus(provider: Provider, opts: { readonly force?: boolean } = {}): Promise<CliStatus> {
  // an npm-installed CLI is only on the login shell's PATH: asked before that is read, it is "missing"
  await loginPathReady()
  const found = await execText('/usr/bin/which', [provider], { timeoutMs: 5_000 })
  const bin = found.ok ? found.stdout.trim().split('\n')[0] : ''
  const force = opts.force === true
  if (!bin) {
    const upstream = await latestRelease(provider, force)
    return {
      provider,
      installed: false,
      version: null,
      path: null,
      install: null,
      latest: upstream,
      upstream,
      channel: null,
      updateAvailable: false,
      updateCommand: null
    }
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
  if (install === 'desktop') {
    return {
      provider,
      installed: true,
      version,
      path: real,
      install,
      latest: null,
      upstream: null,
      channel: desktopAppOf(real),
      updateAvailable: false,
      updateCommand: null
    }
  }
  const upstream = await latestRelease(provider, force)
  // what this install can actually get: Homebrew packages releases on its own schedule,
  // so comparing a brew install against the newest release would offer an update that
  // `brew upgrade` cannot deliver. Copilot updates itself whatever installed it.
  const viaBrew = (install === 'brew-cask' || install === 'brew-formula') && provider !== 'copilot'
  const latest = viaBrew ? await brewLatest(provider, install === 'brew-cask', force) : upstream
  return {
    provider,
    installed: true,
    version,
    path: real,
    install,
    latest,
    upstream,
    channel: viaBrew ? CHANNEL_LABEL[install] : provider === 'copilot' ? 'its own updater' : CHANNEL_LABEL[install],
    updateAvailable: version !== null && latest !== null && compareVersions(latest, version) > 0,
    updateCommand: updateCommandFor(provider, install)
  }
}

export async function listCliStatus(opts: { readonly force?: boolean } = {}): Promise<CliStatus[]> {
  return Promise.all(PROVIDERS.map((p) => cliStatus(p, opts)))
}

/**
 * Write a Terminal hand-off script under Cockpit's own userData (`<userData>/terminal/`,
 * for `accounts:login`, `cli:update` and resume-in-terminal) and return its path —
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
