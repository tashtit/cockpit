import { describe, it, expect, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { AcpAgent, ChatEvent, PermissionMode } from '../src/shared/types'
import { AcpTurn, probeAcpAgent, stopAcpProbes } from '../src/main/acp'

/**
 * The real ACP client, driven against a stub agent that speaks the protocol the way
 * `copilot --acp` does (tests/fixtures/stub-acp-agent.mjs). No mocking: these spawn a
 * process and talk JSON-RPC to it, which is the only way the framing, the request
 * correlation and the permission round-trip are actually exercised.
 */

const STUB = fileURLToPath(new URL('./fixtures/stub-acp-agent.mjs', import.meta.url))
const cwd = mkdtempSync(join(tmpdir(), 'cockpit-acp-'))

function stubAgent(mode: string, over: Partial<AcpAgent> = {}): AcpAgent {
  return {
    id: 'stub',
    label: 'Stub',
    command: process.execPath,
    args: [STUB],
    provider: 'copilot',
    env: { STUB_MODE: mode },
    ...over
  }
}

type Run = { readonly events: ChatEvent[]; readonly turn: AcpTurn }

/** Start a turn and hand back the live event list; `onEvent` can answer mid-flight. */
function start(
  mode: string,
  opts: {
    permissionMode?: PermissionMode
    resume?: string
    mustResume?: boolean
    /** Whether a question can reach anyone — a chat by default, as most of these are */
    asksPermissions?: boolean
    /** How the agent is signed in, as a built-in names it */
    auth?: Pick<AcpAgent, 'authMethod' | 'signIn'>
    deadlines?: { handshake?: number; openSession?: number }
    /** Extra env for the stub (a pid file) */
    env?: Record<string, string>
    onEvent?: (ev: ChatEvent, turn: AcpTurn) => void
  } = {}
): Run & { readonly done: Promise<void> } {
  const events: ChatEvent[] = []
  let turn!: AcpTurn
  turn = new AcpTurn(stubAgent(mode, { ...opts.auth, env: { STUB_MODE: mode, ...opts.env } }), {
    turnId: 't1',
    cwd,
    env: process.env,
    permissionMode: opts.permissionMode ?? 'safe',
    mustResume: opts.mustResume,
    asksPermissions: opts.asksPermissions ?? true,
    deadlines: opts.deadlines,
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
    // the card shows the command itself, and the agent's title beside it
    expect(ask).toMatchObject({ type: 'permission', toolName: 'shell', preview: 'Run ls -la', detail: 'ls -la' })
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

  it('answers a command itself in yolo, for that call only', async () => {
    const { events, done } = start('permission', { permissionMode: 'yolo' })
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

  it('refuses a question nobody can see, for that call alone, instead of waiting on it', async () => {
    const { events, done } = start('permission', { asksPermissions: false })
    await done
    expect(events.some((e) => e.type === 'permission')).toBe(false)
    expect(texts(events)).toContain('answered:reject_once')
  })

  it('still answers what the mode allows when nobody can be asked', async () => {
    const { events, done } = start('permission-edit', { permissionMode: 'auto-edit', asksPermissions: false })
    await done
    expect(texts(events)).toContain('answered:allow_once')
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

  it('answers an open question as cancelled when the turn is, so the agent is not left waiting', async () => {
    const { events, done } = start('permission', {
      onEvent: (ev, turn) => {
        if (ev.type === 'permission') turn.cancel()
      }
    })
    await done
    // what the spec requires of a client that cancels — and never a refusal the agent keeps
    expect(texts(events)).toContain('answered:cancelled')
  })

  it('asks about each of two calls made at once, on a card apiece', async () => {
    const { events, done } = start('permission-pair', {
      onEvent: (ev, turn) => {
        if (ev.type === 'permission') turn.respondPermission(ev.requestId, 'allow_once')
      }
    })
    await done
    // two commands, not one asked twice
    const asked = events.filter((e): e is Extract<ChatEvent, { type: 'permission' }> => e.type === 'permission')
    expect(asked.map((e) => e.detail)).toEqual(['echo beta', 'echo alpha'])
    expect(texts(events)).toContain('answered:allow_once,allow_once')
  })

  describe('the mode, picked again while the turn runs', () => {
    /** The session modes the turn asked the agent for, in order */
    const modeLog = (): { readonly file: string; readonly read: () => string[] } => {
      const file = join(mkdtempSync(join(tmpdir(), 'cockpit-acp-mode-')), 'modes')
      return {
        file,
        read: () => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((id) => id.split('#')[1]) : [])
      }
    }

    it('answers the questions still open that the new mode allows, and moves the session into autopilot', async () => {
      const modes = modeLog()
      let answered: string[] = []
      let asked = 0
      const { events, done } = start('permission-pair', {
        env: { STUB_MODEFILE: modes.file },
        onEvent: (ev, turn) => {
          // both cards up, then the person picks Full access
          if (ev.type === 'permission' && ++asked === 2) answered = turn.setPermissionMode('yolo')
        }
      })
      await done
      const cards = events.flatMap((e) => (e.type === 'permission' ? [e.requestId] : []))
      expect(cards).toHaveLength(2)
      expect([...answered].sort()).toEqual([...cards].sort())
      expect(texts(events)).toContain('answered:allow_once,allow_once')
      expect(modes.read()).toEqual(['autopilot'])
    })

    it('leaves a command asking under Accept edits', async () => {
      let answered: string[] = ['unset']
      const { events, done } = start('permission-pair', {
        onEvent: (ev, turn) => {
          if (ev.type !== 'permission') return
          answered = turn.setPermissionMode('auto-edit')
          turn.respondPermission(ev.requestId, 'reject_once')
        }
      })
      await done
      expect(answered).toEqual([])
      expect(texts(events)).toContain('answered:reject_once,reject_once')
    })

    it('takes a reopened session out of the autopilot it was left in, for a turn that is not Full access', async () => {
      const modes = modeLog()
      const { done } = start('basic', { resume: 'sess-old', env: { STUB_LOAD_MODE: 'autopilot', STUB_MODEFILE: modes.file } })
      await done
      expect(modes.read()).toEqual(['agent'])
    })

    it('puts a Full access turn in autopilot, new or reopened, and asks nothing of one already there', async () => {
      const fresh = modeLog()
      await start('basic', { permissionMode: 'yolo', env: { STUB_MODEFILE: fresh.file } }).done
      expect(fresh.read()).toEqual(['autopilot'])
      const reopened = modeLog()
      await start('basic', { permissionMode: 'yolo', resume: 'sess-old', env: { STUB_MODEFILE: reopened.file } }).done
      expect(reopened.read()).toEqual(['autopilot'])
      const already = modeLog()
      await start('basic', {
        permissionMode: 'yolo',
        resume: 'sess-old',
        env: { STUB_LOAD_MODE: 'autopilot', STUB_MODEFILE: already.file }
      }).done
      expect(already.read()).toEqual([])
      // and a turn that is not Full access leaves a session in the agent's default alone
      const plain = modeLog()
      await start('basic', { resume: 'sess-old', env: { STUB_MODEFILE: plain.file } }).done
      expect(plain.read()).toEqual([])
    })
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

  // an agent Cockpit only reads: whether its ACP server knows a session by the id its
  // store gives it is the agent's business, so a quiet fresh session would answer the
  // person without the history they are looking at
  it('fails a resume that must continue the conversation, when the agent has forgotten it', async () => {
    const { events, done } = start('noload-error', { resume: 'sess-old', mustResume: true })
    await done
    expect(events.map((e) => e.type)).toEqual(['error', 'done'])
    expect(events[0]).toMatchObject({ message: expect.stringMatching(/^Stub couldn't reopen this conversation over ACP/) })
  })

  it('fails a resume that must continue the conversation, when the agent cannot load one', async () => {
    const { events, done } = start('noload', { resume: 'sess-old', mustResume: true })
    await done
    expect(events.map((e) => e.type)).toEqual(['error', 'done'])
    expect(events[0]).toMatchObject({ message: expect.stringMatching(/^Stub can't reopen a conversation over ACP/) })
  })

  it('still starts a new conversation freely when one must resume', async () => {
    const { events, done } = start('noload', { mustResume: true })
    await done
    expect(events[0]).toMatchObject({ type: 'session', nativeSessionId: 'sess-1' })
  })

  // Cursor's agent answers every session with ACP's auth-required error until the client
  // calls `authenticate` with the method that reuses its CLI's own sign-in
  it('signs in with the method a built-in names, once, when the agent asks', async () => {
    const { events, done } = start('auth', { auth: { authMethod: 'stub-login', signIn: 'stub login' } })
    await done
    expect(events.map((e) => e.type)).toEqual(['session', 'tool', 'done'])
  })

  it('says how to sign in when signing in there does not work', async () => {
    const { events, done } = start('auth-fail', { auth: { authMethod: 'stub-login', signIn: 'stub login' } })
    await done
    expect(events.map((e) => e.type)).toEqual(['error', 'done'])
    expect((events[0] as { message: string }).message).toBe(
      'Stub needs signing in: Authentication required — sign it in by running `stub login` in a terminal, then send again.'
    )
  })

  it('never signs in with a method no one named — the agent’s reason stands', async () => {
    const { events, done } = start('auth')
    await done
    expect(events.map((e) => e.type)).toEqual(['error', 'done'])
    expect((events[0] as { message: string }).message).toBe('Stub needs signing in: Authentication required.')
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

  it('fails the connection at once on a message past the size cap, even one that never ends', async () => {
    const { events, done } = start('huge')
    await done
    const err = events.find((e) => e.type === 'error') as Extract<ChatEvent, { type: 'error' }>
    expect(err.message).toMatch(/larger than 8MB/)
    expect(events.at(-1)).toMatchObject({ type: 'done' })
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

  // a probe gives up on a silent agent; a turn used to spin until someone pressed Stop
  it('fails a turn whose agent never answers the handshake, naming the agent, and ends it', async () => {
    const pidFile = join(cwd, `mute-${Date.now()}.pid`)
    const { events, done } = start('mute', { deadlines: { handshake: 1000 }, env: { STUB_PIDFILE: pidFile } })
    await done
    expect(events.map((e) => e.type)).toEqual(['error', 'done'])
    expect((events[0] as { message: string }).message).toMatch(/^Stub did not answer the ACP handshake within 1 second\b/)
    // it ignores EOF too: the turn's reaping still ends it
    const pid = Number(readFileSync(pidFile, 'utf8'))
    try {
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 8000, interval: 100 })
    } finally {
      if (alive(pid)) process.kill(pid, 'SIGKILL')
    }
  })

  it('fails a turn whose agent never opens the session', async () => {
    const { events, done } = start('no-session', { deadlines: { openSession: 1000 } })
    await done
    expect(events.map((e) => e.type)).toEqual(['error', 'done'])
    expect((events[0] as { message: string }).message).toBe('Stub did not open the session within 1 second.')
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

  it('lets what the turn pins win over the definition’s own env', async () => {
    // the definition asks for one behaviour, the turn pins another: the turn's (a custom
    // provider's base URL and key, the config home) is what the agent must see
    const events: ChatEvent[] = []
    const turn = new AcpTurn(stubAgent('crash'), {
      turnId: 't1',
      cwd,
      env: process.env,
      pinned: { STUB_MODE: 'basic' },
      permissionMode: 'safe',
      emit: (ev) => events.push(ev)
    })
    await turn.run('hello')
    expect(events.map((e) => e.type)).toEqual(['session', 'tool', 'done'])
  })

  it('sends the prompt as an ACP text block', async () => {
    const { events, done } = start('echo-prompt')
    await done
    expect(texts(events)).toContain('[{"type":"text","text":"hello"}]')
  })
})

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('probeAcpAgent', () => {
  // a probe runs for every built-in at every launch: what it starts must not outlive it.
  // The stub's launcher exits on SIGTERM while its child ignores it — a SIGKILL keyed to
  // the launcher's exit would never reach the child
  it('ends the agent and everything it started, even what ignores SIGTERM', async () => {
    const pidFile = join(cwd, `probe-${Date.now()}.pid`)
    const probe = await probeAcpAgent({ ...stubAgent('relaunch'), env: { STUB_MODE: 'relaunch', STUB_PIDFILE: pidFile } }, cwd)
    expect(probe.ok).toBe(true)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    try {
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 8000, interval: 100 })
    } finally {
      if (alive(pid)) process.kill(pid, 'SIGKILL')
    }
  })

  // each probe is detached: one still waiting on its handshake when Cockpit quits would
  // outlive it, and so would one whose group has not had its SIGKILL yet
  it('ends every probe still running when Cockpit quits', async () => {
    const pidFile = join(cwd, `probe-mute-${Date.now()}.pid`)
    const pending = probeAcpAgent({ ...stubAgent('mute'), env: { STUB_MODE: 'mute', STUB_PIDFILE: pidFile } }, cwd)
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 5000 })
    const pid = Number(readFileSync(pidFile, 'utf8'))
    try {
      stopAcpProbes()
      expect((await pending).ok).toBe(false)
      await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 1000, interval: 50 })
    } finally {
      if (alive(pid)) process.kill(pid, 'SIGKILL')
    }
  })

  // Gemini CLI and Cursor's agent read the whole tree they start in: a probe from home
  // walks into ~/Music and ~/Pictures, and macOS asks for both on Cockpit's behalf
  it('runs the agent in the folder it is given, making it first', async () => {
    const dir = join(cwd, `probe-dir-${Date.now()}`, 'nested')
    const cwdFile = join(cwd, `probe-${Date.now()}.cwd`)
    const probe = await probeAcpAgent({ ...stubAgent('basic'), env: { STUB_MODE: 'basic', STUB_CWDFILE: cwdFile } }, dir)
    expect(probe.ok).toBe(true)
    expect(readFileSync(cwdFile, 'utf8')).toBe(realpathSync(dir))
  })

  it('says so when the folder cannot be made, instead of blaming the command', async () => {
    const file = join(cwd, `probe-file-${Date.now()}`)
    writeFileSync(file, '')
    const probe = await probeAcpAgent(stubAgent('basic'), join(file, 'inside'))
    expect(probe.ok).toBe(false)
    expect(probe.error).toMatch(/could not make the folder the check runs in/)
  })

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
