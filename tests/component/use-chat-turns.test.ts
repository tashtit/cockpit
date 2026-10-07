import { describe, it, expect, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { modeChangeNotice, useChatTurns } from '../../src/renderer/src/use-chat-turns'
import { setChatLog, useChatLog } from '../../src/renderer/src/chat-log'

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

describe('useChatTurns: a mode picked while the turn runs', () => {
  /** The hook, with the transcript it writes to beside it */
  function turns(): { readonly current: { readonly chat: ReturnType<typeof useChatTurns>; readonly log: ReturnType<typeof useChatLog> } } {
    setChatLog([])
    const { result } = renderHook(() => ({
      chat: useChatTurns({ speaker: () => 'Copilot', onSession: () => {}, onSettled: () => {} }),
      log: useChatLog()
    }))
    return result
  }
  const notices = (log: ReturnType<typeof useChatLog>): string[] => log.filter((m) => m.role === 'system').map((m) => m.text)

  it('goes with the next message alone while nothing runs', () => {
    const r = turns()
    act(() => r.current.chat.changeMode('yolo'))
    expect(window.cockpit.setTurnMode).not.toHaveBeenCalled()
    expect(notices(r.current.log)).toEqual([])
  })

  it('reaches the running turn, and the transcript says what it did', async () => {
    vi.mocked(window.cockpit.setTurnMode).mockResolvedValue({ live: true, allowed: 2 })
    const r = turns()
    await act(() => r.current.chat.run({ provider: 'copilot', cwd: '/w', prompt: 'go', permissionMode: 'safe' }))
    act(() => r.current.chat.changeMode('yolo'))
    expect(window.cockpit.setTurnMode).toHaveBeenCalledWith('turn-1', 'yolo')
    await waitFor(() =>
      expect(notices(r.current.log)).toEqual(['Full access from here on — allowed the 2 requests waiting.'])
    )
  })

  it('says so when main refused the change', async () => {
    vi.mocked(window.cockpit.setTurnMode).mockRejectedValue(new Error('unknown permission mode'))
    const r = turns()
    await act(() => r.current.chat.run({ provider: 'copilot', cwd: '/w', prompt: 'go', permissionMode: 'safe' }))
    act(() => r.current.chat.changeMode('yolo'))
    await waitFor(() => expect(notices(r.current.log).join()).toMatch(/Couldn’t change the running turn’s mode: unknown permission mode/))
  })
})
