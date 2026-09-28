import { describe, expect, it } from 'vitest'
import {
  CLAUDE_ALLOW,
  CLAUDE_DENY,
  claudeAnswer,
  claudeControl,
  userMessageLine
} from '../src/main/claude-permissions'

/** A `can_use_tool` request as claude 2.1 writes it to stdout. */
function canUseTool(toolName: string, input: unknown, extra: Record<string, unknown> = {}): unknown {
  return {
    type: 'control_request',
    request_id: 'da6de61d-11bf-4076-9689-e05160691d56',
    request: { subtype: 'can_use_tool', tool_name: toolName, input, tool_use_id: 'toolu_01', ...extra }
  }
}

const parse = (line: string): any => JSON.parse(line)

describe('claudeControl', () => {
  it('puts a command to the person whole, with the agent’s own account of it beside it', () => {
    const command = 'npm ci && npm run typecheck'
    const control = claudeControl(
      't1',
      canUseTool('Bash', { command, description: 'Install and typecheck' }, {
        description: 'Install and typecheck',
        decision_reason: 'This command requires approval'
      })
    )
    expect(control).toEqual({
      kind: 'ask',
      requestId: 'da6de61d-11bf-4076-9689-e05160691d56',
      input: { command, description: 'Install and typecheck' },
      event: {
        turnId: 't1',
        type: 'permission',
        requestId: 'da6de61d-11bf-4076-9689-e05160691d56',
        // the name the card shows a command under
        toolName: 'shell',
        detail: command,
        preview: 'Install and typecheck',
        options: [
          { optionId: CLAUDE_ALLOW, name: 'Allow', kind: 'allow_once' },
          { optionId: CLAUDE_DENY, name: 'Deny', kind: 'reject_once' }
        ],
        // the CLI's own words for why it asks ride along to the card
        reason: 'This command requires approval'
      }
    })
  })

  it('names any other tool as itself, and says what it touches when the CLI gives no description', () => {
    const control = claudeControl('t1', canUseTool('Write', { file_path: '/etc/hosts', content: 'x' }))
    expect(control?.kind).toBe('ask')
    if (control?.kind !== 'ask') return
    expect(control.event.toolName).toBe('Write')
    expect(control.event.preview).toContain('/etc/hosts')
    expect(control.event.detail).toContain('"file_path"')
  })

  it('hands an MCP tool’s whole input to the card, readable and bounded', () => {
    const input = { repo: 'acme/rocket', title: 'Ship it', body: 'x'.repeat(5_000) }
    const control = claudeControl('t1', canUseTool('mcp__github__create_issue', input))
    if (control?.kind !== 'ask') throw new Error('expected an ask')
    const { detail, preview } = control.event
    // the name is all the headline has; what it would do is the input
    expect(preview).toBe('mcp__github__create_issue')
    expect(detail.startsWith('{\n  "repo": "acme/rocket",\n  "title": "Ship it",')).toBe(true)
    expect(detail).toMatch(/\n… \(\d+ more chars\)$/)
    expect(detail.length).toBeLessThan(4_100)
    // an ordinary request says nothing more of itself
    expect(control.event).not.toHaveProperty('reason')
    expect(control.event).not.toHaveProperty('blockedPath')
    expect(control.event).not.toHaveProperty('sandboxBypass')
  })

  it('carries the path that made it ask, and a command that asks to run outside the sandbox', () => {
    const read = claudeControl(
      't1',
      canUseTool('Read', { file_path: '/home/dev/.ssh/config' }, {
        blocked_path: '/home/dev/.ssh/config',
        decision_reason: `Path is outside allowed working directories ${'.'.repeat(1_000)}`
      })
    )
    if (read?.kind !== 'ask') throw new Error('expected an ask')
    expect(read.event.blockedPath).toBe('/home/dev/.ssh/config')
    expect(read.event.reason?.startsWith('Path is outside allowed working directories')).toBe(true)
    expect(read.event.reason?.length).toBeLessThanOrEqual(500)
    const bypass = claudeControl('t1', canUseTool('Bash', { command: 'npm ci', dangerouslyDisableSandbox: true }))
    if (bypass?.kind !== 'ask') throw new Error('expected an ask')
    expect(bypass.event).toMatchObject({ toolName: 'shell', detail: 'npm ci', sandboxBypass: true })
    // only Bash's own flag, and only when it is set
    const other = claudeControl('t1', canUseTool('Write', { file_path: 'a', dangerouslyDisableSandbox: true }))
    const off = claudeControl('t1', canUseTool('Bash', { command: 'ls', dangerouslyDisableSandbox: false }))
    expect(other?.kind === 'ask' && other.event).not.toHaveProperty('sandboxBypass')
    expect(off?.kind === 'ask' && off.event).not.toHaveProperty('sandboxBypass')
  })

  it('declines a question the chat already offers as picks, telling the model the answer comes next', () => {
    const questions = [
      { question: 'Red or blue?', header: 'Color', multiSelect: false, options: [{ label: 'Red' }, { label: 'Blue' }] }
    ]
    const control = claudeControl('t1', canUseTool('AskUserQuestion', { questions }, { requires_user_interaction: true }))
    expect(control?.kind).toBe('reply')
    if (control?.kind !== 'reply') return
    const answer = parse(control.line)
    expect(answer).toMatchObject({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'da6de61d-11bf-4076-9689-e05160691d56', response: { behavior: 'deny' } }
    })
    expect(answer.response.response.message).toMatch(/next message/)
    expect(control.line.endsWith('\n')).toBe(true)
    expect(claudeControl('t1', canUseTool('ExitPlanMode', { plan: '1. do it' }))?.kind).toBe('reply')
  })

  it('refuses a request kind it does not handle rather than leave the CLI waiting on it', () => {
    const control = claudeControl('t1', {
      type: 'control_request',
      request_id: 'r-9',
      request: { subtype: 'hook_callback', callback_id: 'x' }
    })
    expect(control?.kind).toBe('reply')
    if (control?.kind !== 'reply') return
    expect(parse(control.line)).toEqual({
      type: 'control_response',
      response: { subtype: 'error', request_id: 'r-9', error: 'Cockpit does not handle hook_callback' }
    })
  })

  it('notes a request the CLI withdrew', () => {
    expect(claudeControl('t1', { type: 'control_cancel_request', request_id: 'r-1' })).toEqual({
      kind: 'withdrawn',
      requestId: 'r-1'
    })
  })

  it('leaves ordinary stream events, and requests without a usable id, to the stream parser', () => {
    expect(claudeControl('t1', { type: 'assistant', message: { content: [] } })).toBeNull()
    expect(claudeControl('t1', { type: 'result' })).toBeNull()
    expect(claudeControl('t1', null)).toBeNull()
    expect(claudeControl('t1', 'control_request')).toBeNull()
    for (const id of [undefined, 7, '', '--dangerously-skip-permissions x', 'a'.repeat(200)]) {
      expect(claudeControl('t1', { type: 'control_request', request_id: id, request: { subtype: 'can_use_tool' } })).toBeNull()
    }
  })
})

