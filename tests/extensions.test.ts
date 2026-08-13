import { describe, it, expect } from 'vitest'
import { parseCodexMcpToml, removeCodexMcpToml, removeMcpFromJson } from '../src/main/extensions'
import { buildCommand, isValidModel } from '../src/main/chat'

describe('parseCodexMcpToml', () => {
  it('parses command/args/url servers and env subtables', () => {
    const toml = [
      '[mcp_servers.idea]',
      'url = "http://127.0.0.1:64342/stream"',
      '',
      '[mcp_servers.node_repl]',
      'args = ["-y", "some-pkg"]',
      'command = "/usr/local/bin/node_repl"',
      'startup_timeout_sec = 120',
      '',
      '[mcp_servers.node_repl.env]',
      'NODE_PATH = "/opt/node"',
      '',
      '[other_section]',
      'foo = "bar"'
    ].join('\n')
    const m = parseCodexMcpToml(toml)
    expect([...m.keys()].sort()).toEqual(['idea', 'node_repl'])
    expect(m.get('idea')).toMatchObject({ url: 'http://127.0.0.1:64342/stream' })
    expect(m.get('node_repl')).toMatchObject({
      command: '/usr/local/bin/node_repl',
      args: ['-y', 'some-pkg'],
      env: { NODE_PATH: '/opt/node' }
    })
  })

  it('tolerates empty/garbage input', () => {
    expect(parseCodexMcpToml('').size).toBe(0)
    expect(parseCodexMcpToml('not toml at all').size).toBe(0)
  })

  // a dotted name must be a quoted key, or TOML nests it as a subtable and both
  // codex and this parser see a different server than the one that was shared
  it('reads a quoted dotted server name as one server', () => {
    const toml = [
      '[mcp_servers."my.server"]',
      'command = "/usr/bin/mine"',
      '',
      '[mcp_servers."my.server".env]',
      'TOKEN = "abc"'
    ].join('\n')
    const m = parseCodexMcpToml(toml)
    expect([...m.keys()]).toEqual(['my.server'])
    expect(m.get('my.server')).toMatchObject({ command: '/usr/bin/mine', env: { TOKEN: 'abc' } })
  })
})

describe('removeCodexMcpToml', () => {
  const toml = [
    '[mcp_servers.idea]',
    'url = "http://127.0.0.1:64342/stream"',
    '',
    '[mcp_servers.node_repl]',
    'command = "/usr/local/bin/node_repl"',
    'args = ["-y", "some-pkg"]',
    '',
    '[mcp_servers.node_repl.env]',
    'NODE_PATH = "/opt/node"',
    '',
    '[other_section]',
    'foo = "bar"'
  ].join('\n')

  it('drops the server section and its subtables, keeps everything else', () => {
    const out = removeCodexMcpToml(toml, 'node_repl')
    expect([...parseCodexMcpToml(out).keys()]).toEqual(['idea'])
    expect(out).not.toContain('node_repl')
    expect(out).toContain('[other_section]')
    expect(out).toContain('foo = "bar"')
    expect(out).toContain('url = "http://127.0.0.1:64342/stream"')
  })

  it('does not remove servers whose name shares a prefix', () => {
    const out = removeCodexMcpToml(toml, 'idea')
    expect([...parseCodexMcpToml(out).keys()]).toEqual(['node_repl'])
    expect(parseCodexMcpToml(out).get('node_repl')).toMatchObject({ env: { NODE_PATH: '/opt/node' } })
  })

  it('throws when the server is not configured', () => {
    expect(() => removeCodexMcpToml(toml, 'nope')).toThrow(/not found/)
    expect(() => removeCodexMcpToml('', 'idea')).toThrow(/not found/)
  })

  // config.toml also holds the user's projects/model_providers/profiles — a header
  // the line matcher fails to recognise would leave the dropper stuck and eat them
  it('keeps unrelated sections whose header carries an inline comment', () => {
    const withComments = [
      '[mcp_servers.foo]',
      'command = "foo"',
      '',
      '[projects."/Users/me/dev"] # main',
      'trust_level = "trusted"',
      '',
      '[mcp_servers.bar]',
      'command = "bar"'
    ].join('\n')
    const out = removeCodexMcpToml(withComments, 'foo')
    expect(out).toContain('[projects."/Users/me/dev"]')
    expect(out).toContain('trust_level = "trusted"')
    expect([...parseCodexMcpToml(out).keys()]).toEqual(['bar'])
  })

  it('removes a server whose own header carries an inline comment', () => {
    const commented = ['[mcp_servers.foo] # disabled', 'command = "foo"'].join('\n')
    expect(removeCodexMcpToml(commented, 'foo')).not.toContain('mcp_servers.foo')
  })

  it('drops every subtable, not just .env', () => {
    const withHeaders = [
      '[mcp_servers.foo]',
      'url = "https://x.test"',
      '',
      '[mcp_servers.foo.headers]',
      'Authorization = "Bearer x"',
      '',
      '[mcp_servers.other]',
      'command = "other"'
    ].join('\n')
    const out = removeCodexMcpToml(withHeaders, 'foo')
    expect(out).not.toContain('mcp_servers.foo')
    expect(out).not.toContain('Authorization')
    expect([...parseCodexMcpToml(out).keys()]).toEqual(['other'])
  })

  it('removes a quoted dotted server instead of reporting it missing', () => {
    const dotted = [
      '[mcp_servers.idea]',
      'url = "http://127.0.0.1:64342/stream"',
      '',
      '[mcp_servers."my.server"]',
      'command = "/usr/bin/mine"',
      '',
      '[mcp_servers."my.server".env]',
      'TOKEN = "abc"'
    ].join('\n')
    const out = removeCodexMcpToml(dotted, 'my.server')
    expect([...parseCodexMcpToml(out).keys()]).toEqual(['idea'])
    expect(out).not.toContain('my.server')
  })
})

