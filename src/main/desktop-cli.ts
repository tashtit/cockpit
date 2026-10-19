import { accessSync, constants, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { compareVersions, desktopAppOf, parseVersion } from '../shared/agent-cli'

/**
 * CLI directories owned by the macOS desktop apps, appended after standalone installs.
 * Nothing is copied or linked. Claude keeps versioned engines beside its app data, so
 * discovery is repeated for each spawn rather than pinning a path an update removes.
 * Only known CLI locations qualify; Claude.app's MacOS/claude is the GUI executable.
 * A selected desktop Claude engine cannot self-update into a standalone installation.
 */
type DesktopCliOptions = {
  readonly home?: string
  readonly applications?: string[]
  readonly platform?: string
}

export function desktopCliDirs(options: DesktopCliOptions = {}): string[] {
  const home = options.home || homedir()
  const platform = options.platform || process.platform
  if (platform !== 'darwin') {
    return []
  }
  // The test worlds name their own application directories, so a system app never
  // leaks into a fixture HOME. An empty override disables desktop discovery.
  const override = process.env['COCKPIT_DESKTOP_APPLICATIONS']
  const applications = (options.applications || override?.split(delimiter) || [join(home, 'Applications'), '/Applications'])
    .filter(isAbsolute)
  const codex = applications.flatMap((dir) => ['Codex.app', 'ChatGPT.app'].flatMap((app) => [
    join(dir, app, 'Contents/Resources/codex'),
    join(dir, app, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex')
  ])).find(isExecutable)
  const hasClaude = applications.some((dir) => isDirectory(join(dir, 'Claude.app')))
  const claudeRoot = join(home, 'Library/Application Support/Claude/claude-code')
  const claude = hasClaude
    ? versionsIn(claudeRoot)
      .sort((a, b) => compareVersions(b, a))
      .map((version) => join(claudeRoot, version, 'claude.app/Contents/MacOS/claude'))
      .find(isExecutable)
    : undefined

  return [codex, claude].filter((path) => path !== undefined).map((path) => dirname(path))
}

/** Keep the desktop app in charge only when PATH actually selects its Claude engine. */
export function desktopCliEnv(path: string): NodeJS.ProcessEnv {
  const claude = path.split(delimiter).filter(isAbsolute)
    .map((dir) => join(dir, 'claude')).find(isExecutable)
  if (!claude) {
    return {}
  }
  try {
    return desktopAppOf(realpathSync(claude)) === 'Claude desktop'
      ? { DISABLE_UPDATES: '1', DISABLE_AUTOUPDATER: '1' }
      : {}
  } catch (err) {
    if (!unavailable(err)) {
      console.warn(`[desktop-cli] Couldn't resolve '${claude}':`, err)
    }
    return {}
  }
}

function unavailable(err: unknown): boolean {
  return err instanceof Error && 'code' in err &&
    ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(String(err.code))
}

function isExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) {
      return false
    }
    accessSync(path, constants.X_OK)

    return true
  } catch (err) {
    if (!unavailable(err)) {
      console.warn(`[desktop-cli] Couldn't inspect '${path}':`, err)
    }
    return false
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch (err) {
    if (!unavailable(err)) {
      console.warn(`[desktop-cli] Couldn't inspect '${path}':`, err)
    }
    return false
  }
}

function versionsIn(path: string): string[] {
  try {
    return readdirSync(path).filter((version) => parseVersion(version) === version)
  } catch (err) {
    if (!unavailable(err)) {
      console.warn(`[desktop-cli] Couldn't read '${path}':`, err)
    }
    return []
  }
}
