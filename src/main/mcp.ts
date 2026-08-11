import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import type { McpConfig, McpProbeResult, Provider } from '../shared/types'
import { cliEnv } from './env'

/*
 * Runtime side of MCP management:
 *  - probeMcp: does the configured server actually answer? Stdio servers are
 *    spawned and sent a JSON-RPC initialize; url servers get the same request
 *    over HTTP (401/403 = credentials expired → "needs-auth").
 *  - loginMcp: OAuth re-login is delegated to the agent's own CLI
 *    (`claude mcp login`, `codex mcp login`) so tokens land wherever that
 *    agent stores them. Copilot has no login command.
 */

const PROBE_TIMEOUT_MS = 8000
const LOGIN_TIMEOUT_MS = 180_000

/** Server names are spawned as CLI args — never allow flag-shaped names. */
export function assertCliSafeName(name: string): string {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(name)) throw new Error('invalid server name')
  return name
}

const initializeRequest = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'cockpit', version: '0.1.0' }
  }
})

async function probeHttp(url: string, timeoutMs: number): Promise<McpProbeResult> {
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: initializeRequest,
      signal
    })
    void res.body?.cancel().catch(() => {})
    if (res.status === 401 || res.status === 403) {
      return { status: 'needs-auth', detail: `HTTP ${res.status}` }
    }
    if (res.ok) return { status: 'ok' }
    // legacy SSE endpoints only speak GET — a stream opening counts as alive
    if (res.status === 404 || res.status === 405) {
      const sse = await fetch(url, { headers: { accept: 'text/event-stream' }, signal })
      void sse.body?.cancel().catch(() => {})
      if (sse.status === 401 || sse.status === 403) {
        return { status: 'needs-auth', detail: `HTTP ${sse.status}` }
      }
      if (sse.ok) return { status: 'ok' }
    }
    return { status: 'error', detail: `HTTP ${res.status}` }
  } catch (err) {
    return {
      status: 'error',
      detail: signal.aborted ? 'timed out' : err instanceof Error ? err.message : String(err)
    }
  }
}

function probeStdio(cfg: McpConfig, timeoutMs: number): Promise<McpProbeResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(cfg.command!, cfg.args ?? [], {
      env: { ...cliEnv(), ...cfg.env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    let done = false
    const finish = (result: McpProbeResult): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      resolvePromise(result)
    }
    const timer = setTimeout(() => finish({ status: 'error', detail: 'timed out' }), timeoutMs)

    child.on('error', (err) => finish({ status: 'error', detail: err.message }))
    child.on('exit', (code) =>
      finish({
        status: 'error',
        detail: `exited (${code ?? 'signal'}) before responding: ${stderr.trim().slice(-300)}`
      })
    )
    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000)
    })
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
      // newline-delimited JSON-RPC; servers may interleave non-JSON noise
      for (const line of stdout.split('\n')) {
        try {
          const msg = JSON.parse(line)
          if (msg?.id !== 1) continue
          if (msg.result) return finish({ status: 'ok' })
          if (msg.error) {
            return finish({ status: 'error', detail: String(msg.error.message ?? 'server error') })
          }
        } catch {
          /* partial or non-JSON line */
        }
      }
    })
    child.stdin?.write(initializeRequest + '\n')
  })
}

export function probeMcp(cfg: McpConfig, timeoutMs = PROBE_TIMEOUT_MS): Promise<McpProbeResult> {
  if (cfg.url) return probeHttp(cfg.url, timeoutMs)
  if (cfg.command) return probeStdio(cfg, timeoutMs)
  return Promise.resolve({ status: 'error', detail: 'server has neither command nor url' })
}

/**
 * Run `<agent> mcp login <name>` and wait for the OAuth flow (browser) to
 * complete. cwd matters for claude project-scoped servers — the caller must
 * have validated projectPath against ~/.claude.json first.
 */
export function loginMcp(
  name: string,
  agent: Provider,
  cwd?: string,
  timeoutMs = LOGIN_TIMEOUT_MS
): Promise<string> {
  assertCliSafeName(name)
  if (agent === 'copilot') {
    throw new Error('Copilot has no MCP login command — authenticate inside the Copilot CLI (/mcp)')
  }
  return new Promise((resolvePromise, reject) => {
    const child = spawn(agent, ['mcp', 'login', name], {
      cwd: cwd ?? homedir(),
      env: cliEnv(),
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      child.kill()
      reject(new Error('login timed out — finish the flow in your browser, then reload the server'))
    }, timeoutMs)
    child.stdout?.on('data', (d: Buffer) => {
      output = (output + d.toString()).slice(-2000)
    })
    child.stderr?.on('data', (d: Buffer) => {
      output = (output + d.toString()).slice(-2000)
    })
    child.on('error', (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(new Error(`could not run ${agent}: ${err.message}`))
    })
    child.on('exit', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      const tail = output.trim().split('\n').filter(Boolean).pop() ?? ''
      if (code === 0) resolvePromise(tail || `logged in to "${name}"`)
      else reject(new Error(tail || `${agent} mcp login exited with ${code}`))
    })
  })
}
