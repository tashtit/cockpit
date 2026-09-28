import { describe, it, expect, vi } from 'vitest'
import type { SessionIndexer } from '../src/main/indexer'
import { TurnLedger } from '../src/main/turn-ledger'

/**
 * The ledger runs inside the chat stream's handler, ahead of the attention desk and the
 * window: whatever it does with an event must not keep that event from them.
 */

// a turn's done touches nothing of the index — only a `session` event does
const indexer = {} as SessionIndexer

describe('TurnLedger', () => {
  it('never lets a read-only agent’s turn end throw out of the stream handler', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const adopt = vi.fn(() => {
        throw new Error('ENOSPC: no space left on device')
      })
      const ledger = new TurnLedger(indexer, { onReadOnlyTurnDone: adopt })
      ledger.started('t1', { provider: 'gemini', cwd: '/tmp', prompt: 'hi', permissionMode: 'safe' }, { resumed: null })
      expect(() => ledger.chatEvent({ turnId: 't1', type: 'done' })).not.toThrow()
      expect(adopt).toHaveBeenCalledTimes(1)
      expect(errors).toHaveBeenCalled()
      // once per turn: a second done is not another adoption
      ledger.chatEvent({ turnId: 't1', type: 'done' })
      expect(adopt).toHaveBeenCalledTimes(1)
    } finally {
      errors.mockRestore()
    }
  })

  it('asks nothing of a turn of an agent Cockpit runs itself', () => {
    const adopt = vi.fn()
    const ledger = new TurnLedger(indexer, { onReadOnlyTurnDone: adopt })
    ledger.started('t1', { provider: 'claude', cwd: '/tmp', prompt: 'hi', permissionMode: 'safe' }, { resumed: null })
    ledger.chatEvent({ turnId: 't1', type: 'done' })
    expect(adopt).not.toHaveBeenCalled()
  })
})
