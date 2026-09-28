import { describe, it, expect } from 'vitest'
import type { AcpAgent, AcpAgentProbe, AcpPermissionOption, ChatEvent } from '../src/shared/types'
import {
  acpAgentRefusal,
  acpCanReopen,
  acpStoreRefusal,
  BLOCKED_AGENT_ENV,
  isBlockedAgentEnv,
  BUILTIN_ACP_AGENTS,
  builtinAgentFor,
  isValidAcpCommand,
  sanitizeAcpAgent
} from '../src/shared/acp'
import {
  acpUpdateToEvents,
  BuiltinReadiness,
  decidePermission,
  initializeParams,
  modeIdFor,
  PERMISSION_COMMAND_MAX,
  permissionDetail,
  permissionOptions,
  promptResultEvents,
  REPROBE_EVERY_MS,
  unattendedOutcome
} from '../src/main/acp-core'

/** The shapes here are copied from a real `copilot --acp` transcript, not from the spec. */

describe('sanitizeAcpAgent', () => {
  const ok = { label: 'Claude via adapter', command: 'claude-code-acp', provider: 'claude' as const }

  it('accepts a bare command with args', () => {
    expect(sanitizeAcpAgent({ ...ok, args: ['--stdio'] }, 'a1')).toEqual({
      id: 'a1',
      label: 'Claude via adapter',
      command: 'claude-code-acp',
      provider: 'claude',
      args: ['--stdio']
    })
  })

  it('accepts an absolute path, including one with spaces', () => {
    const agent = sanitizeAcpAgent({ ...ok, command: '/Applications/My Agent/bin/agent' }, 'a1')
    expect(agent?.command).toBe('/Applications/My Agent/bin/agent')
  })

  it('refuses a relative command, which would resolve inside the repo being worked on', () => {
    for (const command of ['./agent', '../bin/agent', 'tools/agent']) {
      expect(sanitizeAcpAgent({ ...ok, command }, 'a1')).toBeNull()
    }
  })

  it('refuses a flag-shaped command', () => {
    expect(sanitizeAcpAgent({ ...ok, command: '--acp' }, 'a1')).toBeNull()
  })

  it('keeps flag-shaped args — that is what --acp is', () => {
    expect(sanitizeAcpAgent({ ...ok, args: ['--acp', '--yolo'] }, 'a1')?.args).toEqual(['--acp', '--yolo'])
  })

  it('refuses every env name that could redirect what actually runs', () => {
    for (const name of BLOCKED_AGENT_ENV) {
      expect(sanitizeAcpAgent({ ...ok, env: { [name]: 'x' } }, 'a1')).toBeNull()
    }
  })

  it('refuses whole families and other spellings, not just the names listed', () => {
    for (const name of ['GIT_CONFIG_COUNT', 'npm_config_registry', 'DYLD_FALLBACK_LIBRARY_PATH', 'NODE_EXTRA_CA_CERTS', 'ZDOTDIR', 'path']) {
      expect(sanitizeAcpAgent({ ...ok, env: { [name]: 'x' } }, 'a1'), name).toBeNull()
      expect(isBlockedAgentEnv(name), name).toBe(true)
    }
  })

  it('keeps a mode switch inside a blocked family', () => {
    expect(sanitizeAcpAgent({ ...ok, env: { NODE_ENV: 'production' } }, 'a1')?.env).toEqual({ NODE_ENV: 'production' })
  })

  it('keeps ordinary env', () => {
    expect(sanitizeAcpAgent({ ...ok, env: { ANTHROPIC_MODEL: 'x' } }, 'a1')?.env).toEqual({ ANTHROPIC_MODEL: 'x' })
  })

  it('refuses malformed env names and values that could split lines', () => {
    expect(sanitizeAcpAgent({ ...ok, env: { 'not a name': 'x' } }, 'a1')).toBeNull()
    expect(sanitizeAcpAgent({ ...ok, env: { A: 'x\ny' } }, 'a1')).toBeNull()
    expect(sanitizeAcpAgent({ ...ok, env: { A: 1 } }, 'a1')).toBeNull()
  })

  it('refuses args that are not strings, carry a newline, or run long', () => {
    expect(sanitizeAcpAgent({ ...ok, args: [1] }, 'a1')).toBeNull()
    expect(sanitizeAcpAgent({ ...ok, args: ['a\nb'] }, 'a1')).toBeNull()
    expect(sanitizeAcpAgent({ ...ok, args: ['x'.repeat(513)] }, 'a1')).toBeNull()
    expect(sanitizeAcpAgent({ ...ok, args: new Array(33).fill('-x') }, 'a1')).toBeNull()
  })

  it('refuses an unusable id or a missing label', () => {
    expect(sanitizeAcpAgent(ok, 'not a valid id')).toBeNull()
    expect(sanitizeAcpAgent({ ...ok, label: '   ' }, 'a1')).toBeNull()
  })

  it('refuses anything that is not an object', () => {
    expect(sanitizeAcpAgent(null, 'a1')).toBeNull()
    expect(sanitizeAcpAgent('copilot --acp', 'a1')).toBeNull()
  })

  it('requires a known provider — an agent Cockpit could not index is refused', () => {
    expect(sanitizeAcpAgent({ ...ok, provider: undefined }, 'a1')).toBeNull()
    expect(sanitizeAcpAgent({ ...ok, provider: 'aider' }, 'a1')).toBeNull()
  })
})

