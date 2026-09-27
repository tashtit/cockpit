import { describe, expect, it } from 'vitest'
import { SIDE_FRAME, SIDE_HISTORY_MAX, sidePrompt, sideTurnRequest } from '../src/main/side-chat'
import { SIDE_QUESTION_MAX, sideChatSupported } from '../src/shared/side-chat'
import type { SideChatRequest, SideExchange } from '../src/shared/types'

const ask = (over: Partial<SideChatRequest> = {}): SideChatRequest => ({
  provider: 'claude',
  cwd: '/work/repo',
  nativeSessionId: 'sid-1',
  question: 'Why did it drop the cache?',
  ...over
})

describe('sidePrompt', () => {
  it('frames the question so the copy answers instead of carrying on with the task', () => {
    const p = sidePrompt('What is left?', [])
    expect(p.startsWith(SIDE_FRAME)).toBe(true)
    expect(p).toMatch(/nothing you say here reaches the session/)
    expect(p.endsWith('Question: What is left?')).toBe(true)
    expect(p).not.toMatch(/Earlier in this side chat/)
  })

  it('carries what the side chat said before — the copy holds only the session', () => {
    const p = sidePrompt('And the tests?', [{ question: 'What changed?', answer: 'The retry budget.' }])
    expect(p).toMatch(/Earlier in this side chat:\n\nQuestion: What changed\?\n\nYour answer: The retry budget\./)
    expect(p.indexOf('The retry budget.')).toBeLessThan(p.lastIndexOf('Question: And the tests?'))
  })

  it('carries only the latest exchanges, each cut to a bound', () => {
    const history: SideExchange[] = Array.from({ length: SIDE_HISTORY_MAX + 3 }, (_, i) => ({
      question: `q${i}`,
      answer: i === SIDE_HISTORY_MAX + 2 ? 'x'.repeat(10_000) : `a${i}`
    }))
    const p = sidePrompt('now?', history)
    expect(p).not.toMatch(/Question: q2\n/)
    expect(p).toMatch(/Question: q3\n/)
    expect(p).toMatch(/more chars\)/)
    expect(p.length).toBeLessThan(10_000)
  })
})

describe('sideTurnRequest', () => {
  it('is a safe, forked resume of the session named, with the question in its frame', () => {
    const req = sideTurnRequest(ask({ configDir: '/Users/me/.claude-work' }))
    expect(req).toMatchObject({
      provider: 'claude',
      cwd: '/work/repo',
      resumeNativeId: 'sid-1',
      permissionMode: 'safe',
      sideFork: true,
      configDir: '/Users/me/.claude-work'
    })
    expect(req.prompt).toMatch(/Question: Why did it drop the cache\?$/)
    expect(req.images).toBeUndefined()
  })

  it('keeps the session model and backend, nothing that loosens what the copy may do', () => {
    const req = sideTurnRequest(
      ask({
        provider: 'codex',
        options: {
          model: 'gpt-5',
          effort: 'high',
          fast: true,
          modelEndpoint: 'ep-1',
          codexSandbox: 'danger-full-access',
          acpAgent: 'mine',
          longContext: true
        }
      })
    )
    expect(req.options).toEqual({ model: 'gpt-5', effort: 'high', fast: true, modelEndpoint: 'ep-1' })
    expect(sideTurnRequest(ask({ options: {} })).options).toBeUndefined()
  })

  it('refuses an agent with no side chat, a session not named and an empty or oversized question', () => {
    expect(sideChatSupported('copilot')).toBe(false)
    expect(() => sideTurnRequest(ask({ provider: 'copilot' }))).toThrow(/isn't available/)
    expect(() => sideTurnRequest(ask({ nativeSessionId: '' }))).toThrow(/started session/)
    expect(() => sideTurnRequest(ask({ question: '   ' }))).toThrow(/Ask a question/)
    expect(() => sideTurnRequest(ask({ question: 'x'.repeat(SIDE_QUESTION_MAX + 1) }))).toThrow(/longer than/)
  })

  it('reads the history it is handed as untrusted: well-formed, answered exchanges only', () => {
    const history = [
      { question: 'ok?', answer: 'yes' },
      { question: 42, answer: 'no' },
      { question: 'empty', answer: '  ' },
      null,
      'nonsense'
    ] as unknown as SideExchange[]
    const req = sideTurnRequest(ask({ history }))
    expect(req.prompt).toMatch(/Question: ok\?\n\nYour answer: yes/)
    expect(req.prompt).not.toMatch(/empty|nonsense|42/)
    expect(sideTurnRequest(ask({ history: 'x' as unknown as SideExchange[] })).prompt).not.toMatch(/Earlier/)
  })
})
