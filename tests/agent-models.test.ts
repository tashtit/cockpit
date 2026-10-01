import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  codexCatalog,
  codexConfiguredModel,
  copilotAccountModels,
  CopilotFrames,
  copilotFrame,
  copilotModelsInLog,
  copilotSelection,
  MAX_COPILOT_FRAME
} from '../src/main/agent-models-core'
import { listAgentModels } from '../src/main/agent-models'
import { BUILTIN_MODELS, mergeModels } from '../src/shared/agent-models'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
function home(): string {
  const d = mkdtempSync(join(tmpdir(), 'cockpit-models-'))
  dirs.push(d)
  return d
}

/**
 * A `copilot` first on PATH, so no test reaches the real one: its server mode answers
 * from `stub-server.json` in the COPILOT_HOME it runs under, speaking the framed
 * JSON-RPC the real server does, and logs every request to `stub-calls.log`. A home
 * without that file is a CLI from before the server — it prints and exits. The world
 * can make it misbehave: `chatty` sends a notification and a reply nobody asked for
 * before each answer, `garbage` writes something that is not the protocol, and
 * `ignoreEof` keeps it running after its stdin closes (its pid is in `stub-pid`).
 */
const STUB = `
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
const home = process.env.COPILOT_HOME
let world = null
try { world = JSON.parse(readFileSync(join(home, 'stub-server.json'), 'utf8')) } catch {}
appendFileSync(join(home, 'stub-argv.log'), JSON.stringify([process.cwd(), ...process.argv.slice(2)]) + '\\n')
if (!world || process.argv[2] !== '--headless') { console.log('ok'); process.exit(0) }
appendFileSync(join(home, 'stub-pid'), String(process.pid))
if (world.ignoreEof) setInterval(() => {}, 1000)
if (world.garbage) process.stdout.write('Content-Type: text/plain\\r\\n\\r\\nhello')
const send = (msg) => {
  const body = JSON.stringify(msg)
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body)
}
let buf = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk])
  for (;;) {
    const end = buf.indexOf('\\r\\n\\r\\n')
    if (end < 0) return
    const len = Number(/Content-Length: (\\d+)/.exec(buf.subarray(0, end).toString())[1])
    if (buf.length < end + 4 + len) return
    const req = JSON.parse(buf.subarray(end + 4, end + 4 + len).toString())
    buf = buf.subarray(end + 4 + len)
    appendFileSync(join(home, 'stub-calls.log'), req.method + ' ' + JSON.stringify(req.params) + '\\n')
    const answer =
      req.method === 'connect' ? { ok: true, protocolVersion: 3 }
      : req.method === 'account.getAllUsers' ? world.users
      : req.method === 'models.list' ? world.models[req.params?.selectionId ?? 'current']
      : undefined
    if (world.chatty) {
      send({ jsonrpc: '2.0', method: 'session.lifecycle', params: {} })
      send({ jsonrpc: '2.0', id: 999, result: { models: [{ id: 'not-asked-for' }] } })
    }
    if (answer === undefined || answer.error)
      send({ jsonrpc: '2.0', id: req.id, error: answer?.error ?? { code: -32601, message: 'unknown method' } })
    else send({ jsonrpc: '2.0', id: req.id, result: answer })
  }
})
process.stdin.on('end', () => world.ignoreEof || process.exit(0))
`
const savedPath = process.env.PATH
const savedUserData = process.env.COCKPIT_USER_DATA
/** Cockpit's data folder for this file — the server starts in its `acp-probe` */
let userData = ''
beforeAll(() => {
  userData = home()
  process.env.COCKPIT_USER_DATA = userData
  const bin = home()
  writeFileSync(join(bin, 'stub-copilot.mjs'), STUB)
  writeFileSync(join(bin, 'copilot'), `#!/bin/sh\nexec "${process.execPath}" "${join(bin, 'stub-copilot.mjs')}" "$@"\n`)
  chmodSync(join(bin, 'copilot'), 0o755)
  process.env.PATH = `${bin}:${savedPath ?? ''}`
})
afterAll(() => {
  process.env.PATH = savedPath
  if (savedUserData === undefined) delete process.env.COCKPIT_USER_DATA
  else process.env.COCKPIT_USER_DATA = savedUserData
})

