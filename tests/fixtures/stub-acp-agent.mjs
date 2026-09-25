/**
 * A minimal ACP agent, for driving the real client in tests. Speaks newline-delimited
 * JSON-RPC on stdio exactly as `copilot --acp` does; STUB_MODE picks the behaviour.
 */
const mode = process.env.STUB_MODE ?? 'basic'
let sid = 'sess-1'
let nextId = 1000
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
  if (m.method === undefined && waiting.has(m.id)) {
    waiting.get(m.id)(m.result)
    waiting.delete(m.id)
    return
  }
  switch (m.method) {
    case 'initialize':
      if (mode === 'banner') process.stdout.write('StubAgent v9 starting up\n')
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
    case 'session/new':
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
    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `answered:${outcome?.outcome?.optionId}` } })
  }
  if (mode === 'fs-probe') {
    const res = await request('fs/read_text_file', { path: '/etc/hosts' }).catch(() => null)
    notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `fs:${JSON.stringify(res)}` } })
  }
  notify({ sessionUpdate: 'usage_update', used: 10, size: 100 })
  send({ jsonrpc: '2.0', id, result: { stopReason: mode === 'maxtokens' ? 'max_tokens' : 'end_turn' } })
}
