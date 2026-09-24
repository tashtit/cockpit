import { describe, it, expect } from 'vitest'
import {
  agentsLines,
  COCKPIT_REPO_URL,
  FEEDBACK_URL_MAX,
  feedbackPrefills,
  feedbackUrl,
  macosLine,
  type FeedbackCli,
  type FeedbackFacts
} from '../src/shared/feedback'
import type { CliStatus } from '../src/shared/types'

const app: NonNullable<FeedbackFacts['app']> = {
  version: '0.30.0',
  packaged: true,
  platform: 'darwin',
  arch: 'arm64',
  osVersion: '26.0'
}

const clis: readonly FeedbackCli[] = [
  { provider: 'claude', installed: true, version: '2.1.236', install: 'brew-cask' },
  { provider: 'codex', installed: true, version: '0.154.0', install: 'npm' },
  { provider: 'copilot', installed: false, version: null, install: null }
]

/** The query of a feedback URL, decoded the way GitHub reads it. */
function params(url: string): Record<string, string> {
  return Object.fromEntries(new URL(url).searchParams)
}

describe('feedback links', () => {
  it('sends a problem report to the bug form, prefilled with versions only', () => {
    const url = feedbackUrl('bug', { app, clis })
    expect(url.startsWith(`${COCKPIT_REPO_URL}/issues/new?template=bug.yml&`)).toBe(true)
    expect(params(url)).toEqual({
      template: 'bug.yml',
      version: '0.30.0',
      macos: '26.0 (arm64)',
      agents: 'Claude Code: 2.1.236 (Homebrew cask)\nCodex: 0.154.0 (npm)\nCopilot: not installed'
    })
  })

  it('sends missing or wrong sessions to their own form with the same facts', () => {
    const url = feedbackUrl('sessions', { app, clis })
    expect(url.startsWith(`${COCKPIT_REPO_URL}/issues/new?template=sessions.yml&`)).toBe(true)
    expect(Object.keys(params(url))).toEqual(['template', 'version', 'macos', 'agents'])
  })

  it('opens an idea bare, and discussions with no query at all', () => {
    // neither form asks about this Mac, so neither is told
    expect(feedbackUrl('idea', { app, clis })).toBe(`${COCKPIT_REPO_URL}/issues/new?template=idea.yml`)
    expect(feedbackUrl('discussion', { app, clis })).toBe(`${COCKPIT_REPO_URL}/discussions`)
    expect(feedbackPrefills('idea')).toBe(false)
    expect(feedbackPrefills('discussion')).toBe(false)
    expect(feedbackPrefills('bug')).toBe(true)
    expect(feedbackPrefills('sessions')).toBe(true)
  })

  it('percent-encodes every value, spaces and line breaks included', () => {
    const url = feedbackUrl('bug', { app, clis })
    expect(url).toContain('&macos=26.0%20(arm64)')
    expect(url).toContain('Claude%20Code%3A%202.1.236%20(Homebrew%20cask)%0ACodex')
    // nothing a query could be split on survives unencoded
    const query = url.slice(url.indexOf('?') + 1)
    for (const pair of query.split('&')) expect(pair.split('=')).toHaveLength(2)
    expect(url).not.toMatch(/\s|\+/)
  })

  it('never carries a path, even when the CLI status it was built from has one', () => {
    const status: CliStatus = {
      provider: 'claude',
      installed: true,
      version: '2.1.236',
      path: '/Users/someone/.local/share/claude/versions/2.1.236',
      install: 'native',
      latest: '2.1.278',
      upstream: '2.1.278',
      channel: 'its own installer',
      updateAvailable: true,
      updateCommand: 'claude update'
    }
    const url = feedbackUrl('bug', { app, clis: [status] })
    expect(params(url)['agents']).toBe('Claude Code: 2.1.236 (native install)')
    expect(decodeURIComponent(url)).not.toContain('someone')
  })

  it('leaves the fields it cannot fill to the person', () => {
    // nothing known: the form opens empty rather than with guesses
    expect(feedbackUrl('bug')).toBe(`${COCKPIT_REPO_URL}/issues/new?template=bug.yml`)
    // the CLIs could not be read in time: version and macOS still go
    expect(Object.keys(params(feedbackUrl('bug', { app, clis: null })))).toEqual(['template', 'version', 'macos'])
    expect(Object.keys(params(feedbackUrl('bug', { app, clis: [] })))).toEqual(['template', 'version', 'macos'])
    // the app info had not arrived: the agents still do
    expect(Object.keys(params(feedbackUrl('sessions', { app: null, clis })))).toEqual(['template', 'agents'])
  })

  it('says what it could not read about a CLI rather than dropping the line', () => {
    expect(
      agentsLines([
        { provider: 'claude', installed: true, version: null, install: 'npm' },
        { provider: 'codex', installed: true, version: '0.154.0', install: null }
      ])
    ).toBe('Claude Code: version unknown (npm)\nCodex: 0.154.0')
  })

  it('marks a development run, whose version says nothing on its own', () => {
    const url = feedbackUrl('bug', { app: { ...app, version: '0.0.0', packaged: false } })
    expect(params(url)['version']).toBe('0.0.0 (development run)')
  })

  it('names the OS outright when it is not macOS', () => {
    expect(macosLine(app)).toBe('26.0 (arm64)')
    expect(macosLine({ ...app, platform: 'linux', osVersion: '6.8.0', arch: 'x64' })).toBe('linux 6.8.0 (x64)')
    expect(macosLine({ ...app, osVersion: '' })).toBe('(arm64)')
  })

  it('stays under the length cap by leaving a field out whole, never cutting one', () => {
    const huge = 'x'.repeat(FEEDBACK_URL_MAX)
    const long = feedbackUrl('bug', { app: { ...app, osVersion: huge }, clis })
    expect(long.length).toBeLessThanOrEqual(FEEDBACK_URL_MAX)
    // the oversized field is gone; the ones around it still fit and still go
    expect(params(long)).toEqual({
      template: 'bug.yml',
      version: '0.30.0',
      agents: 'Claude Code: 2.1.236 (Homebrew cask)\nCodex: 0.154.0 (npm)\nCopilot: not installed'
    })

    const everything = feedbackUrl('bug', { app: { ...app, version: huge, osVersion: huge }, clis })
    expect(everything.length).toBeLessThanOrEqual(FEEDBACK_URL_MAX)
    expect(Object.keys(params(everything))).toEqual(['template', 'agents'])
  })

  it('keeps the everyday prefill far inside the cap', () => {
    expect(feedbackUrl('bug', { app, clis }).length).toBeLessThan(FEEDBACK_URL_MAX / 4)
  })
})
