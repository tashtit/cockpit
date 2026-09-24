import { SEAT_NAME } from './roundtable'
import type { AppInfo, CliInstall, CliStatus } from './types'

/**
 * Where feedback goes: the repository's issue forms and discussions, one click from
 * Settings › About. A report opens GitHub with the facts a maintainer asks for first
 * already in the form — and only those. Everything here is what this build and this
 * Mac run (versions, an install method), never who is running it or where: no paths,
 * no usernames, no account identities, no session content. The person sees every
 * field before anything is submitted.
 */

/** The repository — releases, issues and discussions all live under it. */
export const COCKPIT_REPO_URL = 'https://github.com/tashtit/cockpit'

/**
 * The longest URL a feedback link may be. 2,000 characters passes every browser and
 * proxy and is far under what GitHub itself accepts; the prefill is a few hundred, so
 * the cap only ever bites on input nobody expected — and then a field is left out
 * whole rather than cut mid-line.
 */
export const FEEDBACK_URL_MAX = 2000

export type FeedbackKind = 'bug' | 'sessions' | 'idea' | 'discussion'

type Target = {
  readonly path: string
  /** The issue form, by its file name under `.github/ISSUE_TEMPLATE` */
  readonly template?: string
  /** Whether the form carries the version / macOS / agents fields */
  readonly facts: boolean
}

const TARGETS: Record<FeedbackKind, Target> = {
  bug: { path: '/issues/new', template: 'bug.yml', facts: true },
  sessions: { path: '/issues/new', template: 'sessions.yml', facts: true },
  idea: { path: '/issues/new', template: 'idea.yml', facts: false },
  discussion: { path: '/discussions', facts: false }
}

/** Whether this kind of feedback is prefilled — the only ones worth asking the CLIs for. */
export function feedbackPrefills(kind: FeedbackKind): boolean {
  return TARGETS[kind].facts
}

/** What a CLI row may contribute: its version and how it was installed — never its path. */
export type FeedbackCli = Pick<CliStatus, 'provider' | 'installed' | 'version' | 'install'>

/** The facts a report can be prefilled with. Either half may be missing; its fields are then left for the person. */
export type FeedbackFacts = {
  readonly app?: Pick<AppInfo, 'version' | 'packaged' | 'platform' | 'arch' | 'osVersion'> | null
  readonly clis?: readonly FeedbackCli[] | null
}

const INSTALL_LABEL: Record<CliInstall, string> = {
  'brew-cask': 'Homebrew cask',
  'brew-formula': 'Homebrew formula',
  npm: 'npm',
  native: 'native install'
}

/** "0.30.0", or "0.0.0 (development run)" — a dev build's version says nothing on its own. */
export function versionLine(app: NonNullable<FeedbackFacts['app']>): string {
  return app.packaged ? app.version : `${app.version} (development run)`
}

/** "26.0 (arm64)" — the macOS product version, not Darwin's, and the build's architecture. */
export function macosLine(app: NonNullable<FeedbackFacts['app']>): string {
  const os = app.osVersion.trim()
  const version = app.platform === 'darwin' ? os : `${app.platform} ${os}`.trim()
  return version ? `${version} (${app.arch})` : `(${app.arch})`
}

/** One line per agent CLI: "Claude Code: 2.1.236 (Homebrew cask)", "Copilot: not installed". */
export function agentsLines(clis: readonly FeedbackCli[]): string {
  return clis
    .map((c) => {
      const name = SEAT_NAME[c.provider]
      if (!c.installed) return `${name}: not installed`
      const how = c.install ? ` (${INSTALL_LABEL[c.install]})` : ''
      return `${name}: ${c.version ?? 'version unknown'}${how}`
    })
    .join('\n')
}

/**
 * The GitHub link for one kind of feedback, with the facts it can carry. Fields are
 * added in the order a maintainer reads them — version, macOS, agents — and one that
 * would take the link past `FEEDBACK_URL_MAX` is left out, never truncated.
 */
export function feedbackUrl(kind: FeedbackKind, facts: FeedbackFacts = {}): string {
  const target = TARGETS[kind]
  let url = `${COCKPIT_REPO_URL}${target.path}`
  if (target.template) url += `?template=${encodeURIComponent(target.template)}`
  if (!target.facts) return url

  const fields: Array<readonly [string, string]> = []
  if (facts.app) {
    fields.push(['version', versionLine(facts.app)], ['macos', macosLine(facts.app)])
  }
  if (facts.clis && facts.clis.length > 0) fields.push(['agents', agentsLines(facts.clis)])

  for (const [id, value] of fields) {
    const pair = `${url.includes('?') ? '&' : '?'}${id}=${encodeURIComponent(value)}`
    if (url.length + pair.length <= FEEDBACK_URL_MAX) url += pair
  }
  return url
}