describe('isValidAcpCommand', () => {
  it('rejects newlines and over-long paths', () => {
    expect(isValidAcpCommand('a\nb')).toBe(false)
    expect(isValidAcpCommand('/' + 'x'.repeat(1024))).toBe(false)
  })
})

describe('acpAgentRefusal', () => {
  it('asks which CLI an agent drives', () => {
    expect(acpAgentRefusal({ label: 'x', command: 'agent', provider: 'aider' as never })).toMatch(/which agent/)
  })

  it('explains a relative command specifically', () => {
    expect(acpAgentRefusal({ label: 'x', command: './agent', provider: 'claude' })).toMatch(/absolute path/)
  })
  it('names the offending env var', () => {
    expect(
      acpAgentRefusal({ label: 'x', command: 'agent', provider: 'claude', env: { NODE_OPTIONS: '--require /tmp/e.js' } })
    ).toMatch(/NODE_OPTIONS/)
  })
  it('passes a definition sanitize would accept', () => {
    expect(acpAgentRefusal({ label: 'x', command: 'agent', provider: 'copilot', args: ['--acp'] })).toBeNull()
  })
})

describe('built-ins', () => {
  it('maps copilot to its native ACP mode', () => {
    const copilot = builtinAgentFor('copilot')
    expect(copilot).toMatchObject({ command: 'copilot', args: ['--acp'] })
  })

  it('ships the ACP mode of each agent Cockpit otherwise only reads that has one', () => {
    // the command each project documents for editors: a flag, or a subcommand
    expect(builtinAgentFor('gemini')).toMatchObject({ command: 'gemini', args: ['--acp'] })
    expect(builtinAgentFor('opencode')).toMatchObject({ command: 'opencode', args: ['acp'] })
    expect(builtinAgentFor('cursor')).toMatchObject({ command: 'cursor-agent', args: ['acp'] })
    expect(builtinAgentFor('cline')).toMatchObject({ command: 'cline', args: ['--acp'] })
    // and none where the agent has no ACP mode to run
    expect(builtinAgentFor('roo')).toBeUndefined()
    expect(new Set(BUILTIN_ACP_AGENTS.map((a) => a.id)).size).toBe(BUILTIN_ACP_AGENTS.length)
  })

  it('lets a definition drive any agent Cockpit knows, and none it does not', () => {
    expect(sanitizeAcpAgent({ label: 'x', command: 'agent', provider: 'antigravity' }, 'a')).toMatchObject({
      provider: 'antigravity'
    })
    expect(sanitizeAcpAgent({ label: 'x', command: 'agent', provider: 'other' }, 'a')).toBeNull()
    expect(acpAgentRefusal({ label: 'x', command: 'agent', provider: 'roo' })).toBeNull()
  })

  it('only ships agents that belong to an indexed provider', () => {
    // a built-in without a provider would be a session Cockpit drives and never sees
    for (const a of BUILTIN_ACP_AGENTS) expect(a.provider).toBeTruthy()
  })

  it('survives sanitize — a built-in must obey the same rules as a user definition', () => {
    for (const a of BUILTIN_ACP_AGENTS) expect(sanitizeAcpAgent(a, a.id)).not.toBeNull()
  })
})

