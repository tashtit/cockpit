import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page
} from '@playwright/test'

const mainEntry = resolve('out/main/index.js')
if (!existsSync(mainEntry)) {
  throw new Error('out/main/index.js missing — run `npm run build` before `npm run test:e2e`')
}

// Hermetic fixture world: a fake git repo, a fake Claude source dir whose session
// logs point at it, and a pre-seeded cockpit-config.json so the indexer walks only
// these fixtures — never this machine's real ~/.claude.
const root = mkdtempSync(join(tmpdir(), 'cockpit-e2e-pages-'))
const userData = join(root, 'user-data')
const claudeSrc = join(root, 'claude-home')
const repoDir = join(root, 'rocket')
const noRepoCwd = join(root, 'no-repo')

function jsonl(objs: unknown[]): string {
  return objs.map((o) => JSON.stringify(o)).join('\n') + '\n'
}

function writeClaudeSession(
  id: string,
  cwd: string,
  prompt: string,
  reply: string,
  ts: string
): void {
  const dir = join(claudeSrc, 'projects', 'p')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `${id}.jsonl`),
    jsonl([
      {
        type: 'user',
        message: { role: 'user', content: prompt },
        timestamp: ts,
        sessionId: id,
        cwd,
        gitBranch: 'main'
      },
      { type: 'assistant', message: { role: 'assistant', content: reply }, timestamp: ts }
    ])
  )
}

let app: ElectronApplication
let win: Page

test.beforeAll(async () => {
  mkdirSync(join(repoDir, '.git'), { recursive: true })
  writeFileSync(
    join(repoDir, '.git', 'config'),
    '[remote "origin"]\n\turl = https://github.com/acme/rocket.git\n'
  )
  mkdirSync(noRepoCwd, { recursive: true })

  // recent timestamps keep the fixtures inside any history window
  const hoursAgo = (n: number): string => new Date(Date.now() - n * 3_600_000).toISOString()
  writeClaudeSession('e2e-login', repoDir, 'fix the login flake', 'Patched the retry loop.', hoursAgo(2))
  writeClaudeSession('e2e-paging', repoDir, 'add pagination to the sessions list', 'Paged it.', hoursAgo(1))
  writeClaudeSession('e2e-scratch', noRepoCwd, 'scratch ideas with no repository', 'Noted.', hoursAgo(3))

  mkdirSync(userData, { recursive: true })
  writeFileSync(
    join(userData, 'cockpit-config.json'),
    JSON.stringify({
      sources: [{ path: claudeSrc, provider: 'claude', label: 'e2e-claude' }],
      archived: []
    })
  )

  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      COCKPIT_USER_DATA: userData,
      // CI linux runners restrict unprivileged user namespaces; no SUID helper either
      ...(process.env.CI ? { ELECTRON_DISABLE_SANDBOX: '1' } : {})
    }
  })
  win = await app.firstWindow()
})

test.afterAll(async () => {
  // graceful close occasionally hangs under xvfb on linux CI — bound it with a
  // hard kill so teardown can never eat the 60s hook timeout and fail the run
  const kill = setTimeout(() => app.process().kill('SIGKILL'), 15_000)
  await app.close().catch(() => {})
  clearTimeout(kill)
})

// the heading may carry the gh login ("What should we ship, dev?") — match the stem
const homeHeading = (): Locator => win.getByRole('heading', { name: /What should we ship/ })

test('sidebar indexes the fixtures into a repo tree with a flat Chats section', async () => {
  await expect(win.getByRole('treeitem', { name: /acme\/\s*rocket/ })).toBeVisible()
  // the first repo starts expanded, so its sessions are already rows in the tree
  await expect(win.getByRole('treeitem', { name: /fix the login flake/ })).toBeVisible()
  await expect(win.getByRole('treeitem', { name: /add pagination to the sessions list/ })).toBeVisible()
  // repo-less sessions land under Chats, not a faux repo row
  const chats = win.getByRole('treeitem', { name: /Chats/ })
  await expect(chats).toBeVisible()
  await expect(win.getByRole('treeitem', { name: /scratch ideas with no repository/ })).toBeVisible()
})

test('home composer wires repo, agent, and permission controls', async () => {
  await expect(homeHeading()).toBeVisible()
  await expect(win.getByLabel('Task description')).toBeVisible()
  // the repo select resolves to the indexed GitHub repo (exact: 'Repository' is
  // also a substring of the "…no repository" session title in recent activity)
  await expect(win.getByRole('button', { name: 'Repository', exact: true })).toContainText(
    'acme/rocket'
  )
  const agents = win.getByRole('group', { name: 'Agent' })
  await expect(agents.getByRole('button', { name: 'Claude' })).toHaveAttribute('aria-pressed', 'true')
  await expect(agents.getByRole('button', { name: 'Codex' })).toHaveAttribute('aria-pressed', 'false')
  await expect(agents.getByRole('button', { name: 'Copilot' })).toHaveAttribute('aria-pressed', 'false')
  await expect(win.getByRole('button', { name: 'Permission mode' })).toBeVisible()
  // fixture sessions surface on the board (idle fixtures = "all on the ground")
  const board = win.locator('.board')
  await expect(board.getByText('all on the ground')).toBeVisible()
  await expect(board.getByText('add pagination to the sessions list')).toBeVisible()
  await expect(board.getByText('scratch ideas with no repository')).toBeVisible()
})

test('sidebar search filters sessions and clearing restores the tree', async () => {
  const search = win.getByLabel('Search sessions')
  await search.fill('login')
  await expect(win.getByRole('treeitem', { name: /fix the login flake/ })).toBeVisible()
  await expect(win.getByRole('treeitem', { name: /add pagination/ })).toBeHidden()
  await expect(win.getByRole('treeitem', { name: /acme\/\s*rocket/ })).toBeHidden()
  await search.fill('')
  await expect(win.getByRole('treeitem', { name: /acme\/\s*rocket/ })).toBeVisible()
})

