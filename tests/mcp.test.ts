import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertCliSafeName, loginMcp, probeMcp } from '../src/main/mcp'

/** A minimal newline-delimited MCP stdio server: answers initialize, ignores the rest. */
const STDIO_SERVER = `
let buf = ''
process.stdin.on('data', (d) => {
  buf += d.toString()
  for (const line of buf.split('\\n')) {
    if (!line.trim()) continue
    try {
      const msg = JSON.parse(line)
      if (msg.method === 'initialize') {
        process.stdout.write(
          JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } }) + '\\n'
        )
      }
    } catch {}
  }
})
`

describe('probeMcp stdio', () => {
  it('reports ok when the spawned server answers initialize', async () => {
    const r = await probeMcp({ command: process.execPath, args: ['-e', STDIO_SERVER] })
    expect(r).toEqual({ status: 'ok' })
  })

  it('reports error when the process exits before responding', async () => {
    const r = await probeMcp({
      command: process.execPath,
      args: ['-e', 'console.error("bad config"); process.exit(3)']
    })
    expect(r.status).toBe('error')
    expect(r.detail).toContain('bad config')
  })

  it('reports error when the command does not exist', async () => {
    const r = await probeMcp({ command: '/definitely/not/a/real/binary' })
    expect(r.status).toBe('error')
  })

  it('reports error when the config is empty', async () => {
    const r = await probeMcp({})
    expect(r.status).toBe('error')
  })

  it('times out a server that never answers', async () => {
    const r = await probeMcp({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }, 500)
    expect(r).toMatchObject({ status: 'error', detail: 'timed out' })
  })
})

describe('probeMcp http', () => {
  let server: Server
  let base: string

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/ok') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end('{"jsonrpc":"2.0","id":1,"result":{}}')
      } else if (req.url === '/auth') {
        res.writeHead(401)
        res.end()
      } else if (req.url === '/sse' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('event: ping\n\n')
      } else if (req.url === '/sse') {
        // legacy SSE endpoints reject POST — the probe must fall back to GET
        res.writeHead(405)
        res.end()
      } else {
        res.writeHead(500)
        res.end()
      }
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const addr = server.address()
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise((r) => server.close(r))
  })

  it('reports ok on a 2xx initialize response', async () => {
    expect(await probeMcp({ url: `${base}/ok` })).toEqual({ status: 'ok' })
  })

  it('maps 401 to needs-auth', async () => {
    expect(await probeMcp({ url: `${base}/auth` })).toEqual({
      status: 'needs-auth',
      detail: 'HTTP 401'
    })
  })

  it('falls back to a GET stream for SSE-only endpoints', async () => {
    expect(await probeMcp({ url: `${base}/sse` })).toEqual({ status: 'ok' })
  })

  it('reports error for other statuses and unreachable hosts', async () => {
    expect((await probeMcp({ url: `${base}/boom` })).status).toBe('error')
    expect((await probeMcp({ url: 'http://127.0.0.1:1/nope' })).status).toBe('error')
  })
})

describe('loginMcp', () => {
  const binDir = mkdtempSync(join(tmpdir(), 'cockpit-mcp-bin-'))
  const savedPath = process.env.PATH

  beforeAll(() => {
    // cliEnv() puts process.env.PATH first, so a leading fake-bin dir wins
    writeFileSync(join(binDir, 'codex'), '#!/bin/sh\necho "Logged in to $3"\nexit 0\n')
    writeFileSync(join(binDir, 'claude'), '#!/bin/sh\necho "no browser available" >&2\nexit 1\n')
    chmodSync(join(binDir, 'codex'), 0o755)
    chmodSync(join(binDir, 'claude'), 0o755)
    process.env.PATH = `${binDir}:${savedPath}`
  })

  afterAll(() => {
    process.env.PATH = savedPath
  })

  it('resolves with the CLI output on success', async () => {
    await expect(loginMcp('linear', 'codex')).resolves.toContain('Logged in to linear')
  })

  it('rejects with the CLI output on failure', async () => {
    await expect(loginMcp('linear', 'claude')).rejects.toThrow(/no browser available/)
  })

  it('refuses copilot (no login command) and flag-shaped names', () => {
    expect(() => loginMcp('linear', 'copilot')).toThrow(/Copilot/)
    expect(() => loginMcp('--evil', 'codex')).toThrow(/invalid/)
    expect(() => assertCliSafeName('-x')).toThrow(/invalid/)
    expect(assertCliSafeName('linear_v2.prod')).toBe('linear_v2.prod')
  })
})
