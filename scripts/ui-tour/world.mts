/**
 * The ui-tour's fixture world: a fake $HOME the app indexes instead of this machine's.
 *
 * Main resolves every agent path through os.homedir(), so launching Electron with
 * HOME=<world>/home, COCKPIT_USER_DATA=<world>/user-data and <world>/bin first on PATH
 * gives a hermetic app — three agents, two Claude accounts, five repositories with real
 * worktrees, rich and long transcripts, stale work for Cleanup, agent config with drift,
 * two roundtables, PR states — without a single real session or credential in sight.
 * Everything here is invented (acme/rocket and friends); nothing is fetched.
 *
 * Kept in step with the parsers by tests/ui-tour-world.test.ts: if a provider's log
 * format drifts, that test fails before the tour quietly renders empty views.
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export type World = {
  readonly root: string
  readonly home: string
  readonly userData: string
  readonly bin: string
}

type Tool = {
  readonly name: string
  readonly input: object
  readonly result?: string
  /** The call is written and nothing answers it — the agent is waiting on the person */
  readonly pending?: boolean
  /** An `Agent` call's subagent: the calls it made, written to its own log as Claude does */
  readonly subagent?: readonly Tool[]
}

type Turn = {
  readonly user?: string
  readonly say?: string
  readonly tools?: readonly Tool[]
}

const STUB = resolve(import.meta.dirname, 'stub-cli.mjs')
const HOUR = 3_600_000
const DAY = 24 * HOUR

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
const jsonl = (lines: readonly object[]): string => lines.map((l) => JSON.stringify(l)).join('\n') + '\n'

/** An empty world (first run) when `populated` is false: a home with nothing in it. */
export function buildWorld(at: string, { populated = true }: { populated?: boolean } = {}): World {
  rmSync(at, { recursive: true, force: true })
  mkdirSync(at, { recursive: true })
  // the real path, not the one asked for: macOS's tmpdir sits behind /var → /private/var,
  // and the indexer resolves repositories to real paths — a world recorded under the
  // symlink never matches them (a roundtable's repoRoot would find no repository)
  const root = realpathSync(at)
  const world: World = {
    root,
    home: join(root, 'home'),
    userData: join(root, 'user-data'),
    bin: join(root, 'bin')
  }
  mkdirSync(world.home, { recursive: true })
  mkdirSync(world.userData, { recursive: true })
  writeStubs(world)
  write(join(world.home, '.gitconfig'), '[user]\n\tname = dev\n\temail = dev@example.com\n[init]\n\tdefaultBranch = main\n')
  if (populated) populate(world)
  return world
}

/** One wrapper per CLI name, all running the same stub with the tool as its first arg. */
function writeStubs(world: World): void {
  mkdirSync(world.bin, { recursive: true })
  for (const tool of ['claude', 'codex', 'copilot', 'gh']) {
    const path = join(world.bin, tool)
    writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${STUB}" ${tool} "$@"\n`)
    chmodSync(path, 0o755)
  }
}

