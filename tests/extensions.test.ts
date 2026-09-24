import { describe, it, expect } from 'vitest'
import {
  codexServerText,
  mcpJsonFor,
  parseCodexMcpToml,
  patchCodexServer,
  putCodexServer,
  removeCodexMcpToml,
  removeMcpFromJson
} from '../src/main/extensions-core'
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
  // the form Codex's own docs show — reading only `[….env]` subtables showed these
  // servers with no env at all, and a write-back then dropped the token for good
  it('reads an inline env table, quoted keys and all', () => {
    const toml = [
      '[mcp_servers.search]',
      'command = "npx"',
      'args = ["-y", "search-mcp"]',
      'env = { "API_KEY" = "sk-1", REGION = \'eu\' }'
    ].join('\n')
    expect(parseCodexMcpToml(toml).get('search')).toMatchObject({
      command: 'npx',
      env: { API_KEY: 'sk-1', REGION: 'eu' }
    })
  })

  it('reads a server written as dotted keys from a table above it', () => {
    const toml = [
      '[mcp_servers]',
      'inline = { command = "a", args = ["x"] }',
      'dotted.command = "b"',
      'dotted.env.TOKEN = "t"'
    ].join('\n')
    const m = parseCodexMcpToml(toml)
    expect(m.get('inline')).toMatchObject({ command: 'a', args: ['x'] })
    expect(m.get('dotted')).toMatchObject({ command: 'b', env: { TOKEN: 't' } })
  })

  it('reads args spread over lines, with comments between them', () => {
    const toml = '[mcp_servers.x]\ncommand = "uvx"\nargs = [\n  "--from", # pinned\n  \'pkg==1.0\',\n]\n'
    expect(parseCodexMcpToml(toml).get('x')?.args).toEqual(['--from', 'pkg==1.0'])
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

  // the old remover squeezed every run of blank lines in the file, which changed the
  // value of any multi-line string that had one
  it('leaves blank lines inside another table’s multi-line string alone', () => {
    const prompt = 'first\n\n\n\nlast'
    const text = `[profiles.work]\ninstructions = """${prompt}"""\n\n[mcp_servers.x]\ncommand = "x"\n`
    const out = removeCodexMcpToml(text, 'x')
    expect(out).toBe(`[profiles.work]\ninstructions = """${prompt}"""\n`)
  })

  // what the reader counts as the server, the remover must take: a leftover
  // `x.command` beside a freshly written [mcp_servers.x] is a key defined twice
  it('removes keys written for the server from a table above it', () => {
    const text = '[mcp_servers]\nx.command = "a"\ny.command = "b"\n\n[mcp_servers.x.env]\nT = "t"\n'
    const out = removeCodexMcpToml(text, 'x')
    expect([...parseCodexMcpToml(out).keys()]).toEqual(['y'])
    expect(out).toBe('[mcp_servers]\ny.command = "b"\n')
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

describe('writing a Codex server back', () => {
  const config = [
    'model = "gpt-5"',
    '',
    '# docs search, pinned',
    '[mcp_servers.search]',
    'command = "npx"',
    'args = [',
    '  "-y",',
    '  "search-mcp@1.2.0",',
    ']',
    'env = { "API_KEY" = "sk-live-1" }',
    'startup_timeout_sec = 30',
    'enabled_tools = ["query", "fetch"]',
    '',
    '[mcp_servers.search.tools.query]',
    'approval = "never"',
    '',
    '[profiles.work]',
    'model = "o3"',
    ''
  ].join('\n')

  it('takes the server out whole, comment above it included', () => {
    const server = codexServerText(config, 'search')
    expect(server).toBe(config.slice(config.indexOf('# docs'), config.indexOf('[profiles.work]')))
    expect(codexServerText(config, 'nope')).toBeNull()
  })

  it('moves only the version, byte for byte', () => {
    const server = codexServerText(config, 'search')!
    const bumped = patchCodexServer(server, 'search', {
      command: 'npx',
      args: ['-y', 'search-mcp@1.3.0'],
      env: { API_KEY: 'sk-live-1' }
    })
    expect(bumped).toBe(server.replace('search-mcp@1.2.0', 'search-mcp@1.3.0'))
  })

  it('writes a changed env in the form the server already used', () => {
    const server = codexServerText(config, 'search')!
    const patched = patchCodexServer(server, 'search', {
      command: 'npx',
      args: ['-y', 'search-mcp@1.2.0'],
      env: { API_KEY: 'sk-live-2', 'odd.name': 'x' }
    })
    expect(patched).toContain('env = { API_KEY = "sk-live-2", "odd.name" = "x" }')
    expect(patched).toContain('startup_timeout_sec = 30')
    expect(parseCodexMcpToml(patched).get('search')?.env).toEqual({ API_KEY: 'sk-live-2', 'odd.name': 'x' })
  })

  it('turns a local server into a remote one without keeping its launch line', () => {
    const server = codexServerText(config, 'search')!
    const remote = patchCodexServer(server, 'search', { url: 'https://search.example.dev/mcp' })
    expect(parseCodexMcpToml(remote).get('search')).toMatchObject({
      url: 'https://search.example.dev/mcp',
      command: undefined,
      args: undefined,
      env: undefined
    })
    // what Cockpit doesn't compare is still the user's
    expect(remote).toContain('enabled_tools = ["query", "fetch"]')
    expect(remote).toContain('[mcp_servers.search.tools.query]')
  })

  it('adds an env subtable to a server that had none', () => {
    const plain = '[mcp_servers.x]\ncommand = "x"\nargs = []\n'
    const patched = patchCodexServer(plain, 'x', { command: 'x', args: [], env: { TOKEN: 't' } })
    expect(patched).toBe('[mcp_servers.x]\ncommand = "x"\nargs = []\n\n[mcp_servers.x.env]\nTOKEN = "t"\n')
  })

  it('puts a patched server back where it was, and the rest of the file as it was', () => {
    const server = codexServerText(config, 'search')!
    const bumped = server.replace('1.2.0', '1.3.0')
    expect(putCodexServer(config, 'search', bumped)).toBe(config.replace('1.2.0', '1.3.0'))
  })

  it('adds a server the file didn’t have at the end, a blank line after the last table', () => {
    const out = putCodexServer('[a]\nb = 1\n', 'new', '[mcp_servers.new]\ncommand = "n"\n')
    expect(out).toBe('[a]\nb = 1\n\n[mcp_servers.new]\ncommand = "n"\n')
    expect(putCodexServer('', 'new', '[mcp_servers.new]\n')).toBe('[mcp_servers.new]\n')
  })
})

describe('writing a JSON server back', () => {
  it('keeps what the agent holds that Cockpit doesn’t compare', () => {
    const base = {
      type: 'http',
      url: 'https://mcp.example.dev/v1',
      headers: { Authorization: 'Bearer secret' },
      oauth: { clientId: 'c' }
    }
    const moved = mcpJsonFor('claude', { type: 'http', url: 'https://mcp.example.dev/v2' }, base)
    expect(moved).toEqual({ ...base, url: 'https://mcp.example.dev/v2' })
  })

  it('keeps Copilot’s tools allowlist and its name for a local server', () => {
    const base = { type: 'local', command: 'npx', args: ['-y', 'x@1.0.0'], env: { A: '1' }, tools: ['read'] }
    const out = mcpJsonFor('copilot', { command: 'npx', args: ['-y', 'x@1.1.0'], env: { A: '1' } }, base)
    expect(out).toEqual({ ...base, args: ['-y', 'x@1.1.0'] })
  })

  it('drops the remote transport and the url when a server turns local', () => {
    const base = { type: 'http', url: 'https://x.dev', headers: { A: 'b' } }
    const out = mcpJsonFor('claude', { command: 'x', args: ['--stdio'] }, base)
    expect(out).toEqual({ headers: { A: 'b' }, command: 'x', args: ['--stdio'] })
  })

  it('builds a fresh definition for an agent that never had one', () => {
    expect(mcpJsonFor('copilot', { type: 'sse', url: 'https://x.dev' }, undefined)).toEqual({
      type: 'sse',
      url: 'https://x.dev',
      tools: ['*']
    })
    expect(mcpJsonFor('claude', { command: 'x' }, 'not an object')).toEqual({ command: 'x', args: [] })
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
