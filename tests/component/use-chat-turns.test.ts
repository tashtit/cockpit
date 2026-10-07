import { describe, it, expect } from 'vitest'
import { modeChangeNotice } from '../../src/renderer/src/use-chat-turns'

describe('modeChangeNotice', () => {
  it('says what a mode picked mid-turn did to the turn', () => {
    expect(modeChangeNotice('yolo', { live: true, allowed: 2 }, 'Copilot')).toBe(
      'Full access from here on — allowed the 2 requests waiting.'
    )
    expect(modeChangeNotice('yolo', { live: true, allowed: 1 }, 'Copilot')).toBe(
      'Full access from here on — allowed the request waiting.'
    )
    expect(modeChangeNotice('safe', { live: true, allowed: 0 }, 'Claude')).toBe('Ask first from here on.')
    // a CLI handed its mode at launch keeps it until the next message
    expect(modeChangeNotice('auto-edit', { live: false, allowed: 0 }, 'Codex')).toBe(
      'Accept edits starts with your next message — Codex can’t change mode mid-turn.'
    )
  })
})
