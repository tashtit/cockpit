/**
 * Stand-in for `claude`, `codex`, `copilot` and `gh` inside the ui-tour's fixture world.
 * The world's bin dir holds one tiny shell wrapper per name that runs this file with the
 * tool as its first argument, so the app spawns it exactly as it spawns the real CLI.
 *
 * Agents stream a plausible turn slowly (UI_TOUR_STUB_DELAY_MS between lines) and write
 * the provider's own session log as they go — so a session genuinely shows as flying,
 * then genuinely lands, and the indexer picks the new turn up like any other.
 * Plain .mjs on purpose: it runs as a child process, not as part of the typed build.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { basename, join } from 'node:path'

const [tool, ...args] = process.argv.slice(2)
const HOME = process.env.HOME ?? '/tmp'
const DELAY = Number(process.env.UI_TOUR_STUB_DELAY_MS ?? 900)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => new Date().toISOString()
const cwd = process.cwd()
const flag = (f) => {
  const i = args.indexOf(f)
  return i >= 0 ? args[i + 1] : undefined
}
const emit = async (line) => {
  process.stdout.write(typeof line === 'string' ? line : `${JSON.stringify(line)}\n`)
  await sleep(DELAY)
}
const branch = (() => {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return null
  }
})()
const findLog = (root, suffix) => {
  try {
    return readdirSync(root, { recursive: true })
      .map((f) => join(root, String(f)))
      .find((f) => f.endsWith(suffix))
  } catch {
    return undefined
  }
}
const HANDOFF = 'You are handing this coding session off'
const SUMMARY =
  '## Original request\nFix the login flake\n## Current state\nTests green locally\n' +
  '## What has been done\nRaised retries, added backoff\n## What remains\nPR review\n## Gotchas\nCI is slow'

async function gh() {
  const s = args.join(' ')
  const repo = basename(cwd)
  const prs = {
    rocket: [
      // red: its checks failed on the latest push — the flake session's branch, so its row carries it
      { n: 57, title: 'Fix login retry flake', state: 'OPEN', draft: false, head: 'cockpit/login-retry-flake', threads: [false, true, false], checks: 'FAILURE' },
      { n: 55, title: 'Paginate the sessions list', state: 'MERGED', draft: false, head: 'cockpit/paginate-sessions-list' },
      { n: 58, title: 'WIP dark mode tokens', state: 'OPEN', draft: true, head: 'cockpit/dark-mode-tokens', threads: [false] }
    ],
    atlas: [
      { n: 12, title: 'Retry billing webhooks', state: 'OPEN', draft: false, head: 'cockpit/billing-webhook-retries' },
      { n: 9, title: 'GraphQL spike', state: 'CLOSED', draft: false, head: 'cockpit/old-spike-graphql' }
    ]
  }
  if (s === 'api user -q .login') return console.log('octo-dev')
  if (/^api \/users\/[^/]+\/settings\/billing\/premium_request\/usage$/.test(s))
    return console.log(JSON.stringify({ usageItems: [{ product: 'copilot', grossQuantity: 212, netQuantity: 212 }] }))
  if (args[0] === 'pr' && args[1] === 'list')
    return console.log(
      JSON.stringify(
        (prs[repo] ?? []).map((p) => ({
          number: p.n,
          title: p.title,
          state: p.state,
          isDraft: p.draft,
          headRefName: p.head,
          headRefOid: `${p.n}`.padStart(4, '0').repeat(10),
          url: `https://github.com/acme/${repo}/pull/${p.n}`,
          statusCheckRollup: p.state === 'OPEN' ? [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: p.checks ?? 'SUCCESS' }] : [],
          reviewDecision: ''
        }))
      )
    )
  // the PR badges' unresolved-thread counts (the review panel's single-PR query is left unhandled)
  if (args[0] === 'api' && args[1] === 'graphql' && s.includes('pullRequests('))
    return console.log(
      JSON.stringify({
        data: {
          repository: {
            pullRequests: {
              nodes: (prs[repo] ?? [])
                .filter((p) => p.state === 'OPEN')
                .map((p) => ({ number: p.n, reviewThreads: { nodes: (p.threads ?? []).map((isResolved) => ({ isResolved })) } }))
            }
          }
        }
      })
    )
  if (args[0] === 'pr' && args[1] === 'create') return console.log(`https://github.com/acme/${repo}/pull/59`)
  // anything else behaves like gh offline: fail soft, the app already handles that
  console.error(`ui-tour gh stub: unhandled: ${s}`)
  process.exit(1)
}

async function claude() {
  // sign-in status: the default home is signed in; any other home (the world's
  // claude-work) reads as an expired session, so the tour shows both states
  if (args[0] === 'auth' && args[1] === 'status') {
    const other = process.env.CLAUDE_CONFIG_DIR !== undefined && process.env.CLAUDE_CONFIG_DIR !== join(HOME, '.claude')
    console.log(JSON.stringify({ loggedIn: !other, authMethod: other ? 'none' : 'claudeai' }))
    process.exit(other ? 1 : 0)
  }
  if (args[0] !== '-p') return console.log('ok') // mcp login, plugin install, …
  const prompt = args.at(-1) ?? ''
  const id = flag('--resume') ?? randomUUID()
  const home = process.env.CLAUDE_CONFIG_DIR ?? join(HOME, '.claude')
  const file =
    findLog(join(home, 'projects'), `${id}.jsonl`) ??
    join(home, 'projects', cwd.replace(/[/.]/g, '-'), `${id}.jsonl`)
  mkdirSync(join(file, '..'), { recursive: true })
  const log = (o) => appendFileSync(file, `${JSON.stringify({ sessionId: id, cwd, gitBranch: branch, timestamp: now(), ...o })}\n`)
  log({ type: 'user', message: { role: 'user', content: prompt } })
  await emit({ type: 'system', subtype: 'init', session_id: id, cwd, model: 'claude-opus-4-1' })
  const blocks = prompt.startsWith(HANDOFF)
    ? [{ type: 'text', text: SUMMARY }]
    : [
        { type: 'text', text: 'Running the suite first.\n\n' },
        { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'npm test -- login' } },
        { type: 'tool_use', id: 'toolu_2', name: 'Edit', input: { file_path: join(cwd, 'src/login.ts'), old_string: 'retries = 1', new_string: 'retries = 3' } },
        { type: 'text', text: 'Raised the retry budget; the suite passes.' }
      ]
  for (const [i, b] of blocks.entries()) {
    const message = { id: `msg_${id}_${Date.now()}_${i}`, role: 'assistant', model: 'claude-opus-4-1', content: [b], usage: { input_tokens: 900, output_tokens: 120 } }
    log({ type: 'assistant', requestId: message.id, message })
    await emit({ type: 'assistant', session_id: id, message })
    if (b.type === 'tool_use') {
      const m = { role: 'user', content: [{ type: 'tool_result', tool_use_id: b.id, content: 'ok' }] }
      log({ type: 'user', message: m })
      await emit({ type: 'user', session_id: id, message: m })
    }
  }
  await emit({ type: 'result', subtype: 'success', is_error: false, session_id: id, total_cost_usd: 0.04 })
}

async function codex() {
  if (args[0] === 'login' && args[1] === 'status') return console.log('Logged in using ChatGPT')
  if (args[0] !== 'exec') return console.log('ok')
  const resume = args[1] === 'resume' ? args[2] : undefined
  const id = resume ?? randomUUID()
  const prompt = args.at(-1) ?? ''
  const home = process.env.CODEX_HOME ?? join(HOME, '.codex')
  const d = new Date()
  const day = join(home, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
  const file = findLog(join(home, 'sessions'), `${id}.jsonl`) ?? join(day, `rollout-${now().replace(/[:.]/g, '-')}-${id}.jsonl`)
  mkdirSync(join(file, '..'), { recursive: true })
  const log = (type, payload) => appendFileSync(file, `${JSON.stringify({ timestamp: now(), type, payload })}\n`)
  if (!resume) log('session_meta', { id, cwd, git: branch ? { branch } : undefined })
  log('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] })
  await emit({ type: 'thread.started', thread_id: id })
  await emit({ type: 'item.completed', item: { type: 'command_execution', command: 'bash -lc "rg premium_request src"', exit_code: 0 } })
  const reply = prompt.startsWith(HANDOFF) ? SUMMARY : 'Added the fallback and a test.'
  log('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply }] })
  await emit({ type: 'item.completed', item: { type: 'agent_message', text: reply } })
  await emit({ type: 'turn.completed' })
}

async function copilot() {
  // Cockpit joins the prompt to its flag (`--prompt=…`), so a prompt starting with "-" stays one
  const joined = args[0]?.startsWith('--prompt=') ? args[0].slice('--prompt='.length) : undefined
  if (joined === undefined && args[0] !== '-p') return console.log('ok')
  const prompt = joined ?? flag('-p') ?? ''
  const id = flag('--resume') ?? randomUUID()
  const dir = join(process.env.COPILOT_HOME ?? join(HOME, '.copilot'), 'session-state', id)
  const file = join(dir, 'events.jsonl')
  mkdirSync(dir, { recursive: true })
  const ev = (type, data) => appendFileSync(file, `${JSON.stringify({ type, timestamp: now(), data })}\n`)
  if (!existsSync(file)) ev('session.start', { sessionId: id, startTime: now(), context: { cwd, branch } })
  ev('user.message', { content: prompt })
  const reply = prompt.startsWith(HANDOFF) ? SUMMARY : 'Checked the panel. Tightened spacing. Tests pass.'
  for (const part of reply.split(/(?<=\. )/)) await emit(part)
  ev('assistant.message', { content: reply, model: 'claude-sonnet-4.5' })
}

// `--version`, as each real CLI words it — the Agent CLIs group reads these
const VERSIONS = { claude: '2.1.236 (Claude Code)', codex: 'codex-cli 0.155.1', copilot: 'GitHub Copilot CLI 1.0.87-0.' }
if (args[0] === '--version' && VERSIONS[tool]) {
  console.log(VERSIONS[tool])
  process.exit(0)
}
const run = { gh, claude, codex, copilot }[tool]
if (!run) {
  console.error(`ui-tour stub: unknown tool ${tool}`)
  process.exit(2)
}
await run()