describe('acpCanReopen', () => {
  it('reopens only the Cursor conversations its ACP server keeps', () => {
    expect(acpCanReopen({ provider: 'cursor', sourcePath: '/Users/me/.cursor/acp-sessions/abc/store.db' })).toBe(true)
    // the editor's chats, and the agent transcripts, are kept elsewhere
    expect(
      acpCanReopen({
        provider: 'cursor',
        sourcePath: '/Users/me/Library/Application Support/Cursor/User/globalStorage/state.vscdb#abc'
      })
    ).toBe(false)
    expect(
      acpCanReopen({ provider: 'cursor', sourcePath: '/Users/me/.cursor/projects/p/agent-transcripts/abc/abc.jsonl' })
    ).toBe(false)
  })

  it('reopens the Cline CLI’s tasks, and not the extension’s in an editor', () => {
    expect(acpCanReopen({ provider: 'cline', sourcePath: '/Users/me/.cline/data/tasks/1/ui_messages.json' })).toBe(true)
    expect(
      acpCanReopen({
        provider: 'cline',
        sourcePath: '/Users/me/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/tasks/1/ui_messages.json'
      })
    ).toBe(false)
  })

  it('reopens every other agent’s sessions, and one just started here', () => {
    expect(acpCanReopen({ provider: 'gemini', sourcePath: '/Users/me/.gemini/tmp/h/chats/session-1.json' })).toBe(true)
    expect(acpCanReopen({ provider: 'cursor' })).toBe(true)
    expect(acpCanReopen({ provider: 'cline', sourcePath: '' })).toBe(true)
  })

  it('says why, naming the agent', () => {
    expect(acpStoreRefusal('cursor')).toBe(
      "Cursor's ACP server keeps its own conversations, and this one isn't among them, so it can't be continued from Cockpit."
    )
  })
})

describe('initializeParams', () => {
  it('claims no fs or terminal capability, so agents use their own tools', () => {
    const p = initializeParams() as { clientCapabilities: { fs: Record<string, boolean>; terminal: boolean } }
    expect(p.clientCapabilities.fs).toEqual({ readTextFile: false, writeTextFile: false })
    expect(p.clientCapabilities.terminal).toBe(false)
  })
})

