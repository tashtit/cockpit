import { describe, expect, it } from 'vitest'
import { findAnchor } from '../src/renderer/src/transcript-anchor'
import type { SessionMessage } from '../src/shared/types'

const user = (text: string, ts?: number): SessionMessage => ({ role: 'user', kind: 'text', text, ts })
const agent = (text: string, ts?: number): SessionMessage => ({ role: 'assistant', kind: 'text', text, ts })
const tool = (text: string): SessionMessage => ({ role: 'assistant', kind: 'tool_call', toolName: 'Bash', text })

const log: readonly SessionMessage[] = [
  user('The login e2e test flakes on CI roughly one run in five.', 1000),
  agent('Let me reproduce it first.', 2000),
  tool('npm run test:e2e -- --grep login'),
  agent('I traced the flake to the retry loop in\nsrc/auth/login.ts.\n\nThe client gives up after one attempt.', 3000),
  user('Yes, add the regression test. Then commit.', 4000),
  agent('Adding a test that stubs a slow DNS resolver.', 5000)
]

describe('findAnchor', () => {
  it('names the message by its words, ellipses and line breaks aside', () => {
    expect(
      findAnchor(log, { role: 'assistant', snippet: '…the retry loop in src/auth/login.ts. The client gives…', timestamp: 3000 })
    ).toBe(3)
  })

  it('a user hit finds the user turn, not an agent quoting it', () => {
    const quoted = [...log, agent('You said: add the regression test. Then commit.', 6000)]
    expect(findAnchor(quoted, { role: 'user', snippet: 'add the regression test. Then commit.', timestamp: 4000 })).toBe(4)
    expect(findAnchor(quoted, { role: 'assistant', snippet: 'add the regression test. Then commit.', timestamp: 6000 })).toBe(6)
  })

  it('a tool hit lands on the call row', () => {
    expect(findAnchor(log, { role: 'tool', snippet: 'npm run test:e2e -- --grep login', timestamp: null })).toBe(2)
  })

  it('the same words twice: the one said nearest the hit, else the newest', () => {
    const twice = [agent('Running the suite.', 100), agent('Running the suite.', 900), agent('Running the suite.', 2000)]
    expect(findAnchor(twice, { role: 'assistant', snippet: 'Running the suite.', timestamp: 950 })).toBe(1)
    expect(findAnchor(twice, { role: 'assistant', snippet: 'Running the suite.', timestamp: null })).toBe(2)
  })

  it('falls back through case, then speaker, before giving up', () => {
    expect(findAnchor(log, { role: 'assistant', snippet: 'let me REPRODUCE it', timestamp: null })).toBe(1)
    expect(findAnchor(log, { role: 'user', snippet: 'stubs a slow DNS resolver', timestamp: null })).toBe(5)
    expect(findAnchor(log, { role: 'assistant', snippet: 'nothing in this log says this', timestamp: null })).toBe(-1)
    expect(findAnchor(log, { role: 'assistant', snippet: '…', timestamp: null })).toBe(-1)
  })
})
