import { describe, it, expect } from 'vitest'
import { claudeSignIn, codexSignIn, isMissingBinary, signInCommand } from '../src/main/agent-auth-core'
import { looksSignedOut, signInCommandLine, signInHint } from '../src/shared/agent-auth'

describe('reading a CLI’s own sign-in status', () => {
  it('claude: its JSON says, and anything else is unknown', () => {
    expect(claudeSignIn('{"loggedIn": true, "authMethod": "claudeai"}')).toBe('signed-in')
    expect(claudeSignIn('{"loggedIn": false, "authMethod": "none"}')).toBe('signed-out')
    expect(claudeSignIn('error: unknown command "auth"')).toBe('unknown')
    expect(claudeSignIn('{}')).toBe('unknown')
  })

  it('codex: its sentence says; a config error is not a signed-out verdict', () => {
    expect(codexSignIn('Logged in using ChatGPT', true)).toBe('signed-in')
    expect(codexSignIn('Not logged in', false)).toBe('signed-out')
    expect(codexSignIn('Error loading configuration: CODEX_HOME points to …', false)).toBe('unknown')
  })

  it('a CLI that is not installed is told apart from one that failed', () => {
    expect(isMissingBinary('spawn claude ENOENT')).toBe(true)
    expect(isMissingBinary('Command failed: codex login status')).toBe(false)
    expect(isMissingBinary(null)).toBe(false)
  })

  it('copilot has no status command, so it is never checked', () => {
    expect(signInCommand('copilot')).toBeNull()
    expect(signInCommand('claude')).toEqual(['claude', 'auth', 'status'])
  })
})

describe('naming the fix for a lapsed sign-in', () => {
  it('recognises the CLIs’ sign-in failures, not every failure', () => {
    expect(looksSignedOut('Failed to authenticate: OAuth session expired and could not be refreshed')).toBe(true)
    expect(looksSignedOut('Not logged in. Please run codex login.')).toBe(true)
    expect(looksSignedOut('API Error: 401 Unauthorized')).toBe(true)
    expect(looksSignedOut('turn failed: process exited with code 1')).toBe(false)
    expect(looksSignedOut('Working directory no longer exists: /x')).toBe(false)
  })

  it('names the command, and the config home when the seat has its own', () => {
    expect(signInHint('claude')).toBe('Run `claude auth login` in a terminal to sign in again.')
    // a home a person reads collapses to ~ (a shell expands it after =)
    expect(signInHint('codex', '/Users/me/.codex-work')).toBe(
      'Run `CODEX_HOME=~/.codex-work codex login` in a terminal to sign in again.'
    )
    expect(signInCommandLine('claude', '/opt/claude-home')).toBe('CLAUDE_CONFIG_DIR=/opt/claude-home claude auth login')
  })
})
