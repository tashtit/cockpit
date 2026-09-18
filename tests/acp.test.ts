import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { AcpAgent, ChatEvent, PermissionMode } from '../src/shared/types'
import { AcpTurn, probeAcpAgent } from '../src/main/acp'

/**
 * The real ACP client, driven against a stub agent that speaks the protocol the way
 * `copilot --acp` does (tests/fixtures/stub-acp-agent.mjs). No mocking: these spawn a
 * process and talk JSON-RPC to it, which is the only way the framing, the request
 * correlation and the permission round-trip are actually exercised.
 */

const STUB = fileURLToPath(new URL('./fixtures/stub-acp-agent.mjs', import.meta.url))
const cwd = mkdtempSync(join(tmpdir(), 'cockpit-acp-'))

function stubAgent(mode: string): AcpAgent {
  return {
    id: 'stub',
    label: 'Stub',
    command: process.execPath,
    args: [STUB],
    provider: 'copilot',
    env: { STUB_MODE: mode }
  }
}

type Run = { readonly events: ChatEvent[]; readonly turn: AcpTurn }

/** Start a turn and hand back the live event list; `onEvent` can answer mid-flight. */
function start(
  mode: string,
  opts: { permissionMode?: PermissionMode; resume?: string; onEvent?: (ev: ChatEvent, turn: AcpTurn) => void } = {}
): Run & { readonly done: Promise<void> } {
  const events: ChatEvent[] = []
  let turn!: AcpTurn
  turn = new AcpTurn(stubAgent(mode), {
    turnId: 't1',
    cwd,
    env: process.env,
    permissionMode: opts.permissionMode ?? 'safe',
    emit: (ev) => {
      events.push(ev)
      opts.onEvent?.(ev, turn)
    }
  })
  return { events, turn, done: turn.run('hello', opts.resume) }
}

const texts = (events: ChatEvent[]): string =>
  events
    .filter((e): e is Extract<ChatEvent, { type: 'text' }> => e.type === 'text')
    .map((e) => e.text)
    .join('')