/** A Copilot home whose server answers as `world` says. */
type StubWorld = {
  readonly users?: unknown
  readonly models?: Record<string, unknown>
  readonly chatty?: boolean
  readonly garbage?: boolean
  readonly ignoreEof?: boolean
}

function copilotHome(world: StubWorld): string {
  const h = home()
  writeFileSync(join(h, 'stub-server.json'), JSON.stringify(world))
  return h
}

const CODEX_CACHE = JSON.stringify({
  fetched_at: '2026-09-21T00:00:00Z',
  models: [
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 5 },
    { slug: 'gpt-reserve', display_name: 'GPT Reserve', visibility: 'hide', priority: 2 },
    {
      slug: 'gpt-6-astra',
      display_name: 'GPT-6-Astra',
      description: 'Most capable',
      visibility: 'list',
      priority: 1,
      default_reasoning_level: 'low',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }, { effort: 'Bad Level' }],
      service_tiers: [{ id: 'priority', name: 'Fast' }]
    },
    { slug: '--flag', visibility: 'list' },
    { display_name: 'no slug' }
  ]
})

describe('codexCatalog', () => {
  it('lists what Codex’s own picker lists, in its priority order', () => {
    expect(codexCatalog(CODEX_CACHE)).toEqual([
      {
        id: 'gpt-6-astra',
        label: 'GPT-6-Astra',
        description: 'Most capable',
        efforts: ['low', 'ultra'],
        defaultEffort: 'low',
        fast: true
      },
      { id: 'gpt-5.5', label: 'GPT-5.5' }
    ])
  })

  it('an unreadable cache is an empty list, never a throw', () => {
    expect(codexCatalog('not json')).toEqual([])
    expect(codexCatalog('{"models": 7}')).toEqual([])
  })

  it('reads the configured default model', () => {
    expect(codexConfiguredModel('approval = "never"\nmodel = "gpt-5.5"\n')).toBe('gpt-5.5')
    expect(codexConfiguredModel('[profiles.x]\n')).toBeNull()
  })
})

describe('copilotModelsInLog', () => {
  it('keeps the models the CLI served, skipping custom-provider ids and hashes', () => {
    const log = [
      '{"type":"session.start","data":{"selectedModel":"gpt-5.6-sol"}}',
      '{"type":"assistant.usage","data":{"model":"claude-opus-5"}}',
      '{"type":"session.model_change","data":{"newModel":"977b9f59-161a-40cb-b311-c0b52714ef95/claude-opus-5"}}',
      '{"data":{"model":"b6ea42e4bd2e47862f414a7cee21313ac3435212d79334a6716b7591b90bdc9d"}}',
      '{"data":{"model":"claude-opus-5"}}'
    ].join('\n')
    // claude-opus-5 also ran behind a provider in this log, so its bare name is that
    // provider's too — only the default backend's models are kept
    expect(copilotModelsInLog(log)).toEqual(['gpt-5.6-sol'])
  })

  it('a custom provider’s bare turn records never reach the picker', () => {
    const log = [
      '{"type":"session.start","data":{"selectedModel":"ea92903f-20cf-44d0-9c37-af9c9def253a/qwen3.5:4b"}}',
      '{"type":"assistant.message","data":{"model":"qwen3.5:4b"}}',
      '{"type":"session.shutdown","data":{"currentModel":"qwen3.5:4b"}}'
    ].join('\n')
    expect(copilotModelsInLog(log)).toEqual([])
    expect(copilotModelsInLog('{"data":{"model":"claude-opus-5"}}')).toEqual(['claude-opus-5'])
  })
})