describe('acpUpdateToEvents', () => {
  const seen = (): Set<string> => new Set<string>()

  it('turns a message chunk into text', () => {
    expect(acpUpdateToEvents('t1', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }, seen())).toEqual([
      { turnId: 't1', type: 'text', text: 'hi' }
    ])
  })

  it('ignores an empty or non-text chunk rather than emitting a blank line', () => {
    expect(acpUpdateToEvents('t1', { sessionUpdate: 'agent_message_chunk', content: { type: 'image', data: 'x' } }, seen())).toEqual([])
  })

  it('headlines a shell tool call with the command, not the JSON', () => {
    const [ev] = acpUpdateToEvents(
      't1',
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'c1',
        title: 'Display the current directory contents',
        kind: 'execute',
        rawInput: { command: "pwd && ls -la" }
      },
      seen()
    ) as [Extract<ChatEvent, { type: 'tool' }>]
    expect(ev.toolName).toBe('shell')
    expect(ev.preview).toBe('pwd && ls -la')
  })

  it('falls back to the agent’s own title for non-shell tools', () => {
    const [ev] = acpUpdateToEvents(
      't1',
      { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Edit src/index.ts', kind: 'edit' },
      seen()
    ) as [Extract<ChatEvent, { type: 'tool' }>]
    expect(ev).toMatchObject({ toolName: 'edit', preview: 'Edit src/index.ts' })
  })

  it('announces a call once, however many updates follow', () => {
    const s = seen()
    const call = { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'Run tests', kind: 'execute' }
    expect(acpUpdateToEvents('t1', call, s)).toHaveLength(1)
    expect(acpUpdateToEvents('t1', { sessionUpdate: 'tool_call_update', toolCallId: 'c1', content: [] }, s)).toEqual([])
    expect(acpUpdateToEvents('t1', { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' }, s)).toEqual([])
  })

  it('lets an update introduce a call the agent never announced', () => {
    const s = seen()
    const [ev] = acpUpdateToEvents(
      't1',
      { sessionUpdate: 'tool_call_update', toolCallId: 'c9', title: 'Search the repo', kind: 'search' },
      s
    ) as [Extract<ChatEvent, { type: 'tool' }>]
    expect(ev.toolName).toBe('search')
    expect(s.has('c9')).toBe(true)
  })

  it('drops an untitled update for a call it never saw — there is nothing to label', () => {
    expect(
      acpUpdateToEvents('t1', { sessionUpdate: 'tool_call_update', toolCallId: 'c9', content: [] }, seen())
    ).toEqual([])
  })

  it('turns a plan update into a row carrying the whole list', () => {
    const [ev] = acpUpdateToEvents(
      't1',
      {
        sessionUpdate: 'plan',
        entries: [
          { content: 'Read the parser', status: 'completed', priority: 'high' },
          { content: 'Fix it', status: 'in_progress', priority: 'high' }
        ]
      },
      seen()
    ) as [Extract<ChatEvent, { type: 'tool' }>]
    expect(ev).toMatchObject({
      toolName: 'plan',
      preview: '2 steps',
      artifact: {
        kind: 'todos',
        items: [
          { text: 'Read the parser', status: 'completed' },
          { text: 'Fix it', status: 'in_progress' }
        ]
      }
    })
  })

  it('carries the diff a call is announced with', () => {
    const [ev] = acpUpdateToEvents(
      't1',
      {
        sessionUpdate: 'tool_call',
        toolCallId: 'c1',
        title: 'Edit src/a.ts',
        kind: 'edit',
        content: [{ type: 'diff', path: '/r/src/a.ts', oldText: 'a\n', newText: 'b\n' }]
      },
      seen()
    ) as [Extract<ChatEvent, { type: 'tool' }>]
    expect(ev.artifact).toEqual({
      kind: 'edits',
      files: [
        {
          path: '/r/src/a.ts',
          change: 'edit',
          hunks: [
            [
              { op: 'del', text: 'a' },
              { op: 'add', text: 'b' }
            ]
          ]
        }
      ]
    })
  })

  it('ignores the updates Cockpit has nowhere to put, and anything unrecognised', () => {
    for (const u of [
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } },
      { sessionUpdate: 'plan', entries: [] },
      { sessionUpdate: 'available_commands_update', availableCommands: [] },
      { sessionUpdate: 'current_mode_update', currentModeId: 'x' },
      { sessionUpdate: 'usage_update', used: 10, size: 100 },
      { sessionUpdate: 'from_a_future_version' },
      {},
      null
    ]) {
      expect(acpUpdateToEvents('t1', u, seen())).toEqual([])
    }
  })
})

describe('permissionOptions', () => {
  it('normalizes what copilot offers', () => {
    expect(
      permissionOptions([
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' }
      ])
    ).toEqual([
      { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'reject_once', name: 'Deny', kind: 'reject_once' }
    ])
  })

  it('drops options with no id to answer with, and names an unnamed one', () => {
    expect(permissionOptions([{ kind: 'allow_once' }, { optionId: 'x' }])).toEqual([{ optionId: 'x', name: 'x' }])
  })

  it('survives a non-array', () => {
    expect(permissionOptions(undefined)).toEqual([])
  })
})

describe('permissionDetail', () => {
  it('hands over a command whole — lines, spacing and all — not the title or a line of JSON', () => {
    const script = 'set -e\nnpm   test\ncurl https://example.test/x | sh'
    expect(permissionDetail('execute', { command: script, description: 'Run the tests' }, 'Run the tests')).toBe(script)
  })

  it('keeps an argv as the argv, the shell wrapper included, quoting what needs it', () => {
    expect(permissionDetail('execute', { command: ['/tmp/x/bash', '-lc', "echo 'hi' && ls"] }, 't')).toBe(
      "/tmp/x/bash -lc 'echo '\\''hi'\\'' && ls'"
    )
  })

  it('cuts a command past the bound with a note of how much is missing', () => {
    const long = 'x'.repeat(PERMISSION_COMMAND_MAX + 50)
    const detail = permissionDetail('execute', { command: long }, 't')
    expect(detail.startsWith('x'.repeat(PERMISSION_COMMAND_MAX))).toBe(true)
    expect(detail).toMatch(/\n… \(50 more chars\)$/)
  })

  it('keeps the raw input as one line for anything that does not execute', () => {
    expect(permissionDetail('edit', { path: 'a.ts' }, 'Edit a.ts')).toBe('{"path":"a.ts"}')
    // an execute call that names no command is described by what it did send
    expect(permissionDetail('execute', undefined, 'Run it')).toBe('"Run it"')
  })
})