describe('AcpTurn', () => {
  it('runs a turn: session id, tool call, usage, text, done', async () => {
    const { events, done } = start('basic')
    await done
    expect(events.map((e) => e.type)).toEqual(['session', 'tool', 'done'])
    expect(events[0]).toMatchObject({ type: 'session', nativeSessionId: 'sess-1' })
    expect(events[1]).toMatchObject({ type: 'tool', toolName: 'shell', preview: 'ls -la' })
  })

  it('stamps every event with the turn id it was started under', async () => {
    const { events, done } = start('basic')
    await done
    for (const ev of events) expect(ev.turnId).toBe('t1')
  })

  it('puts a permission question to the user and resumes once it is answered', async () => {
    const { events, done } = start('permission', {
      permissionMode: 'safe',
      onEvent: (ev, turn) => {
        if (ev.type === 'permission') turn.respondPermission(ev.requestId, 'allow_once')
      }
    })
    await done
    const ask = events.find((e) => e.type === 'permission')
    expect(ask).toMatchObject({ type: 'permission', toolName: 'shell', preview: 'Run ls -la' })
    expect((ask as Extract<ChatEvent, { type: 'permission' }>).options.map((o) => o.optionId)).toEqual([
      'allow_once',
      'reject_once'
    ])
    // the agent only continues because the answer reached it
    expect(texts(events)).toContain('answered:allow_once')
  })

  it('answers an edit permission itself in auto-edit, without asking', async () => {
    const { events, done } = start('permission-edit', { permissionMode: 'auto-edit' })
    await done
    expect(events.some((e) => e.type === 'permission')).toBe(false)
    expect(texts(events)).toContain('answered:allow_once')
  })

  it('still asks before executing in auto-edit', async () => {
    const { events, done } = start('permission', {
      permissionMode: 'auto-edit',
      onEvent: (ev, turn) => {
        if (ev.type === 'permission') turn.respondPermission(ev.requestId, 'reject_once')
      }
    })
    await done
    expect(events.some((e) => e.type === 'permission')).toBe(true)
    expect(texts(events)).toContain('answered:reject_once')
  })

  it('ignores an answer that does not match what was asked', async () => {
    const { events, done } = start('permission', {
      onEvent: (ev, turn) => {
        if (ev.type !== 'permission') return
        turn.respondPermission(ev.requestId, 'not_an_option') // dropped
        turn.respondPermission('99', 'allow_once') // stale id, dropped
        turn.respondPermission(ev.requestId, 'allow_once')
      }
    })
    await done
    expect(texts(events)).toContain('answered:allow_once')
  })

  it('refuses an open question when the turn is cancelled, so the agent is not left waiting', async () => {
    const { events, done } = start('permission', {
      onEvent: (ev, turn) => {
        if (ev.type === 'permission') turn.cancel()
      }
    })
    await done
    expect(texts(events)).toContain('answered:reject_once')
  })

  it('resumes a session and never replays its history into the chat', async () => {
    const { events, done } = start('basic', { resume: 'sess-old' })
    await done
    expect(events[0]).toMatchObject({ type: 'session', nativeSessionId: 'sess-old' })
    expect(texts(events)).not.toContain('REPLAYED-HISTORY')
  })

  it('starts a fresh session when the agent has forgotten the one being resumed', async () => {
    const { events, done } = start('noload-error', { resume: 'sess-old' })
    await done
    expect(events[0]).toMatchObject({ type: 'session', nativeSessionId: 'sess-1' })
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('does not try to load when the agent cannot', async () => {
    const { events, done } = start('noload', { resume: 'sess-old' })
    await done
    expect(events[0]).toMatchObject({ type: 'session', nativeSessionId: 'sess-1' })
  })

  it('declines fs and terminal calls rather than hanging, since it claimed neither', async () => {
    const { events, done } = start('fs-probe')
    await done
    expect(texts(events)).toContain('fs:')
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('skips a banner an agent prints to stdout before the protocol starts', async () => {
    const { events, done } = start('banner')
    await done
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    expect(texts(events)).not.toContain('StubAgent v9')
  })

  it('reports a turn that stopped early instead of showing an empty answer', async () => {
    const { events, done } = start('maxtokens')
    await done
    expect(events.at(-2)).toMatchObject({ type: 'error' })
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('surfaces a crashed agent with its stderr, and still ends the turn', async () => {
    const { events, done } = start('crash')
    await done
    const err = events.find((e) => e.type === 'error') as Extract<ChatEvent, { type: 'error' }>
    expect(err.message).toMatch(/exited with code 3/)
    expect(err.message).toMatch(/exploded during startup/)
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('reports a command that is not installed, rather than failing silently', async () => {
    const events: ChatEvent[] = []
    const turn = new AcpTurn(
      { id: 'x', label: 'Missing', command: 'cockpit-no-such-agent-binary', provider: 'copilot' },
      { turnId: 't1', cwd, env: process.env, permissionMode: 'safe', emit: (ev) => events.push(ev) }
    )
    await turn.run('hello')
    expect((events[0] as Extract<ChatEvent, { type: 'error' }>).message).toMatch(/not found on PATH/)
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('sends the prompt as an ACP text block', async () => {
    const { events, done } = start('echo-prompt')
    await done
    expect(texts(events)).toContain('[{"type":"text","text":"hello"}]')
  })
})

describe('probeAcpAgent', () => {
  it('reports what the agent said about itself and what it can do', async () => {
    const probe = await probeAcpAgent(stubAgent('basic'), cwd)
    expect(probe).toMatchObject({
      ok: true,
      name: 'Stub',
      version: '9.9',
      protocolVersion: 1,
      loadSession: true,
      listSessions: true,
      authMethods: ['Log in to Stub']
    })
  })

  it('reports an agent that cannot resume', async () => {
    expect(await probeAcpAgent(stubAgent('noload'), cwd)).toMatchObject({ ok: true, loadSession: false })
  })

  it('explains a command that does not exist instead of throwing', async () => {
    const probe = await probeAcpAgent(
      { id: 'x', label: 'x', command: 'cockpit-no-such-agent-binary', provider: 'copilot' },
      cwd
    )
    expect(probe.ok).toBe(false)
    expect(probe.error).toMatch(/was not found/)
  })

  it('explains an agent that exits instead of answering', async () => {
    const probe = await probeAcpAgent(stubAgent('crash'), cwd)
    expect(probe.ok).toBe(false)
    expect(probe.error).toMatch(/exited with code 3/)
  })

  it('never throws, whatever the definition', async () => {
    await expect(
      probeAcpAgent({ id: 'x', label: 'x', command: '/dev/null', provider: 'copilot' }, cwd)
    ).resolves.toMatchObject({
      ok: false
    })
  })
})