describe('claudeAnswer', () => {
  it('an allow hands the call its input back unchanged; a deny tells the model the person said no', () => {
    const input = { command: 'git commit -m "fix"' }
    expect(parse(claudeAnswer('r-1', CLAUDE_ALLOW, input) ?? '')).toEqual({
      type: 'control_response',
      response: { subtype: 'success', request_id: 'r-1', response: { behavior: 'allow', updatedInput: input } }
    })
    const denied = parse(claudeAnswer('r-1', CLAUDE_DENY, input) ?? '')
    expect(denied.response.response).toEqual({ behavior: 'deny', message: 'The person declined this in Cockpit.' })
  })

  it('answers nothing for an option the card never offered', () => {
    expect(claudeAnswer('r-1', 'allow_always', {})).toBeNull()
    expect(claudeAnswer('r-1', '', {})).toBeNull()
  })
})

describe('userMessageLine', () => {
  it('is one stream-json user message on one line, whatever the prompt holds', () => {
    const prompt = '- fix this\n- and "that"'
    const line = userMessageLine(prompt)
    expect(line.endsWith('\n')).toBe(true)
    expect(line.slice(0, -1)).not.toContain('\n')
    expect(parse(line)).toEqual({
      type: 'user',
      message: { role: 'user', content: prompt },
      parent_tool_use_id: null,
      session_id: ''
    })
  })
})