function populate(world: World): void {
  const now = Date.now()
  const iso = (hoursAgo: number): string => new Date(now - hoursAgo * HOUR).toISOString()
  const code = (repo: string): string => join(world.home, 'code', repo)
  const wt = (repo: string, slug: string): string => join(world.userData, 'worktrees', repo, slug)
  const git = (cwd: string, args: readonly string[], env: NodeJS.ProcessEnv = {}): void => {
    execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, HOME: world.home, ...env } })
  }

  // ---------- repositories and worktrees ----------
  const repos: [name: string, owner: string | null][] = [
    ['rocket', 'acme'],
    ['atlas', 'acme'],
    ['lumen-docs', 'lumenlabs'],
    ['infra-tools', 'acme'],
    ['scratchpad-local', null]
  ]
  for (const [name, owner] of repos) {
    const dir = code(name)
    write(join(dir, 'README.md'), `# ${name}\n`)
    write(join(dir, 'src', 'index.ts'), 'export const x = 1\n')
    git(dir, ['init', '-q', '-b', 'main'])
    if (owner) git(dir, ['remote', 'add', 'origin', `https://github.com/${owner}/${name}.git`])
    git(dir, ['add', '-A'])
    git(dir, ['commit', '-qm', 'init'])
  }
  const worktrees: [repo: string, slug: string][] = [
    ['rocket', 'login-retry-flake'],
    ['rocket', 'paginate-sessions-list'],
    ['rocket', 'dark-mode-tokens'],
    ['rocket', 'rt-sdk-layout'],
    ['atlas', 'billing-webhook-retries'],
    ['atlas', 'old-spike-graphql'],
    ['atlas', 'ghost-leftover'],
    ['lumen-docs', 'api-reference-refresh'],
    ['infra-tools', 'abandoned-terraform-bump']
  ]
  for (const [repo, slug] of worktrees) {
    mkdirSync(join(world.userData, 'worktrees', repo), { recursive: true })
    git(code(repo), ['worktree', 'add', '-q', '-b', `cockpit/${slug}`, wt(repo, slug)])
  }
  // an external worktree (Claude Code's own layout) and an uncommitted change
  git(code('rocket'), ['worktree', 'add', '-q', '-b', 'claude/hotfix-retry', join(code('rocket'), '.claude', 'worktrees', 'hotfix-retry')])
  write(join(wt('rocket', 'login-retry-flake'), 'src', 'auth', 'login.ts'), 'export const retries = 3\n')
  // abandoned work: backdated branch tips and directories, so Cleanup has something to judge
  for (const [repo, slug, days] of [['atlas', 'old-spike-graphql', 95], ['infra-tools', 'abandoned-terraform-bump', 48]] as const) {
    const when = new Date(now - days * DAY).toISOString()
    write(join(wt(repo, slug), 'NOTES.md'), 'spike notes\n')
    git(wt(repo, slug), ['add', '-A'])
    git(wt(repo, slug), ['commit', '-qm', 'wip'], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when })
    utimesSync(wt(repo, slug), (now - days * DAY) / 1000, (now - days * DAY) / 1000)
  }

  // ---------- Claude sessions ----------
  let seq = 0
  const claude = (o: {
    readonly home?: string
    readonly cwd: string
    readonly branch?: string | null
    readonly title: string
    readonly hoursAgo: number
    readonly turns: readonly Turn[]
  }): void => {
    const id = randomUUID()
    let t = o.hoursAgo
    const at = (): string => iso((t = Math.max(t - 0.02, 0.01)))
    const lines: object[] = []
    const assistant = (content: object[], tokens = 400): void => {
      seq++
      lines.push({
        type: 'assistant',
        timestamp: at(),
        requestId: `req_${seq}`,
        message: { id: `msg_${seq}`, role: 'assistant', model: 'claude-opus-4-1', content, usage: { input_tokens: 1200, output_tokens: tokens } }
      })
    }
    for (const turn of o.turns) {
      if (turn.user)
        lines.push({ type: 'user', sessionId: id, cwd: o.cwd, gitBranch: o.branch ?? null, timestamp: at(), message: { role: 'user', content: turn.user } })
      if (turn.say) assistant([{ type: 'text', text: turn.say }])
      for (const tool of turn.tools ?? []) {
        const toolId = `toolu_${++seq}`
        assistant([{ type: 'tool_use', id: toolId, name: tool.name, input: tool.input }], 80)
        if (tool.pending) continue
        // a subagent logs beside the session, named by the id its call's result carries
        const agentId = tool.subagent ? `a${seq}` : null
        if (tool.subagent && agentId) {
          const sub: object[] = []
          for (const call of tool.subagent) {
            const callId = `toolu_${++seq}`
            sub.push({ type: 'assistant', isSidechain: true, agentId, timestamp: at(), message: { role: 'assistant', content: [{ type: 'tool_use', id: callId, name: call.name, input: call.input }] } })
            sub.push({ type: 'user', isSidechain: true, agentId, timestamp: at(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: call.result ?? 'ok' }] } })
          }
          const subDir = join(o.home ?? join(world.home, '.claude'), 'projects', o.cwd.replace(/[/.]/g, '-'), id, 'subagents')
          write(join(subDir, `agent-${agentId}.jsonl`), jsonl(sub))
          write(join(subDir, `agent-${agentId}.meta.json`), JSON.stringify({ agentType: 'general-purpose', toolUseId: toolId, spawnDepth: 1 }))
        }
        lines.push({
          type: 'user',
          timestamp: at(),
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolId, content: tool.result ?? 'ok' }] },
          ...(agentId ? { toolUseResult: { status: 'completed', agentId } } : {})
        })
      }
    }
    lines.push({ type: 'ai-title', aiTitle: o.title })
    write(join(o.home ?? join(world.home, '.claude'), 'projects', o.cwd.replace(/[/.]/g, '-'), `${id}.jsonl`), jsonl(lines))
  }

  const flake = wt('rocket', 'login-retry-flake')
  claude({
    cwd: flake,
    branch: 'cockpit/login-retry-flake',
    title: 'Fix the login flake in CI',
    hoursAgo: 0.6,
    turns: [
      { user: 'The login e2e test flakes on CI roughly one run in five. Find out why and fix it — keep the change small.' },
      {
        say: 'Let me reproduce it first.',
        tools: [
          // Claude's task tools: the Work panel's to-do list, numbered by their results
          ...['Reproduce the flake', 'Fix the login timeout', 'Add a regression test', 'Open the pull request'].map((subject, i) => ({
            name: 'TaskCreate',
            input: { subject, description: subject, activeForm: subject },
            result: `Task #${i + 1} created successfully: ${subject}`
          })),
          { name: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' }, result: 'Updated task #1 status' },
          { name: 'Bash', input: { command: 'npm run test:e2e -- --grep login --repeat-each 20' }, result: '14 passed, 6 failed\n  ✘ login › retries on transient failure (TimeoutError: 800ms exceeded)' },
          { name: 'TaskUpdate', input: { taskId: '1', status: 'completed' }, result: 'Updated task #1 status' },
          { name: 'TaskUpdate', input: { taskId: '2', status: 'in_progress' }, result: 'Updated task #2 status' },
          { name: 'Read', input: { file_path: `${flake}/src/auth/login.ts` }, result: 'export async function login(creds) {\n  return client.post("/session", creds, { timeout: 800 })\n}' },
          { name: 'Grep', input: { pattern: 'timeout', path: 'src/auth' }, result: 'src/auth/login.ts:2' },
          {
            name: 'Edit',
            input: {
              file_path: `${flake}/src/auth/login.ts`,
              old_string: 'export async function login(creds) {\n  return client.post("/session", creds, { timeout: 800 })\n}',
              new_string:
                'const TIMEOUT = 5_000\n\nexport async function login(creds) {\n  return withRetry(() => client.post("/session", creds, { timeout: TIMEOUT }), { attempts: 3 })\n}'
            }
          },
          { name: 'Bash', input: { command: 'npm run test:e2e -- --grep login --repeat-each 20' }, result: '20 passed' },
          { name: 'TaskUpdate', input: { taskId: '2', status: 'completed' }, result: 'Updated task #2 status' }
        ]
      },
      { say: RICH_REPLY },
      { user: 'Yes, add the regression test. Then commit.' },
      {
        say: 'Adding a test that stubs a slow DNS resolver.',
        tools: [
          { name: 'TaskUpdate', input: { taskId: '3', status: 'in_progress' }, result: 'Updated task #3 status' },
          {
            name: 'Write',
            input: {
              file_path: `${flake}/tests/login-slow-dns.test.ts`,
              content: 'import { login } from "../src/auth/login"\n\ntest("survives a slow first lookup", async () => {\n  stubDns({ firstLookupMs: 1_200 })\n  await expect(login(creds)).resolves.toBeDefined()\n})\n'
            }
          },
          { name: 'Bash', input: { command: 'npx vitest run tests/login-slow-dns.test.ts' }, result: '✓ survives a slow first lookup (1.3s)' },
          { name: 'Bash', input: { command: 'git commit -am "fix(auth): retry transient login failures"' }, result: '[cockpit/login-retry-flake 4e1a2c9] fix(auth): retry transient login failures' },
          { name: 'TaskUpdate', input: { taskId: '3', status: 'completed' }, result: 'Updated task #3 status' }
        ]
      },
      { say: 'Committed as `4e1a2c9`. The branch is ready for a PR.' }
    ]
  })
  // the work handed to a subagent: its edits show after the call, and in the Work panel
  const paginate = wt('rocket', 'paginate-sessions-list')
  claude({
    cwd: paginate,
    branch: 'cockpit/paginate-sessions-list',
    title: 'Add pagination to the sessions list',
    hoursAgo: 3,
    turns: [
      { user: 'Add cursor pagination to the sessions list.' },
      {
        say: 'I’ll hand the query change to a subagent.',
        tools: [
          {
            name: 'Agent',
            input: { description: 'Paginate the sessions query', prompt: 'Add a cursor to listSessions.', subagent_type: 'general-purpose' },
            result: 'listSessions takes a cursor and returns 20 rows with the next cursor.',
            subagent: [
              { name: 'Read', input: { file_path: `${paginate}/src/sessions.ts` } },
              {
                name: 'Edit',
                input: {
                  file_path: `${paginate}/src/sessions.ts`,
                  old_string: 'export function listSessions() {\n  return db.all()\n}',
                  new_string: 'export function listSessions(cursor?: string) {\n  return db.page({ after: cursor, limit: 20 })\n}'
                }
              }
            ]
          }
        ]
      },
      { say: 'Done — 20 per page with a "more…" row.' }
    ]
  })
  // a terminal session that has just stopped to ask — written moments ago, so the
  // liveness tracker reads its tail and the board shows it waiting on you
  claude({
    cwd: code('rocket'),
    branch: 'main',
    title: 'Split the SDK into a monorepo layout',
    hoursAgo: 0.012,
    turns: [
      { user: 'Move the SDK into packages/ with one package per runtime.' },
      {
        say: 'Two layouts are reasonable here; the choice affects every import path.',
        tools: [
          {
            name: 'AskUserQuestion',
            input: { questions: [{ question: 'Which layout should the SDK packages use?', header: 'Layout', options: [{ label: 'packages/<runtime>' }, { label: 'sdk/<runtime>' }] }] },
            pending: true
          }
        ]
      }
    ]
  })
  // a plan waiting for approval, read in its card — old enough that nothing is live
  claude({
    cwd: code('atlas'),
    branch: 'main',
    title: 'Plan rate limiting for the public API',
    hoursAgo: 2,
    turns: [
      { user: 'Plan how we add rate limiting to the public API. Plan only — no code yet.' },
      {
        say: 'I read the gateway and its middleware chain. Here is the plan.',
        tools: [
          { name: 'Read', input: { file_path: `${code('atlas')}/src/gateway/middleware.ts` }, result: 'export const chain = [auth, cors, route]' },
          {
            name: 'ExitPlanMode',
            input: {
              plan: [
                '# Rate limiting for the public API',
                '',
                'A token bucket per API key, enforced in the gateway before routing.',
                '',
                '## Steps',
                '',
                '1. **Bucket store** — a Redis-backed bucket keyed by `key:route-group`, 100 requests a minute, burst of 20.',
                '2. **Middleware** — `rateLimit()` between `auth` and `route` in `src/gateway/middleware.ts`; answers `429` with `Retry-After`.',
                '3. **Headers** — `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset` on every response.',
                '4. **Tests** — a burst test and a refill test against a fake clock.',
                '',
                '## Out of scope',
                '',
                '- Per-user limits inside an organization',
                '- A dashboard for usage'
              ].join('\n'),
              planFilePath: join(world.home, '.claude', 'plans', 'rate-limiting.md')
            },
            pending: true
          }
        ]
      }
    ]
  })
  claude({ cwd: wt('rocket', 'dark-mode-tokens'), branch: 'cockpit/dark-mode-tokens', title: 'Extract dark-mode color tokens into a single :root block', hoursAgo: 5, turns: [{ user: 'Pull every hard-coded color into custom properties.' }, { say: 'Found 143 literals across 22 files.' }] })
  claude({ cwd: code('rocket'), branch: 'main', title: 'Why is the bundle 2MB? Audit the imports', hoursAgo: 26, turns: [{ user: 'Why is the production bundle 2MB?' }, { say: 'Moment.js with all locales is 600KB of it.' }] })
  claude({ cwd: wt('atlas', 'billing-webhook-retries'), branch: 'cockpit/billing-webhook-retries', title: 'Retry failed billing webhooks with idempotency keys', hoursAgo: 1.4, turns: [{ user: 'Retry webhooks with idempotency keys.' }, { say: 'Implemented a retry queue keyed by event id.' }] })
  claude({ cwd: code('lumen-docs'), branch: 'main', title: 'Rewrite the quickstart for the v3 SDK', hoursAgo: 30, turns: [{ user: 'Rewrite the quickstart for v3.' }, { say: 'Rewrote it around the new client constructor.' }] })
  claude({ cwd: code('scratchpad-local'), branch: 'main', title: 'Sketch a CLI for tailing logs', hoursAgo: 70, turns: [{ user: 'Sketch a CLI to tail JSON logs.' }, { say: 'Here is a 40-line Node script.' }] })
  mkdirSync(join(world.home, 'notes'), { recursive: true })
  claude({ cwd: join(world.home, 'notes'), branch: null, title: 'Explain the difference between OAuth device flow and PKCE', hoursAgo: 8, turns: [{ user: 'Device flow vs PKCE?' }, { say: 'Device flow is for input-constrained devices; PKCE protects public clients.' }] })
  claude({
    cwd: code('atlas'),
    branch: 'main',
    title: 'Migrate every package to TypeScript strict mode',
    hoursAgo: 12,
    turns: Array.from({ length: 40 }, (_, i) => ({
      user: `Step ${i + 1}: migrate module ${i + 1}.`,
      say: `Migrated module ${i + 1}. Updated imports and fixed types.`,
      tools: [{ name: 'Bash', input: { command: `npx tsc --noEmit -p packages/m${i + 1}` }, result: 'ok' }]
    }))
  })
  const work = join(world.home, '.claude-work')
  claude({ home: work, cwd: code('atlas'), branch: 'main', title: 'Review the rate limiter design doc', hoursAgo: 18, turns: [{ user: 'Review docs/rate-limiter.md.' }, { say: '1. Clock skew\n2. Hot keys\n3. No backpressure' }] })
  // stale work, for Cleanup
  claude({ cwd: wt('atlas', 'old-spike-graphql'), branch: 'cockpit/old-spike-graphql', title: 'Spike: GraphQL gateway in front of the REST API', hoursAgo: 95 * 24, turns: [{ user: 'Spike a GraphQL gateway.' }, { say: 'N+1 is the blocker.' }] })
  claude({ cwd: wt('infra-tools', 'abandoned-terraform-bump'), branch: 'cockpit/abandoned-terraform-bump', title: 'Bump terraform to 1.9 across modules', hoursAgo: 48 * 24, turns: [{ user: 'Bump terraform to 1.9.' }, { say: 'Started with the network module.' }] })
  claude({ cwd: code('lumen-docs'), branch: 'main', title: 'Convert the changelog to keep-a-changelog format', hoursAgo: 210 * 24, turns: [{ user: 'Convert CHANGELOG.md.' }, { say: 'Converted 14 releases.' }] })

  // ---------- Codex sessions ----------
  const codex = (o: { readonly cwd: string; readonly branch?: string | null; readonly hoursAgo: number; readonly items: readonly object[] }): void => {
    const id = randomUUID()
    const d = new Date(now - o.hoursAgo * HOUR)
    const dir = join(world.home, '.codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'))
    const at = iso(o.hoursAgo)
    write(
      join(dir, `rollout-${at.replace(/[:.]/g, '-')}-${id}.jsonl`),
      jsonl([
        { timestamp: at, type: 'session_meta', payload: { id, cwd: o.cwd, git: o.branch ? { branch: o.branch } : undefined } },
        { timestamp: at, type: 'turn_context', payload: { cwd: o.cwd, model: 'gpt-5-codex' } },
        ...o.items.map((payload) => ({ timestamp: at, type: 'response_item', payload })),
        {
          timestamp: at,
          type: 'event_msg',
          payload: {
            type: 'token_count',
            rate_limits: {
              primary: { used_percent: 63, window_minutes: 300, resets_at: Math.floor(now / 1000) + 5400 },
              secondary: { used_percent: 31, window_minutes: 10080, resets_at: Math.floor(now / 1000) + 300_000 },
              plan_type: 'pro'
            }
          }
        }
      ])
    )
  }
  const message = (role: string, text: string): object => ({ type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] })
  codex({
    cwd: code('rocket'),
    branch: 'main',
    hoursAgo: 0.9,
    items: [
      message('user', 'Add a fallback when the billing API is unreachable so the usage panel still renders.'),
      { type: 'reasoning', summary: [{ type: 'text', text: 'Timeouts and 403s need different copy.' }] },
      { type: 'function_call', name: 'shell', call_id: 'c1', arguments: JSON.stringify({ command: ['bash', '-lc', 'rg -n premium_request src'] }) },
      { type: 'function_call_output', call_id: 'c1', output: 'src/main/usage.ts:291' },
      message('assistant', 'Added the fallback: the panel renders the last snapshot with an "as of" stamp.')
    ]
  })
  codex({ cwd: wt('lumen-docs', 'api-reference-refresh'), branch: 'cockpit/api-reference-refresh', hoursAgo: 2.2, items: [message('user', 'Regenerate the API reference and fix broken anchors.'), message('assistant', 'Regenerated. 7 anchors were broken.')] })
  codex({ cwd: code('atlas'), branch: 'main', hoursAgo: 20, items: [message('user', 'Backfill the tenant_id column.'), message('assistant', 'Migration 0042 backfills in batches of 5k.')] })
  codex({ cwd: code('infra-tools'), branch: 'main', hoursAgo: 38 * 24, items: [message('user', 'List unused IAM roles.'), message('assistant', 'Found 11 roles unused for 90+ days.')] })

  // ---------- Copilot sessions ----------
  // `workspace` replaces the one-line name file, for a name Copilot writes another way
  const copilot = (o: { readonly cwd: string; readonly repository: string; readonly title: string; readonly hoursAgo: number; readonly events: readonly [string, object][]; readonly workspace?: string }): string => {
    const id = randomUUID()
    const dir = join(world.home, '.copilot', 'session-state', id)
    const at = iso(o.hoursAgo)
    write(
      join(dir, 'events.jsonl'),
      jsonl([
        { type: 'session.start', timestamp: at, data: { sessionId: id, startTime: at, context: { cwd: o.cwd, branch: 'main', repository: o.repository } } },
        ...o.events.map(([type, data]) => ({ type, timestamp: at, data }))
      ])
    )
    write(join(dir, 'workspace.yaml'), o.workspace ?? `name: ${o.title}\n`)
    // copilot's updatedAt is the file's mtime, not a timestamp inside it
    const t = (now - o.hoursAgo * HOUR) / 1000
    utimesSync(join(dir, 'events.jsonl'), t, t)
    return id
  }
  const tidy = copilot({
    cwd: code('rocket'),
    repository: 'acme/rocket',
    title: 'Tidy the usage panel spacing',
    hoursAgo: 1.1,
    events: [
      ['user.message', { content: 'Tidy the usage panel spacing, it feels cramped.' }],
      ['tool.execution_start', { toolName: 'sql', arguments: { description: 'Plan the spacing pass', query: "INSERT INTO todos (id, title) VALUES ('lint', 'Lint the usage panel'), ('gap', 'Widen the grid gap'), ('shot', 'Screenshot for the design review')" } }],
      ['tool.execution_start', { toolName: 'bash', arguments: { command: 'npm run lint -- src/usage' } }],
      ['tool.execution_start', { toolName: 'edit', arguments: { path: `${code('rocket')}/src/usage.tsx`, old_str: 'gap: 4px', new_str: 'gap: 8px' } }],
      ['tool.execution_start', { toolName: 'sql', arguments: { description: 'Advance the spacing pass', query: "UPDATE todos SET status = CASE id WHEN 'shot' THEN 'blocked' ELSE 'done' END" } }],
      ['assistant.message', { content: 'Increased the grid gap and padded the meters. The screenshot waits on the design tokens landing.', model: 'claude-sonnet-4.5' }]
    ]
  })
  // Copilot keeps its to-dos in the session's own database, not its log
  const todos = new DatabaseSync(join(world.home, '.copilot', 'session-state', tidy, 'session.db'))
  todos.exec(
    "CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'done', 'blocked')));" +
      "INSERT INTO todos (id, title, status) VALUES ('lint', 'Lint the usage panel', 'done'), ('gap', 'Widen the grid gap', 'done'), ('shot', 'Screenshot for the design review', 'blocked');"
  )
  todos.close()
  const spans = copilot({ cwd: code('atlas'), repository: 'acme/atlas', title: 'Add OpenTelemetry spans to the job runner', hoursAgo: 7, events: [['user.message', { content: 'Add spans around each job.' }], ['assistant.message', { content: 'Wrapped runJob in a span.' }]] })
  // a session that one started for a piece of its work: the Copilot app names it after
  // its kickoff prompt, as a block scalar, and the kickoff states who created it — the
  // tree hangs it under the session above
  const retryPrompt = 'Instrument the retry queue with the same spans as the job runner.'
  copilot({
    cwd: code('atlas'),
    repository: 'acme/atlas',
    title: retryPrompt,
    hoursAgo: 6,
    workspace: `name: |-\n  ${retryPrompt}\n  Keep the attribute names identical so one dashboard covers both.\nuser_named: false\n`,
    events: [
      ['user.message', { content: retryPrompt, transformedContent: `<copilot_tauri_workspace>\nproject_name: atlas\ncreator_chat_session_id: ${spans}\n</copilot_tauri_workspace>\n\n${retryPrompt}` }],
      ['assistant.message', { content: 'Added spans around enqueue and each retry attempt.' }]
    ]
  })
  copilot({ cwd: code('lumen-docs'), repository: 'lumenlabs/lumen-docs', title: 'Fix typos in the tutorials', hoursAgo: 55 * 24, events: [['user.message', { content: 'Fix typos.' }], ['assistant.message', { content: 'Fixed 23 typos.' }]] })

  // ---------- accounts ----------
  const b64 = (o: object): string => Buffer.from(JSON.stringify(o)).toString('base64url')
  write(
    join(world.home, '.claude.json'),
    JSON.stringify({
      oauthAccount: { emailAddress: 'dev@example.com' },
      mcpServers: {
        github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'] },
        linear: { type: 'sse', url: 'https://mcp.linear.app/sse' },
        // pinned on purpose: a pinned server is the only one that can have a newer
        // release, so this is the row the version chip shows up on
        playwright: { command: 'npx', args: ['@playwright/mcp@0.0.78'] }
      },
      projects: { [code('rocket')]: { mcpServers: { 'rocket-db': { command: 'node', args: ['scripts/db-mcp.js'] } } } }
    })
  )
  write(join(work, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'dev@work.example.org' } }))
  // codex's own model catalog — what the roundtable model picker lists for a codex seat
  write(
    join(world.home, '.codex', 'models_cache.json'),
    JSON.stringify({
      models: [
        { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', description: 'Frontier coding model', visibility: 'list', priority: 1 },
        { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', description: 'Fast and light', visibility: 'list', priority: 2 },
        { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', priority: 3 },
        { slug: 'codex-auto-review', display_name: 'Auto review', visibility: 'hide', priority: 9 }
      ]
    })
  )
  write(join(world.home, '.codex', 'auth.json'), JSON.stringify({ tokens: { id_token: `${b64({ alg: 'none' })}.${b64({ email: 'dev@example.com' })}.x` } }))
  write(
    join(world.home, '.copilot', 'config.json'),
    JSON.stringify({
      lastLoggedInUser: { host: 'https://github.com', login: 'octo-dev' },
      loggedInUsers: [{ host: 'https://github.com', login: 'octo-dev' }, { host: 'https://github.com', login: 'octo-work' }]
    })
  )

  // ---------- agent config, with deliberate drift ----------
  write(
    join(world.home, '.codex', 'config.toml'),
    '[mcp_servers.github]\ncommand = "npx"\nargs = ["-y", "@modelcontextprotocol/server-github"]\n\n' +
      '[mcp_servers.playwright]\ncommand = "npx"\nargs = ["@playwright/mcp@0.0.78"]\n\n' +
      '[plugins."review@acme-market"]\nenabled = true\n\n[marketplaces.acme-market]\nsource = "acme/agent-plugins"\n\n' +
      // a marketplace that ships inside codex: nothing another agent could add, so
      // its plugin's other two chips read "not available" rather than offering an
      // install that would fail
      '[plugins."scratchpad@codex-bundled"]\nenabled = true\n\n[marketplaces.codex-bundled]\n' +
      `source_type = "local"\nsource = "${join(world.home, '.codex', '.tmp', 'bundled')}"\n`
  )
  // copilot's github server differs (--read-only): a "differs" row
  write(
    join(world.home, '.copilot', 'mcp-config.json'),
    JSON.stringify({
      mcpServers: {
        github: { type: 'local', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github', '--read-only'], tools: ['*'] },
        sentry: { type: 'http', url: 'http://127.0.0.1:9/mcp' }
      }
    })
  )
  const skill = (agent: string, name: string, extra = ''): void =>
    write(join(world.home, `.${agent}`, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name.replace(/-/g, ' ')}\n---\n\n# ${name}\n${extra}`)
  skill('claude', 'release-notes')
  skill('codex', 'release-notes')
  skill('copilot', 'release-notes', '\nLocal edit: include contributor handles.')
  skill('claude', 'db-migrations')
  skill('claude', 'incident-review')
  skill('codex', 'incident-review')
  write(join(world.home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'review@acme-market': [{ version: '1.2.0' }] } }))
  write(join(world.home, '.claude', 'plugins', 'known_marketplaces.json'), JSON.stringify({ 'acme-market': { source: { source: 'github', repo: 'acme/agent-plugins' } } }))
  // instructions: one file in sync, one out of date, one without the block
  const S = '<!-- cockpit:shared:start -->'
  const E = '<!-- cockpit:shared:end -->'
  const baseline = '# Team rules\n\n- Conventional Commits, imperative subject\n- Run the tests before every commit\n- Never commit secrets'
  write(join(world.home, '.claude', 'CLAUDE.md'), `# My notes\n\n${S}\n${baseline}\n${E}\n`)
  write(join(world.home, '.codex', 'AGENTS.md'), `${S}\n# Team rules\n\n- Conventional Commits\n${E}\n`)
  write(join(world.home, '.copilot', 'copilot-instructions.md'), '# Copilot\n\nBe concise.\n')

  // ---------- roundtables ----------
  const table = (o: Record<string, unknown> & { readonly id: string; readonly cwd: string }): void => {
    write(join(world.userData, 'roundtables', `${o.id}.json`), JSON.stringify(o, null, 2))
    mkdirSync(o.cwd, { recursive: true })
  }
  const t0 = now - 4 * HOUR
  table({
    id: 'rt-consensus',
    title: 'Should usage polling move to the main process?',
    topic: 'Should usage polling move to the main process?',
    createdAt: t0,
    updatedAt: t0 + 700_000,
    cwd: join(world.userData, 'roundtables', 'rt-consensus', 'room'),
    repoRoot: null,
    branch: null,
    permissionMode: 'safe',
    mode: 'consensus',
    maxRounds: 3,
    roundsRun: 2,
    concluded: true,
    participants: [
      { provider: 'claude', nativeSessionId: null, seenUpTo: 5 },
      { provider: 'codex', nativeSessionId: null, seenUpTo: 5 },
      { provider: 'copilot', nativeSessionId: null, seenUpTo: 5 }
    ],
    entries: [
      { speaker: 'user', text: 'Should usage polling move to the main process?', at: t0 },
      { speaker: 'claude', seat: 0, text: 'Main owns every other IO path; the open question is cache lifetime.', at: t0 + 60_000, stance: 'continue', stanceNote: 'need a TTL story first' },
      { speaker: 'codex', seat: 1, text: 'Moving it is right; add a **60s TTL**.', at: t0 + 90_000, stance: 'continue', stanceNote: 'push vs pull undecided' },
      { speaker: 'copilot', seat: 2, text: 'Pull with a TTL is simpler.', at: t0 + 120_000, stance: 'continue', stanceNote: 'prefer pull + TTL' },
      { speaker: 'claude', seat: 0, text: 'Pull + a 60s TTL in main settles it.', at: t0 + 600_000, stance: 'agree', stanceNote: 'main-side poll, 60s TTL, pull' },
      { speaker: 'codex', seat: 1, text: 'Fine with pull.', at: t0 + 650_000, stance: 'agree', stanceNote: 'one cache in main, 60s TTL' },
      { speaker: 'copilot', seat: 2, text: 'Agreed.', at: t0 + 700_000, stance: 'agree', stanceNote: 'pull + TTL in main' }
    ]
  })
  // an archived table: out of the tree's children and off the board, reachable from
  // the group's Archived disclosure (see the archivedRoundtables id below)
  // stale as well as archived: it is what Cleanup's Roundtables section lists
  const tArch = now - 40 * DAY
  table({
    id: 'rt-archived',
    title: 'Ship a plugin marketplace of our own?',
    topic: 'Ship a plugin marketplace of our own?',
    createdAt: tArch,
    updatedAt: tArch + 400_000,
    cwd: join(world.userData, 'roundtables', 'rt-archived', 'room'),
    repoRoot: null,
    branch: null,
    permissionMode: 'safe',
    mode: 'open',
    maxRounds: 3,
    roundsRun: 1,
    concluded: false,
    participants: [
      { provider: 'claude', nativeSessionId: null, seenUpTo: 2 },
      { provider: 'copilot', nativeSessionId: null, seenUpTo: 2 }
    ],
    entries: [
      { speaker: 'user', text: 'Do we need our own marketplace?', at: tArch },
      { speaker: 'claude', seat: 0, text: 'Not before 1.0 — the agents already read directories.', at: tArch + 60_000 }
    ]
  })
  const t1 = now - 26 * HOUR
  table({
    id: 'rt-open',
    title: 'Monorepo or polyrepo for the SDKs?',
    topic: 'Monorepo or polyrepo for the SDKs?',
    createdAt: t1,
    updatedAt: t1 + 1_200_000,
    cwd: wt('rocket', 'rt-sdk-layout'),
    repoRoot: code('rocket'),
    branch: 'cockpit/rt-sdk-layout',
    permissionMode: 'safe',
    mode: 'open',
    maxRounds: 3,
    roundsRun: 1,
    concluded: false,
    participants: [
      { provider: 'claude', nativeSessionId: null, seenUpTo: 3 },
      { provider: 'codex', nativeSessionId: null, seenUpTo: 3 }
    ],
    entries: [
      { speaker: 'user', text: 'Monorepo or one repo per SDK?', at: t1 },
      { speaker: 'claude', seat: 0, text: 'Monorepo: shared spec, one CI, atomic changes.', at: t1 + 60_000 },
      { speaker: 'codex', seat: 1, text: 'Polyrepo keeps each ecosystem idiomatic.', at: t1 + 120_000 },
      { speaker: 'codex', seat: 1, text: 'codex exited with code 1', at: t1 + 1_200_000, error: true }
    ]
  })

  // ---------- cockpit's own config ----------
  write(
    join(world.userData, 'cockpit-config.json'),
    JSON.stringify({
      sources: [
        { path: join(world.home, '.claude'), provider: 'claude', label: 'claude-default' },
        { path: work, provider: 'claude', label: 'claude-work' },
        { path: join(world.home, '.codex'), provider: 'codex', label: 'codex-default' },
        { path: join(world.home, '.copilot'), provider: 'copilot', label: 'copilot-default' }
      ],
      archived: [],
      archivedRoundtables: ['rt-archived'],
      hiddenRepos: [],
      historyDays: 0,
      staleDays: 30,
      sharedInstructions: { global: baseline, repos: {} },
      // switched on for every agent while only claude has it: a "not applied" row
      library: { global: [{ kind: 'mcp', name: 'linear', enabled: { claude: true, codex: true, copilot: true }, config: { url: 'https://mcp.linear.app/sse', type: 'sse' } }], repos: {} },
      modelEndpoints: [
        { id: 'ep-local', label: 'Local vLLM', type: 'openai', baseUrl: 'http://127.0.0.1:9/v1', wireApi: 'responses', models: ['qwen3-coder-30b', 'llama-3.3-70b'] },
        { id: 'ep-gateway', label: 'Team gateway', type: 'anthropic', baseUrl: 'https://llm-gateway.example.org', models: [] }
      ]
    }, null, 2)
  )
}

const RICH_REPLY = `I traced the flake to the retry loop in \`src/auth/login.ts\`. The client gives up after **one** attempt, and the CI runner's cold DNS lookup regularly takes longer than the 800ms budget.

## What changed

1. Raised the retry budget from 1 to 3 attempts
2. Added exponential backoff (200ms → 400ms → 800ms) with jitter
3. Made the timeout configurable via \`LOGIN_TIMEOUT_MS\`

\`\`\`ts
export async function login(creds: Credentials, opts: RetryOpts = {}): Promise<Session> {
  const { retries = 3, backoff = 200 } = opts
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await client.post('/session', creds, { timeout: TIMEOUT })
    } catch (err) {
      if (!isTransient(err) || attempt === retries) throw err
      await sleep(backoff * 2 ** attempt)
    }
  }
  throw new Error('unreachable')
}
\`\`\`

| Run | Before | After |
|---|---|---|
| Local, warm | 20/20 | 20/20 |
| CI, cold cache | 14/20 | 20/20 |
| CI, throttled network | 9/20 | 19/20 |

> The one remaining failure under throttling is a genuine 30s timeout from the mock server — not the retry loop.

Want me to also add a regression test that simulates the slow DNS path?`