describe('removeMcpFromJson', () => {
  const fresh = () => ({
    mcpServers: { linear: { type: 'sse', url: 'https://mcp.linear.app/sse' } },
    projects: {
      '/home/dev/cachely': {
        mcpServers: { linear: { type: 'sse', url: 'https://mcp.linear.app/sse' } }
      }
    }
  })

  it('removes a user-scope server, leaving project entries alone', () => {
    const j = fresh()
    removeMcpFromJson(j, 'linear')
    expect(j.mcpServers).toEqual({})
    expect(j.projects['/home/dev/cachely'].mcpServers.linear).toBeDefined()
  })

  it('removes a project-scope server, leaving user scope alone', () => {
    const j = fresh()
    removeMcpFromJson(j, 'linear', '/home/dev/cachely')
    expect(j.projects['/home/dev/cachely'].mcpServers).toEqual({})
    expect(j.mcpServers.linear).toBeDefined()
  })

  it('throws when the entry is missing', () => {
    expect(() => removeMcpFromJson(fresh(), 'nope')).toThrow(/not found/)
    expect(() => removeMcpFromJson(fresh(), 'linear', '/wrong/path')).toThrow(/not configured/)
    expect(() => removeMcpFromJson({}, 'linear')).toThrow()
  })
})

describe('buildCommand agent options', () => {
  it('passes a valid model to each CLI', () => {
    for (const provider of ['claude', 'codex', 'copilot'] as const) {
      const { args } = buildCommand({
        provider,
        cwd: '/tmp',
        prompt: 'hi',
        permissionMode: 'safe',
        options: { model: 'sonnet' }
      })
      expect(args).toContain('--model')
      expect(args[args.indexOf('--model') + 1]).toBe('sonnet')
    }
  })

  it('drops flag-shaped model values', () => {
    const { args } = buildCommand({
      provider: 'claude',
      cwd: '/tmp',
      prompt: 'hi',
      permissionMode: 'safe',
      options: { model: '--dangerously-skip-permissions' }
    })
    expect(args).not.toContain('--model')
    expect(isValidModel('--x')).toBe(false)
    expect(isValidModel('gpt-5-codex')).toBe(true)
  })

  it('maps codex sandbox and keeps yolo exclusive', () => {
    const sandboxed = buildCommand({
      provider: 'codex',
      cwd: '/tmp',
      prompt: 'hi',
      permissionMode: 'safe',
      options: { codexSandbox: 'workspace-write' }
    })
    expect(sandboxed.args).toContain('--sandbox')
    const yolo = buildCommand({
      provider: 'codex',
      cwd: '/tmp',
      prompt: 'hi',
      permissionMode: 'yolo',
      options: { codexSandbox: 'workspace-write' }
    })
    expect(yolo.args).not.toContain('--sandbox')
    expect(yolo.args).toContain('--dangerously-bypass-approvals-and-sandbox')
  })
})
