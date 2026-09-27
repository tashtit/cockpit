import { describe, expect, it } from 'vitest'
import {
  JUMP_MARGIN,
  currentPrompt,
  isPrompt,
  promptLine,
  promptsOf,
  samePrompts,
  stepPrompt
} from '../src/renderer/src/prompt-nav'
import type { SessionMessage } from '../src/shared/types'

const user = (text: string): SessionMessage => ({ role: 'user', kind: 'text', text })
const reply = (text: string): SessionMessage => ({ role: 'assistant', kind: 'text', text })

describe('the messages a person sent', () => {
  it('are the rows the transcript draws as their bubble — never a tool result or a notice', () => {
    expect(isPrompt(user('fix the flake'))).toBe(true)
    expect(isPrompt(reply('done'))).toBe(false)
    expect(isPrompt({ role: 'user', kind: 'tool_result', text: 'ok' })).toBe(false)
    expect(isPrompt({ role: 'user', kind: 'system', text: 'resumed' })).toBe(false)
    expect(isPrompt({ role: 'tool', kind: 'tool_result', text: 'ok' })).toBe(false)
  })

  it('carry the key their row renders under and their place in the log', () => {
    const log = [user('one'), reply('a'), reply('b'), user('two')]
    expect(promptsOf(log, [40, 41, 42, 43])).toEqual([
      { key: 40, index: 0, text: 'one' },
      { key: 43, index: 3, text: 'two' }
    ])
  })

  it('are the same list while no message arrives, changes or moves', () => {
    const log = [user('one'), reply('a'), user('two')]
    const a = promptsOf(log, [0, 1, 2])
    // a reply streaming in changes nothing the rail draws
    expect(samePrompts(a, promptsOf([...log, reply('b')], [0, 1, 2, 3]))).toBe(true)
    expect(samePrompts(a, promptsOf([...log, user('three')], [0, 1, 2, 3]))).toBe(false)
    // a re-read that starts further in moves every message
    expect(samePrompts(a, promptsOf([reply('x'), ...log], [9, 0, 1, 2]))).toBe(false)
  })

  it('read on one line in a label, cut with an ellipsis', () => {
    expect(promptLine('  fix\n\nthe   flake ', 80)).toBe('fix the flake')
    expect(promptLine('abcdefghij', 6)).toBe('abcde…')
    expect(promptLine('abcdef', 6)).toBe('abcdef')
  })
})

describe('the message being read', () => {
  const view = { height: 600, atEnd: false }

  it('is the last one that starts above the upper third of the view', () => {
    expect(currentPrompt([-900, -40, 150, 420], view)).toBe(2)
    expect(currentPrompt([-900, -40, 250, 420], view)).toBe(1)
  })

  it('is the latest at the end of the transcript, however far up it started', () => {
    expect(currentPrompt([-900, -40, 250, 420], { height: 600, atEnd: true })).toBe(3)
    expect(currentPrompt([-2000, -1200], { height: 600, atEnd: true })).toBe(1)
  })

  it('counts a message older than the DOM window as above everything on screen', () => {
    expect(currentPrompt([null, null, 400], view)).toBe(1)
  })

  it('is none above the first message, and none in a session with no messages of theirs', () => {
    expect(currentPrompt([300, 900], view)).toBeNull()
    expect(currentPrompt([], { height: 600, atEnd: true })).toBeNull()
  })
})

describe('a step', () => {
  it('down goes to the next message, or the first from above them all', () => {
    expect(stepPrompt(1, JUMP_MARGIN, { count: 4, dir: 1 })).toBe(2)
    expect(stepPrompt(1, -500, { count: 4, dir: 1 })).toBe(2)
    expect(stepPrompt(null, null, { count: 4, dir: 1 })).toBe(0)
    expect(stepPrompt(3, JUMP_MARGIN, { count: 4, dir: 1 })).toBeNull()
  })

  it('up from a message at the top goes to the one before it', () => {
    expect(stepPrompt(2, JUMP_MARGIN, { count: 4, dir: -1 })).toBe(1)
    // near the end a message cannot reach the top — it is still the one being read
    expect(stepPrompt(3, 380, { count: 4, dir: -1 })).toBe(2)
    expect(stepPrompt(0, JUMP_MARGIN, { count: 4, dir: -1 })).toBeNull()
  })

  it('up from part-way through an answer goes back to its own message first', () => {
    expect(stepPrompt(2, -700, { count: 4, dir: -1 })).toBe(2)
    expect(stepPrompt(2, null, { count: 4, dir: -1 })).toBe(2)
  })

  it('goes nowhere above the first message or in a session with none', () => {
    expect(stepPrompt(null, null, { count: 4, dir: -1 })).toBeNull()
    expect(stepPrompt(null, null, { count: 0, dir: 1 })).toBeNull()
  })
})
