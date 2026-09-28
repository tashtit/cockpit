/**
 * A minimal ACP agent, for driving the real client in tests. Speaks newline-delimited
 * JSON-RPC on stdio exactly as `copilot --acp` does; STUB_MODE picks the behaviour.
 */
import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'

const mode = process.env.STUB_MODE ?? 'basic'
// 'relaunch': like Gemini's launcher, the agent runs a child of its own that outlives a
// signal to the parent alone. The launcher exits on SIGTERM and its child ignores it, so
// only a SIGKILL to the group that outlasts the launcher ends the child. The child writes
// its pid to STUB_PIDFILE once it ignores SIGTERM, and the launcher answers no handshake
// before then — a signal that beat the child's handler would prove nothing
if (mode === 'relaunch') {
  spawn(
    process.execPath,
    [
      '-e',
      "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.env.STUB_PIDFILE, String(process.pid)); setInterval(() => {}, 1000)"
    ],
    { stdio: 'ignore' }
  )
}
// 'mute': starts, and never answers anything, EOF included; its own pid goes to STUB_PIDFILE
if (mode === 'mute') {
  writeFileSync(process.env.STUB_PIDFILE, String(process.pid))
  setInterval(() => {}, 1000)
}
// 'linger': like Cursor's agent, it answers the turn and then keeps running past EOF, until
// a signal ends it; 'linger-hard' ignores SIGTERM too. Its own pid goes to STUB_PIDFILE
if (mode === 'linger' || mode === 'linger-hard') {
  writeFileSync(process.env.STUB_PIDFILE, String(process.pid))
  setInterval(() => {}, 1000)
  if (mode === 'linger-hard') process.on('SIGTERM', () => {})
}
let sid = 'sess-1'
let nextId = 1000
let signedIn = false
const waiting = new Map()

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n')
const notify = (update) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update } })
const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++
    waiting.set(id, resolve)
    send({ jsonrpc: '2.0', id, method, params })
  })

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => {
  buf += c
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const raw = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (raw) handle(JSON.parse(raw))
  }
})

function handle(m) {
  if (mode === 'mute') return
  if (m.method === undefined && waiting.has(m.id)) {
    waiting.get(m.id)(m.result)
    waiting.delete(m.id)
    return
  }
  switch (m.method) {
    case 'initialize':
      if (mode === 'relaunch' && !existsSync(process.env.STUB_PIDFILE)) {
        setTimeout(() => handle(m), 20)
        return
      }
      if (mode === 'banner') process.stdout.write('StubAgent v9 starting up\n')
      if (mode === 'huge') {
        // one message past the client's size cap, and never the newline that would end it
        process.stdout.write('{"jsonrpc":"2.0","pad":"' + 'x'.repeat(9 * 1024 * 1024))
        return
      }
      if (mode === 'crash') {
        process.stderr.write('stub: exploded during startup\n')
        process.exit(3)
      }
      send({
        jsonrpc: '2.0',
        id: m.id,
        result: {
          protocolVersion: 1,
          agentInfo: { name: 'Stub', version: '9.9' },
          agentCapabilities: {
            loadSession: mode !== 'noload',
            sessionCapabilities: { list: {} }
          },
          authMethods: [{ id: 'stub-login', name: 'Log in to Stub' }]
        }
      })
      return
    case 'authenticate':
      // 'auth': signing in with its own method works; 'auth-fail': it never does
      if (mode === 'auth' && m.params?.methodId === 'stub-login') {
        signedIn = true
        send({ jsonrpc: '2.0', id: m.id, result: {} })
      } else {
        send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'run stub login first' } })
      }
      return
    case 'session/new':
      // 'no-session': answers the handshake, then never opens a session
      if (mode === 'no-session') return
      if ((mode === 'auth' || mode === 'auth-fail') && !signedIn) {
        send({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'Authentication required' } })
        return
      }
      send({
        jsonrpc: '2.0',
        id: m.id,
        result: {
          sessionId: sid,
          modes: {
            availableModes: [
              { id: 'https://agentclientprotocol.com/protocol/session-modes#agent' },
              { id: 'https://agentclientprotocol.com/protocol/session-modes#autopilot' }
            ],
            currentModeId: 'https://agentclientprotocol.com/protocol/session-modes#agent'
          }
        }
      })
      return
    case 'session/load':
      if (mode === 'noload-error') {
        send({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'no such session' } })
        return
      }
      sid = m.params.sessionId
      // the spec requires the whole conversation be replayed before the load resolves
      notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYED-HISTORY' } })
      send({ jsonrpc: '2.0', id: m.id, result: {} })
      return
    case 'session/set_mode':
      process.stderr.write(`set_mode:${m.params.modeId}\n`)
      send({ jsonrpc: '2.0', id: m.id, result: {} })
      return
    case 'session/prompt':
      void runTurn(m.id, m.params)
      return
    case 'session/cancel':
      process.stderr.write('cancelled\n')
      return
    default:
      if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown' } })
  }
}

async function runTurn(id, params) {
  if (mode === 'echo-prompt') {
    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(params.prompt) } })
  }
  notify({
    sessionUpdate: 'tool_call',
    toolCallId: 'c1',
    title: 'List the files',
    kind: 'execute',
    rawInput: { command: 'ls -la' }
  })
  if (mode === 'permission' || mode === 'permission-edit') {
    const outcome = await request('session/request_permission', {
      sessionId: sid,
      toolCall: {
        toolCallId: 'c1',
        title: 'Run ls -la',
        kind: mode === 'permission-edit' ? 'edit' : 'execute',
        rawInput: { command: 'ls -la' }
      },
      options: [
        { optionId: 'allow_once', kind: 'allow_once', name: 'Allow once' },
        { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' }
      ]
    })
    // an option picked, or the outcome itself when none was (`cancelled`)
    const answer = outcome?.outcome?.optionId ?? outcome?.outcome?.outcome
    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `answered:${answer}` } })
  }
  if (mode === 'fs-probe') {
    const res = await request('fs/read_text_file', { path: '/etc/hosts' }).catch(() => null)
    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `fs:${JSON.stringify(res)}` } })
  }
  notify({ sessionUpdate: 'usage_update', used: 10, size: 100 })
  send({ jsonrpc: '2.0', id, result: { stopReason: mode === 'maxtokens' ? 'max_tokens' : 'end_turn' } })
}