/** What Copilot's `models.list` answered for a work login in its 1.0.89 server. */
const WORK_MODELS = {
  models: [
    { id: 'auto', name: 'Auto', capabilities: {} },
    {
      id: 'claude-opus-5.5',
      name: 'Claude Opus 5.5',
      policy: { state: 'enabled', terms: 'Enable access…' },
      modelPickerCategory: 'powerful',
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningEffort: 'high'
    },
    { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra', policy: { state: 'disabled' }, modelPickerCategory: 'versatile' },
    {
      id: 'grok-4.5',
      name: 'Grok 4.5',
      modelPickerCategory: 'versatile',
      supportedReasoningEfforts: ['low', 'Bad Level', 7],
      defaultReasoningEffort: 'medium'
    },
    { id: 'claude-haiku-4.5', name: 'Claude Haiku 4.5', policy: { state: 'unconfigured' }, modelPickerCategory: 'lightweight' },
    { id: '--model', name: 'flag' },
    { name: 'no id' },
    'gpt-4o'
  ]
}

describe('copilotAccountModels', () => {
  it('lists what the account may pick in Copilot’s order, each with its own thinking levels', () => {
    expect(copilotAccountModels(WORK_MODELS)).toEqual([
      { id: 'auto', label: 'Auto' },
      {
        id: 'claude-opus-5.5',
        label: 'Claude Opus 5.5',
        description: 'powerful',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultEffort: 'high'
      },
      // its default is not a level it takes, so it names none
      { id: 'grok-4.5', label: 'Grok 4.5', description: 'versatile', efforts: ['low'] },
      { id: 'claude-haiku-4.5', label: 'Claude Haiku 4.5', description: 'lightweight' }
    ])
  })

  it('an answer that is not a model list is null, so the logs answer instead', () => {
    expect(copilotAccountModels(null)).toBeNull()
    expect(copilotAccountModels({ models: 'many' })).toBeNull()
    expect(copilotAccountModels({ models: [] })).toEqual([])
  })
})

describe('copilotSelection', () => {
  const users = [
    { authInfo: { type: 'gh-cli', host: 'https://github.com', login: 'octo' }, selectionId: 'sel-gh', token: 'not read' },
    { authInfo: { type: 'user', host: 'https://github.com', login: 'octo' }, selectionId: 'sel-octo' },
    { authInfo: { type: 'user', host: 'https://github.com', login: 'octo_work' }, selectionId: 'sel-work' },
    { authInfo: { type: 'env', login: 'ci-bot' }, selectionId: 'sel-env' },
    { authInfo: { type: 'user', login: 'no-id' } },
    'junk'
  ]

  it('picks the login’s stored sign-in, else the same login signed in another way', () => {
    expect(copilotSelection(users, 'octo')).toBe('sel-octo')
    expect(copilotSelection(users, 'octo_work')).toBe('sel-work')
    expect(copilotSelection(users, 'ci-bot')).toBe('sel-env')
  })

  it('a login Copilot does not name has no selection', () => {
    expect(copilotSelection(users, 'stranger')).toBeNull()
    expect(copilotSelection(users, 'no-id')).toBeNull()
    expect(copilotSelection({ users }, 'octo')).toBeNull()
  })
})

describe('CopilotFrames', () => {
  it('reads messages back however the pipe splits them, multibyte text included', () => {
    const a = { jsonrpc: '2.0', id: 1, result: { name: 'Claude Opus 5.5 — “fast”' } }
    const b = { jsonrpc: '2.0', id: 2, result: { models: [] } }
    const bytes = Buffer.from(copilotFrame(a) + copilotFrame(b), 'utf8')
    for (const cut of [1, 7, 20, 31, bytes.length - 1]) {
      const frames = new CopilotFrames()
      expect([...frames.push(bytes.subarray(0, cut)), ...frames.push(bytes.subarray(cut))]).toEqual([a, b])
    }
  })

  it('skips a body that is not JSON and reads on', () => {
    const frames = new CopilotFrames()
    const bad = 'Content-Length: 5\r\n\r\nnope!'
    expect(frames.push(Buffer.from(bad + copilotFrame({ id: 3 })))).toEqual([{ id: 3 }])
  })

  it('a stream that is not the protocol fails rather than buffering without end', () => {
    expect(() => new CopilotFrames().push(Buffer.from('Content-Type: x\r\n\r\n{}'))).toThrow(/Content-Length/)
    expect(() => new CopilotFrames().push(Buffer.from(`Content-Length: ${MAX_COPILOT_FRAME + 1}\r\n\r\n`))).toThrow()
    expect(() => new CopilotFrames().push(Buffer.from('ok\n'.repeat(600)))).toThrow(/framed/)
  })
})

describe('listAgentModels', () => {
  it('claude: the documented aliases and names — it keeps no catalog', async () => {
    expect(await listAgentModels('claude', { configDir: home() })).toEqual(BUILTIN_MODELS.claude)
  })

  it('codex: its own cached catalog, plus the configured default', async () => {
    const h = home()
    writeFileSync(join(h, 'models_cache.json'), CODEX_CACHE)
    writeFileSync(join(h, 'config.toml'), 'model = "gpt-5.4-legacy"\n')
    expect((await listAgentModels('codex', { configDir: h })).map((m) => m.id)).toEqual([
      'gpt-6-astra',
      'gpt-5.5',
      'gpt-5.4-legacy'
    ])
  })

  it('copilot: the models Copilot says the chosen login may pick — each login its own', async () => {
    const h = copilotHome({
      users: [
        { authInfo: { type: 'user', login: 'octo' }, selectionId: 'sel-octo' },
        { authInfo: { type: 'user', login: 'octo_work' }, selectionId: 'sel-work' }
      ],
      models: {
        current: { models: [{ id: 'auto', name: 'Auto' }, { id: 'gpt-5-mini', name: 'GPT-5 mini' }] },
        'sel-octo': { models: [{ id: 'auto', name: 'Auto', capabilities: {} }] },
        'sel-work': WORK_MODELS
      }
    })
    // a log of a model the work login ran never widens what Copilot says it may pick
    mkdirSync(join(h, 'session-state', 'old'), { recursive: true })
    writeFileSync(join(h, 'session-state', 'old', 'events.jsonl'), '{"data":{"model":"gpt-4.1"}}\n')

    const work = await listAgentModels('copilot', { configDir: h, copilotUser: 'octo_work' })
    expect(work.map((m) => m.id)).toEqual(['auto', 'claude-opus-5.5', 'grok-4.5', 'claude-haiku-4.5'])
    // the built-in `auto` keeps its description; the account's models keep their levels
    expect(work[0]).toEqual(BUILTIN_MODELS.copilot[0])
    expect(work[1]).toMatchObject({ label: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] })

    expect((await listAgentModels('copilot', { configDir: h, copilotUser: 'octo' })).map((m) => m.id)).toEqual(['auto'])
    // no login named: whoever Copilot runs as now
    expect((await listAgentModels('copilot', { configDir: h })).map((m) => m.id)).toEqual(['auto', 'gpt-5-mini'])

    // the server mode, never a turn, started in Cockpit's own empty folder — never home,
    // whose tree an agent may read; selected per login, never by switching who Copilot runs as
    const argv = readFileSync(join(h, 'stub-argv.log'), 'utf8').trim().split('\n')
    const probeDir = realpathSync(join(userData, 'acp-probe'))
    expect(new Set(argv)).toEqual(new Set([JSON.stringify([probeDir, '--headless', '--stdio', '--no-auto-update'])]))
    const calls = readFileSync(join(h, 'stub-calls.log'), 'utf8')
    expect(calls).toContain('models.list {"selectionId":"sel-work"}')
    expect(calls).toContain('models.list {"selectionId":"sel-octo"}')
    expect(calls).not.toMatch(/account\.(login|logout)|session\./)
    expect(existsSync(join(h, 'config.json'))).toBe(false)
  })

  it('copilot: when its server can’t say — a login it doesn’t know, no network — the logs answer', async () => {
    const h = copilotHome({
      users: [{ authInfo: { type: 'user', login: 'octo' }, selectionId: 'sel-octo' }],
      models: { 'sel-octo': { error: { code: -32603, message: 'error sending request for url' } } }
    })
    mkdirSync(join(h, 'session-state', 'a'), { recursive: true })
    writeFileSync(join(h, 'session-state', 'a', 'events.jsonl'), '{"data":{"model":"gpt-5.6-sol"}}\n')
    expect((await listAgentModels('copilot', { configDir: h, copilotUser: 'octo' })).map((m) => m.id)).toEqual([
      'auto',
      'gpt-5.6-sol'
    ])
    expect((await listAgentModels('copilot', { configDir: h, copilotUser: 'stranger' })).map((m) => m.id)).toEqual([
      'auto',
      'gpt-5.6-sol'
    ])
  })

  it('copilot: notifications and replies nobody asked for are passed over', async () => {
    const h = copilotHome({
      chatty: true,
      users: [{ authInfo: { type: 'user', login: 'octo' }, selectionId: 'sel-octo' }],
      models: { 'sel-octo': { models: [{ id: 'gpt-5-mini', name: 'GPT-5 mini' }] } }
    })
    expect((await listAgentModels('copilot', { configDir: h, copilotUser: 'octo' })).map((m) => m.id)).toEqual([
      'auto',
      'gpt-5-mini'
    ])
  })

  it('copilot: a server that talks past the protocol, or outstays its stdin, falls back and is stopped', async () => {
    const h = copilotHome({ garbage: true, ignoreEof: true, models: {} })
    mkdirSync(join(h, 'session-state', 'a'), { recursive: true })
    writeFileSync(join(h, 'session-state', 'a', 'events.jsonl'), '{"data":{"model":"gpt-5.6-sol"}}\n')
    expect((await listAgentModels('copilot', { configDir: h })).map((m) => m.id)).toEqual(['auto', 'gpt-5.6-sol'])
    // it ignored its stdin closing, so it gets SIGTERM — never left running
    const pid = Number(readFileSync(join(h, 'stub-pid'), 'utf8'))
    const alive = (): boolean => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    expect(alive()).toBe(true)
    await new Promise((r) => setTimeout(r, 3_000))
    expect(alive()).toBe(false)
  })

  it('copilot: with nowhere of its own to start in, it is never started in home — the logs answer', async () => {
    const h = copilotHome({ models: { current: { models: [{ id: 'gpt-5-mini' }] } } })
    mkdirSync(join(h, 'session-state', 'a'), { recursive: true })
    writeFileSync(join(h, 'session-state', 'a', 'events.jsonl'), '{"data":{"model":"gpt-5.6-sol"}}\n')
    const blocked = home()
    writeFileSync(join(blocked, 'acp-probe'), 'a file where the folder would be')
    process.env.COCKPIT_USER_DATA = blocked
    try {
      expect((await listAgentModels('copilot', { configDir: h })).map((m) => m.id)).toEqual(['auto', 'gpt-5.6-sol'])
    } finally {
      process.env.COCKPIT_USER_DATA = userData
    }
    expect(existsSync(join(h, 'stub-argv.log'))).toBe(false)
  })

  it('copilot without its server: auto, then every model its session logs show it serving', async () => {
    const h = home()
    const log = (id: string, text: string, mtime: number): void => {
      mkdirSync(join(h, 'session-state', id), { recursive: true })
      const p = join(h, 'session-state', id, 'events.jsonl')
      writeFileSync(p, text)
      utimesSync(p, mtime, mtime)
    }
    log('a', '{"data":{"model":"gpt-5.6-sol"}}\n', 1000)
    log('b', '{"data":{"currentModel":"claude-opus-5"}}\n', 2000)
    mkdirSync(join(h, 'session-state', 'no-log'))
    expect((await listAgentModels('copilot', { configDir: h })).map((m) => m.id)).toEqual([
      'auto',
      'claude-opus-5',
      'gpt-5.6-sol'
    ])
  })

  it('copilot: the newest sixty logs of however many sessions, one scan for a burst of pickers', async () => {
    const h = home()
    for (let i = 0; i < 150; i++) {
      const id = `s-${String(i).padStart(3, '0')}`
      mkdirSync(join(h, 'session-state', id), { recursive: true })
      const p = join(h, 'session-state', id, 'events.jsonl')
      const model = i === 0 ? 'too-old-1' : i === 149 ? 'newest-1' : i === 100 ? 'recent-1' : null
      writeFileSync(p, model ? `{"data":{"model":"${model}"}}\n` : '{}\n')
      utimesSync(p, 1000 + i, 1000 + i)
    }
    const first = listAgentModels('copilot', { configDir: h })
    expect(listAgentModels('copilot', { configDir: h })).toBe(first)
    expect((await first).map((m) => m.id)).toEqual(['auto', 'newest-1', 'recent-1'])
  })

  it('a home with nothing in it still offers the built-ins', async () => {
    expect(await listAgentModels('codex', { configDir: home() })).toEqual([])
    expect((await listAgentModels('copilot', { configDir: home() })).map((m) => m.id)).toEqual(['auto'])
  })
})

describe('mergeModels', () => {
  it('keeps each id once, the first description winning', () => {
    expect(
      mergeModels([{ id: 'a', label: 'A', description: 'first' }], [
        { id: 'a', label: 'a' },
        { id: 'b', label: 'b' }
      ])
    ).toEqual([
      { id: 'a', label: 'A', description: 'first' },
      { id: 'b', label: 'b' }
    ])
  })
})
