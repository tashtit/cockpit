import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { AcpAgent, BusySession } from '../src/shared/types'
import { ChatManager } from '../src/main/chat'

/**
 * ChatManager's bookkeeping for a turn driven over ACP, against the stub agent
 * (tests/fixtures/stub-acp-agent.mjs): what it tracks once the turn is over and the
 * agent's process is still there.
 */

const STUB = fileURLToPath(new URL('./fixtures/stub-acp-agent.mjs', import.meta.url))
const cwd = mkdtempSync(join(tmpdir(), 'cockpit-chat-acp-'))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Run one turn to its done with an agent that keeps running past it, as Cursor's does:
 * the manager, the agent's pid, and what the busy board said the moment the turn ended.
 */
async function lingering(mode: 'linger' | 'linger-hard'): Promise<{
  readonly chat: ChatManager
  readonly pid: number
  readonly busyAtDone: BusySession[]
}> {
  const pidFile = join(cwd, `${mode}-${Date.now()}.pid`)
  const agent: AcpAgent = {
    id: 'stub',
    label: 'Stub',
    command: process.execPath,
    args: [STUB],
    provider: 'cursor',
    env: { STUB_MODE: mode, STUB_PIDFILE: pidFile }
  }
  let finish!: (busy: BusySession[]) => void
  const done = new Promise<BusySession[]>((r) => (finish = r))
  const chat: ChatManager = new ChatManager(
    (ev) => {
      if (ev.type === 'done') finish(chat.busySessions())
    },
    { resolveAcpAgent: () => agent }
  )
  chat.send({ provider: 'cursor', cwd, prompt: 'hi', permissionMode: 'safe' })
  const busyAtDone = await done
  return { chat, pid: Number(readFileSync(pidFile, 'utf8')), busyAtDone }
}

describe('ChatManager: an ACP turn whose agent outlives it', () => {
  it('keeps the turn until its agent exits, so quitting stops it — off the busy board all the while', async () => {
    const { chat, pid, busyAtDone } = await lingering('linger')
    try {
      // the turn is over: nothing shows it running, nothing waits on it
      expect(busyAtDone).toEqual([])
      expect(chat.busySessions()).toEqual([])
      expect(chat.turnFor('cursor', 'sess-1')).toBeNull()
      // but its agent is still there, and quitting must reach it
      expect(alive(pid)).toBe(true)
      expect(chat.runningTurns()).toBe(1)
      chat.cancelAll()
      // well inside the grace the turn's own reaping waits before signalling
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 1500, interval: 50 })
      expect(chat.runningTurns()).toBe(0)
    } finally {
      if (alive(pid)) process.kill(pid, 'SIGKILL')
    }
  })

  it('stops an agent that ignores SIGTERM once its turn is over, and forgets the turn when it has gone', async () => {
    const { chat, pid } = await lingering('linger-hard')
    try {
      expect(chat.runningTurns()).toBe(1)
      // the grace, SIGTERM (ignored), then the group's SIGKILL
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 9000, interval: 100 })
      await vi.waitFor(() => expect(chat.runningTurns()).toBe(0))
    } finally {
      if (alive(pid)) process.kill(pid, 'SIGKILL')
    }
  }, 15_000)
})