test('settings lists the seeded source with its session count', async () => {
  await win.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(win.getByRole('heading', { name: 'Settings' })).toBeVisible()
  // the usage section reuses .source-row markup for the same label — the sources
  // row is the one that shows the indexed directory path
  const source = win.locator('.source-row', { hasText: claudeSrc })
  await expect(source).toBeVisible()
  await expect(source).toContainText('e2e-claude')
  // all three fixture sessions counted for this source
  await expect(source.locator('.repo-count')).toHaveText('3')
  await expect(source.getByRole('button', { name: /^Remove source e2e-claude/ })).toBeVisible()
  // display preferences are present with live controls
  await expect(win.getByRole('button', { name: 'Show sessions from' })).toBeVisible()
  await expect(win.getByRole('button', { name: 'Time format' })).toBeVisible()
  await win.getByRole('button', { name: 'Close' }).click()
  await expect(homeHeading()).toBeVisible()
})

test('ai setup shows its five tabs and switches panels', async () => {
  await win.getByRole('button', { name: 'AI Setup' }).click()
  await expect(win.getByRole('heading', { name: 'AI Setup' })).toBeVisible()
  const tabs = win.getByRole('tablist', { name: 'AI Setup sections' })
  for (const label of ['Instructions', 'MCP Servers', 'Skills', 'Plugins', 'Marketplace']) {
    await expect(tabs.getByRole('tab', { name: label })).toBeVisible()
  }
  await expect(tabs.getByRole('tab', { name: 'Instructions' })).toHaveAttribute('aria-selected', 'true')
  await tabs.getByRole('tab', { name: 'MCP Servers' }).click()
  await expect(tabs.getByRole('tab', { name: 'MCP Servers' })).toHaveAttribute('aria-selected', 'true')
  await expect(win.getByRole('tabpanel')).toBeVisible()
  // Escape backs out of secondary views — no chat is open yet, so back home
  await win.keyboard.press('Escape')
  await expect(homeHeading()).toBeVisible()
})

test('new session form offers project, agent, branch, and task controls', async () => {
  // row actions are display:none until the row is hovered or holds focus; the
  // real cursor position makes synthetic :hover flaky in a headed window, so use
  // the keyboard path — :focus-within reveals the same buttons deterministically
  await win.getByRole('treeitem', { name: /acme\/\s*rocket/ }).focus()
  await win.getByRole('button', { name: 'New session in rocket' }).click()
  await expect(win.getByRole('heading', { name: 'New session' })).toBeVisible()
  // exact: 'Project' is also a substring of the sidebar's "Choose projects…"
  await expect(win.getByRole('button', { name: 'Project', exact: true })).toContainText(
    'acme/rocket'
  )
  const agents = win.getByRole('group', { name: 'Agent' })
  await expect(agents.getByRole('button', { name: /Claude/ })).toHaveAttribute('aria-pressed', 'true')
  await expect(win.getByLabel('Model')).toBeVisible()
  await expect(win.getByRole('button', { name: 'Permissions' })).toBeVisible()
  // worktree branch input carries the enforced cockpit/ prefix
  await expect(win.getByText('cockpit/', { exact: true })).toBeVisible()
  await expect(win.getByLabel('Branch')).toHaveAttribute('placeholder', 'auto-generated')
  // start arms only once there is a task — and we never actually start an agent here
  const start = win.getByRole('button', { name: 'Start session' })
  await expect(start).toBeDisabled()
  await win.getByLabel('Task', { exact: true }).fill('write a readme')
  await expect(start).toBeEnabled()
  await win.getByLabel('Task', { exact: true }).fill('')
  await win.getByRole('button', { name: 'Cancel' }).click()
  await expect(homeHeading()).toBeVisible()
})

test('opening a session lands in chat with its parsed transcript', async () => {
  const row = win.getByRole('treeitem', { name: /fix the login flake/ })
  await row.click()
  await expect(row).toHaveAttribute('aria-selected', 'true')
  // header identifies provider, title, branch, and the session's cwd
  await expect(win.locator('.chat-title')).toHaveText('fix the login flake')
  await expect(win.locator('.chat-header .badge')).toHaveText(/Claude/)
  await expect(win.locator('.chat-header .branch-chip')).toContainText('main')
  await expect(win.locator('.chat-cwd')).toHaveText(repoDir)
  // transcript parsed from the session log on disk
  const messages = win.locator('.messages')
  await expect(messages.getByText('fix the login flake')).toBeVisible()
  await expect(messages.getByText('Patched the retry loop.')).toBeVisible()
  // composer is live but idle: send stays disabled until there is a draft
  const composer = win.getByLabel('Message Claude')
  const send = win.getByRole('button', { name: 'Send' })
  await expect(send).toBeDisabled()
  await composer.fill('draft that must never be sent')
  await expect(send).toBeEnabled()
  await composer.fill('')
})

test('keyboard routing: settings shortcut, Escape back to chat, new-task shortcut', async () => {
  // re-open the chat so this test stands alone if the previous one failed
  await win.getByRole('treeitem', { name: /fix the login flake/ }).click()
  await expect(win.locator('.chat-title')).toHaveText('fix the login flake')
  await win.keyboard.press('ControlOrMeta+,')
  await expect(win.getByRole('heading', { name: 'Settings' })).toBeVisible()
  // with a chat bound, Escape returns to it rather than home
  await win.keyboard.press('Escape')
  await expect(win.locator('.chat-title')).toHaveText('fix the login flake')
  await win.keyboard.press('ControlOrMeta+n')
  await expect(homeHeading()).toBeVisible()
})
