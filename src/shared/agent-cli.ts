import type { CliInstall, Provider } from './types'

/**
 * The agent CLIs as packages: where their releases are published and what Homebrew
 * calls them. Pure data plus the version and install-method rules both processes use.
 */
export const CLI_PACKAGE: Record<Provider, { readonly npm: string; readonly brew: string }> = {
  claude: { npm: '@anthropic-ai/claude-code', brew: 'claude-code' },
  codex: { npm: '@openai/codex', brew: 'codex' },
  copilot: { npm: '@github/copilot', brew: 'copilot-cli' }
}

/** Where an install gets its updates from — what a version number is compared against. */
export const CHANNEL_LABEL: Record<CliInstall, string> = {
  'brew-cask': 'Homebrew',
  'brew-formula': 'Homebrew',
  npm: 'npm',
  native: 'its own installer'
}

/** The first x.y.z in a `--version` line ("codex-cli 0.154.0", "2.1.236 (Claude Code)"). */
export function parseVersion(text: string): string | null {
  return /\d+\.\d+\.\d+/.exec(text)?.[0] ?? null
}

/** Numeric x.y.z order; a pre-release suffix is ignored (1.0.87-0 ranks as 1.0.87). */
export function compareVersions(a: string, b: string): number {
  const pa = (parseVersion(a) ?? '0.0.0').split('.').map(Number)
  const pb = (parseVersion(b) ?? '0.0.0').split('.').map(Number)
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}

/** How a CLI was installed, read off where its binary really lives. */
export function installMethodOf(realPath: string): CliInstall {
  if (/\/Caskroom\//.test(realPath)) return 'brew-cask'
  if (/\/Cellar\//.test(realPath)) return 'brew-formula'
  if (/\/node_modules\//.test(realPath)) return 'npm'
  return 'native'
}

/**
 * Whether a Terminal command line runs Homebrew. Homebrew does one thing at a time and
 * refuses a second `brew update` outright, so these take turns: main queues their
 * scripts on one lock, and a row says when its run is taking turns with another's.
 */
export function runsHomebrew(line: string): boolean {
  return /^brew\s/.test(line)
}

/**
 * The command that updates one CLI the way it was installed. Copilot updates itself in
 * place whatever put it there (its cask declares auto-updates, and a stale cask would
 * roll it back), so it always gets its own `copilot update`. Homebrew refreshes its
 * package list first: without that, it doesn't know a release exists.
 */
export function updateCommandFor(provider: Provider, install: CliInstall): string {
  if (provider === 'copilot') return 'copilot update'
  const pkg = CLI_PACKAGE[provider]
  switch (install) {
    case 'brew-cask':
      return `brew update && brew upgrade --cask ${pkg.brew}`
    case 'brew-formula':
      return `brew update && brew upgrade ${pkg.brew}`
    case 'npm':
      return `npm install -g ${pkg.npm}@latest`
    case 'native':
      return provider === 'claude' ? 'claude update' : `npm install -g ${pkg.npm}@latest`
  }
}