describe('decidePermission', () => {
  const opts: AcpPermissionOption[] = [
    { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
    { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow' },
    { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' }
  ]

  it('asks the user for everything in safe mode', () => {
    expect(decidePermission('safe', opts, 'edit')).toBeNull()
    expect(decidePermission('safe', opts, 'execute')).toBeNull()
  })

  it('answers file work itself in auto-edit, but still asks before executing', () => {
    expect(decidePermission('auto-edit', opts, 'edit')).toBe('allow_once')
    expect(decidePermission('auto-edit', opts, 'read')).toBe('allow_once')
    expect(decidePermission('auto-edit', opts, 'execute')).toBeNull()
    expect(decidePermission('auto-edit', opts, undefined)).toBeNull()
  })

  it('never grants a standing allowance in auto-edit — the mode belongs to the turn', () => {
    expect(decidePermission('auto-edit', opts, 'edit')).not.toBe('allow_always')
  })

  it('answers everything in yolo, once per call', () => {
    expect(decidePermission('yolo', opts, 'execute')).toBe('allow_once')
    expect(decidePermission('yolo', opts, 'edit')).toBe('allow_once')
  })

  it('never grants a standing allowance by itself — an agent offering only that asks the person', () => {
    const standing: AcpPermissionOption[] = [
      { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow' },
      { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' }
    ]
    expect(decidePermission('yolo', standing, 'execute')).toBeNull()
    expect(decidePermission('auto-edit', standing, 'edit')).toBeNull()
  })

  it('asks when the agent offered nothing that allows', () => {
    const denyOnly: AcpPermissionOption[] = [{ optionId: 'reject_once', kind: 'reject_once', name: 'Deny' }]
    expect(decidePermission('yolo', denyOnly, 'execute')).toBeNull()
    expect(decidePermission('yolo', [], 'execute')).toBeNull()
  })
})

describe('unattendedOutcome', () => {
  it('refuses the one call', () => {
    expect(
      unattendedOutcome([
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow' },
        { optionId: 'reject_always', kind: 'reject_always', name: 'Never' },
        { optionId: 'no', kind: 'reject_once', name: 'Deny' }
      ])
    ).toEqual({ outcome: 'selected', optionId: 'no' })
  })

  it('never leaves a standing refusal in the agent, and never allows', () => {
    const standing: AcpPermissionOption[] = [
      { optionId: 'allow_once', kind: 'allow_once', name: 'Allow' },
      { optionId: 'reject_always', kind: 'reject_always', name: 'Never' }
    ]
    expect(unattendedOutcome(standing)).toEqual({ outcome: 'cancelled' })
    expect(unattendedOutcome([])).toEqual({ outcome: 'cancelled' })
  })
})

describe('promptResultEvents', () => {
  it('ends a completed turn with just done', () => {
    expect(promptResultEvents('t1', { stopReason: 'end_turn' })).toEqual([{ turnId: 't1', type: 'done' }])
  })

  it('reports a turn that stopped early, so it is not mistaken for an empty answer', () => {
    const [err, done] = promptResultEvents('t1', { stopReason: 'max_tokens' })
    expect(err).toMatchObject({ type: 'error' })
    expect((err as { message: string }).message).toMatch(/max tokens/)
    expect(done).toMatchObject({ type: 'done' })
  })

  it('reports a refusal', () => {
    expect(promptResultEvents('t1', { stopReason: 'refusal' })[0]).toMatchObject({ type: 'error' })
  })

  it('still ends the turn when the result is missing or odd', () => {
    expect(promptResultEvents('t1', undefined)).toEqual([{ turnId: 't1', type: 'done' }])
  })
})

describe('modeIdFor', () => {
  const modes = [
    { id: 'https://agentclientprotocol.com/protocol/session-modes#agent' },
    { id: 'https://agentclientprotocol.com/protocol/session-modes#autopilot' }
  ]

  it('asks for autopilot only in yolo', () => {
    expect(modeIdFor('yolo', modes)).toBe('https://agentclientprotocol.com/protocol/session-modes#autopilot')
    expect(modeIdFor('safe', modes)).toBeNull()
    expect(modeIdFor('auto-edit', modes)).toBeNull()
  })

  it('leaves the agent’s default when it has no such mode', () => {
    expect(modeIdFor('yolo', [{ id: 'x#agent' }])).toBeNull()
    expect(modeIdFor('yolo', [])).toBeNull()
  })
})

describe('an agent update nested too deep to serialise', () => {
  it('becomes a row with a placeholder instead of throwing the turn away', () => {
    let deep: unknown = 'x'
    for (let i = 0; i < 100_000; i++) deep = [deep]
    const events = acpUpdateToEvents('t1', { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'ls', rawInput: deep }, new Set())
    expect(events[0]).toMatchObject({ type: 'tool' })
    expect((events[0] as Extract<ChatEvent, { type: 'tool' }>).detail).toContain('nested too deeply')
  })
})

describe('BuiltinReadiness', () => {
  const agents: AcpAgent[] = [
    { id: 'b-gemini', label: 'Gemini', command: 'gemini', args: ['--acp'], provider: 'gemini', builtin: true },
    { id: 'b-cline', label: 'Cline', command: 'cline', args: ['--acp'], provider: 'cline', builtin: true }
  ]

  /** A probe per agent id the test settles by hand, and a clock it moves. */
  function harness(): {
    readonly readiness: BuiltinReadiness
    readonly asked: string[]
    readonly answer: (id: string, ok: boolean) => Promise<void>
    readonly changes: () => number
    readonly tick: (ms: number) => void
  } {
    const pending = new Map<string, (probe: AcpAgentProbe) => void>()
    const asked: string[] = []
    let changes = 0
    let now = 1_000_000
    const readiness = new BuiltinReadiness(
      {
        probe: (agent) =>
          new Promise((resolve) => {
            asked.push(agent.id)
            pending.set(agent.id, resolve)
          }),
        onChange: () => changes++,
        now: () => now
      },
      agents
    )
    return {
      readiness,
      asked,
      answer: async (id, ok) => {
        pending.get(id)?.(ok ? { ok: true } : { ok: false, error: 'not found' })
        pending.delete(id)
        // the settle, and the bookkeeping after it, run a few microtasks later
        for (let i = 0; i < 5; i++) await Promise.resolve()
      },
      changes: () => changes,
      tick: (ms) => {
        now += ms
      }
    }
  }

  it('probes every built-in at launch, and uses the ones that answer', async () => {
    const h = harness()
    h.readiness.probe('missing')
    expect(h.asked).toEqual(['b-gemini', 'b-cline'])
    await h.answer('b-gemini', true)
    await h.answer('b-cline', false)
    expect(h.readiness.ready()).toEqual(['b-gemini'])
    expect(h.readiness.isReady('b-cline')).toBe(false)
    expect(h.changes()).toBe(1)
  })

  it('asks again for the missing ones at most once a minute, and never twice at once', async () => {
    const h = harness()
    h.readiness.probe('missing')
    await h.answer('b-gemini', true)
    h.tick(REPROBE_EVERY_MS)
    // cline's first probe is still out: it is not started again
    h.readiness.probe('missing')
    expect(h.asked).toEqual(['b-gemini', 'b-cline'])
    await h.answer('b-cline', false)
    h.readiness.probe('missing')
    expect(h.asked).toEqual(['b-gemini', 'b-cline'])
    h.tick(REPROBE_EVERY_MS)
    h.readiness.probe('missing')
    // the one that answered is not asked again; the missing one is
    expect(h.asked).toEqual(['b-gemini', 'b-cline', 'b-cline'])
  })

  // a CLI removed, or broken by an update, used to stay "answered" until a restart
  it('rechecks every built-in on request, and stops using one that no longer answers', async () => {
    const h = harness()
    h.readiness.probe('missing')
    await h.answer('b-gemini', true)
    await h.answer('b-cline', true)
    expect(h.readiness.ready()).toEqual(['b-gemini', 'b-cline'])
    h.readiness.probe('all')
    expect(h.asked).toEqual(['b-gemini', 'b-cline', 'b-gemini', 'b-cline'])
    await h.answer('b-gemini', false)
    await h.answer('b-cline', true)
    expect(h.readiness.ready()).toEqual(['b-cline'])
    expect(h.changes()).toBe(3)
  })
})
