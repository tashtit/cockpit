import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  coverageFor,
  probeAgentHost,
  readEndpoints,
  readSessions
} from '../src/main/agent-host'
import {
  fileUriToPath,
  judgeCoverage,
  parseEndpointFile,
  payloadKeyPaths,
  sessionFromMetadata,
  type AgentHostSession
} from '../src/main/agent-host-core'

/**
 * VS Code's agent host keeps its sessions in its own store, which is why these fixtures
 * build one on disk and run the real reader over it — the same shape the parser tests
 * use. Both discovery formats seen in the wild are covered on purpose: the store has
 * already drifted once, and the point of the reader is that drift costs nothing.
 */

const root = mkdtempSync(join(tmpdir(), 'cockpit-agent-host-'))

function hasSqlite3(): boolean {
  try {
    execFileSync('sqlite3', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** A VS Code user-data dir with an agent host in it. */
function home(name: string): string {
  const dir = join(root, name)
  mkdirSync(join(dir, 'agent-host', 'local-endpoint', 'entries'), { recursive: true })
  mkdirSync(join(dir, 'agentSessionData'), { recursive: true })
  return dir
}

function writeSessionDb(dir: string, id: string, meta: Record<string, string>, turns: number): void {
  const sessionDir = join(dir, 'agentSessionData', id)
  mkdirSync(sessionDir, { recursive: true })
  const rows = Object.entries(meta)
    .map(([k, v]) => `('${k.replace(/'/g, "''")}','${v.replace(/'/g, "''")}')`)
    .join(',')
  const turnRows = Array.from({ length: turns }, (_, i) => `('t${i}')`).join(',')
  execFileSync('sqlite3', [
    join(sessionDir, 'session.db'),
    'CREATE TABLE session_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);' +
      'CREATE TABLE turns (id TEXT PRIMARY KEY NOT NULL, event_id TEXT, checkpoint_ref TEXT);' +
      (rows ? `INSERT INTO session_metadata VALUES ${rows};` : '') +
      (turnRows ? `INSERT INTO turns (id) VALUES ${turnRows};` : '')
  ])
}

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('agent host discovery', () => {
  let dir = ''

  beforeAll(() => {
    dir = home('discovery')
    const endpoints = join(dir, 'agent-host', 'local-endpoint')
    // the newer shape: one record per file, socket under endpoint.path
    writeFileSync(
      join(endpoints, 'entries', 'aa.json'),
      JSON.stringify({
        schemaVersion: 2,
        type: 'editor',
        pid: process.pid,
        instanceId: 'live-one',
        endpoint: { type: 'socket', path: '/tmp/vscode-ah/live-one.sock' },
        connectionToken: 'tok',
        protocolVersion: '0.8.0'
      })
    )
    // the same host as the legacy file also lists it, plus editors long gone
    writeFileSync(
      join(endpoints, 'metadata.json'),
      JSON.stringify([
        {
          type: 'editor',
          schemaVersion: 1,
          pid: process.pid,
          instanceId: 'live-one',
          endpointPath: '/tmp/vscode-ah/live-one.sock',
          connectionToken: 'tok',
          protocolVersion: '0.7.0'
        },
        {
          type: 'editor',
          schemaVersion: 1,
          pid: 2_147_483_600,
          instanceId: 'dead-one',
          endpointPath: '/tmp/vscode-ah/dead-one.sock',
          connectionToken: 'tok',
          protocolVersion: '0.7.0'
        }
      ])
    )
    writeFileSync(join(endpoints, 'entries', 'bb.json'), '{ this is not json')
    writeFileSync(join(endpoints, 'entries', 'cc.json'), JSON.stringify({ schemaVersion: 9 }))
  })

  it('reads both discovery shapes and keeps one entry per host', async () => {
    const found = await readEndpoints(dir)
    expect(found.map((e) => e.instanceId)).toEqual(['live-one'])
    // the record the host still maintains wins, so the socket and version are current
    expect(found[0].schemaVersion).toBe(2)
    expect(found[0].protocolVersion).toBe('0.8.0')
    expect(found[0].socketPath).toBe('/tmp/vscode-ah/live-one.sock')
  })

  it('drops records whose editor is gone rather than reporting a dead socket', async () => {
    const found = await readEndpoints(dir)
    expect(found.map((e) => e.instanceId)).not.toContain('dead-one')
  })

  it('skips a half-written or unrecognised record instead of failing the sweep', () => {
    expect(parseEndpointFile('{ this is not json')).toEqual([])
    expect(parseEndpointFile(JSON.stringify({ schemaVersion: 9 }))).toEqual([])
    expect(parseEndpointFile(JSON.stringify({ pid: 0, instanceId: 'x', endpointPath: '/s' }))).toEqual([])
  })

  it('reports nothing for a machine that has never run the agent host', async () => {
    const report = await probeAgentHost(join(root, 'no-vscode-here'))
    expect(report.present).toBe(false)
    expect(report.endpoints).toEqual([])
    expect(report.sessions).toEqual([])
  })
})

describe('agent host session metadata', () => {
  it('states the provider through its key prefix, not the session id', () => {
    const session = sessionFromMetadata(
      '45c4559d-3fa5-40f2-9fa1-f793ebdf26c8',
      [
        ['claude.model', '{"id":"claude-haiku-4.5"}'],
        ['claude.transport', 'proxy'],
        ['claude.customizationDirectory', 'file:///Users/me/dev%20worktrees'],
        ['agentHost.workspaceless', 'false'],
        ['customTitle', 'Claude Code assistance options']
      ],
      3
    )
    expect(session.agent).toBe('claude')
    expect(session.model).toBe('claude-haiku-4.5')
    expect(session.transport).toBe('proxy')
    expect(session.customizationDir).toBe('/Users/me/dev worktrees')
    expect(session.title).toBe('Claude Code assistance options')
    expect(session.workspaceless).toBe(false)
    expect(session.turns).toBe(3)
  })

  it('reads copilot under either of the names the host gives it', () => {
    expect(sessionFromMetadata('a', [['copilot.model', 'gpt-5']]).agent).toBe('copilot')
    expect(sessionFromMetadata('b', [['copilotcli.transport', 'cli']]).agent).toBe('copilot')
    expect(sessionFromMetadata('c', [['codex.model', 'o4']]).agent).toBe('codex')
  })

  it('leaves the provider unstated rather than guessing one', () => {
    const session = sessionFromMetadata('d', [['customTitle', 'something new'], ['isRead', 'true']])
    expect(session.agent).toBeNull()
    expect(session.title).toBe('something new')
    // unread count is unknown, which is not the same as a session with no turns
    expect(session.turns).toBeNull()
  })

  it('takes a bare string when an agent does not wrap its model in JSON', () => {
    expect(sessionFromMetadata('e', [['codex.model', 'gpt-5-codex']]).model).toBe('gpt-5-codex')
  })

  it('leaves a path that is not a file uri alone', () => {
    expect(fileUriToPath('/Users/me/dev')).toBe('/Users/me/dev')
    expect(fileUriToPath('')).toBeNull()
  })
})

describe.skipIf(!hasSqlite3())('agent host store', () => {
  let dir = ''

  beforeAll(() => {
    dir = home('store')
    writeSessionDb(
      dir,
      'aaaaaaaa-0000-0000-0000-000000000001',
      {
        'claude.model': '{"id":"claude-haiku-4.5"}',
        'claude.transport': 'proxy',
        customTitle: 'a | title with the sqlite separator in it',
        'agentHost.workspaceless': 'false'
      },
      2
    )
    // the host GCs sessions nobody said anything in; it leaves the db behind
    writeSessionDb(dir, 'aaaaaaaa-0000-0000-0000-000000000002', { customTitle: 'never used' }, 0)
    mkdirSync(join(dir, 'agentSessionData', 'no-db-here'), { recursive: true })
  })

  it('reads a session out of the live store shape', async () => {
    const { sessions, truncated } = await readSessions(dir)
    expect(truncated).toBe(false)
    const one = sessions.find((s) => s.id.endsWith('0001'))
    expect(one?.agent).toBe('claude')
    expect(one?.transport).toBe('proxy')
    expect(one?.turns).toBe(2)
    // -json, not the default separator: the title would otherwise be cut in half
    expect(one?.title).toBe('a | title with the sqlite separator in it')
  })

  it('skips a session directory with no readable database', async () => {
    const { sessions } = await readSessions(dir)
    expect(sessions.map((s) => s.id)).not.toContain('no-db-here')
    expect(sessions).toHaveLength(2)
  })

  it('answers whether the indexer can see what the host is holding', async () => {
    const report = await probeAgentHost(dir)
    const coverage = coverageFor(report, new Set<string>())
    expect(coverage.total).toBe(2)
    // the empty one is the host's own husk, never counted as a gap
    expect(coverage.empty).toEqual(['aaaaaaaa-0000-0000-0000-000000000002'])
    expect(coverage.invisible).toEqual(['aaaaaaaa-0000-0000-0000-000000000001'])
  })
})

describe('agent host coverage', () => {
  const session = (id: string, turns: number | null): AgentHostSession =>
    sessionFromMetadata(id, [['claude.transport', 'proxy']], turns)

  it('counts a session the provider store also holds as covered', () => {
    const verdict = judgeCoverage([session('one', 4)], new Set(['one']))
    expect(verdict.indexed).toEqual(['one'])
    expect(verdict.invisible).toEqual([])
  })

  it('counts a session with turns and no provider file as a gap', () => {
    const verdict = judgeCoverage([session('two', 4)], new Set(['other']))
    expect(verdict.invisible).toEqual(['two'])
  })

  it('separates an empty session from the gap it would otherwise inflate', () => {
    const verdict = judgeCoverage([session('three', 0)], new Set())
    expect(verdict.empty).toEqual(['three'])
    expect(verdict.invisible).toEqual([])
  })

  it('does not treat an unreadable turn count as an empty session', () => {
    const verdict = judgeCoverage([session('four', null)], new Set())
    expect(verdict.empty).toEqual([])
    expect(verdict.invisible).toEqual(['four'])
  })
})

describe('turn payload shape capture', () => {
  it('records paths and leaf types, never what was said', () => {
    const paths = payloadKeyPaths(
      JSON.stringify({
        turnId: 't1',
        request: { role: 'user', text: 'the secret plan is to rewrite everything' },
        items: [{ kind: 'tool', name: 'Bash', ok: true }],
        usage: null
      })
    )
    expect(paths).toContain('request.text: string')
    expect(paths).toContain('items[].ok: boolean')
    expect(paths).toContain('usage: null')
    expect(paths.join('\n')).not.toContain('secret plan')
    expect(paths.join('\n')).not.toContain('Bash')
  })

  it('collapses a key that is itself data', () => {
    const paths = payloadKeyPaths(JSON.stringify({ edits: { '/Users/me/dev/secret.ts': { added: 3 } } }))
    expect(paths).toEqual(['edits.<dynamic>.added: number'])
    expect(paths.join('\n')).not.toContain('secret.ts')
  })

  it('notes an empty array rather than inventing its element', () => {
    expect(payloadKeyPaths(JSON.stringify({ items: [] }))).toEqual(['items[]: empty'])
  })

  it('returns nothing for a payload it cannot parse', () => {
    expect(payloadKeyPaths('not json at all')).toEqual([])
  })
})
