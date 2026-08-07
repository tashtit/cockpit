import { describe, it, expect } from 'vitest'
import { parseCodexMcpToml } from '../src/main/extensions'
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
