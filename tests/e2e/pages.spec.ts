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
  // the rail's always-visible entry point
  await expect(win.getByRole('button', { name: 'New task' })).toBeVisible()
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
  // the repo select resolves to the indexed GitHub repo. A Select trigger's accessible
  // name is "<label> <current value>", so anchoring the regex at the label both scopes
  // the query (plain 'Repository' also matches the "…no repository" session title on the
  // board) and asserts the selected option is actually announced.
  await expect(win.getByRole('button', { name: /^Repository acme\/rocket$/ })).toBeVisible()
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
  const gear = win.getByRole('button', { name: 'Settings', exact: true })
  await gear.click()
  await expect(win.getByRole('heading', { name: 'Settings' })).toBeVisible()
  // the open view's nav icon is marked current; re-clicking it toggles back out
  await expect(gear).toHaveAttribute('aria-current', 'page')
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
  await gear.click()
  await expect(homeHeading()).toBeVisible()
  await expect(gear).not.toHaveAttribute('aria-current', 'page')
})

test('profile aggregates the fixture sessions into a heatmap', async () => {
  await win.getByRole('button', { name: 'Profile', exact: true }).click()
  await expect(win.getByRole('heading', { name: 'Profile' })).toBeVisible()
  // the three seeded claude sessions are counted across every agent
  const stats = win.locator('.pv-stats')
  await expect(stats).toContainText('sessions')
  await expect(stats).toContainText('active days')
  // the heatmap renders as one labelled graphic with a dense grid of days
  await expect(win.getByRole('img', { name: /activity over the last \d+ days/i })).toBeVisible()
  expect(await win.locator('.pv-grid .pv-sq').count()).toBeGreaterThan(0)
  // the per-agent breakdown is the view's reason to exist
  await expect(win.locator('.pv-agent')).not.toHaveCount(0)
  await win.getByRole('button', { name: 'Close' }).click()
  await expect(homeHeading()).toBeVisible()
})

test('agents view opens on the panel, with sections as its only navigation', async () => {
  await win.getByRole('button', { name: 'Agents', exact: true }).click()
  await expect(win.getByRole('heading', { name: 'Agents' })).toBeVisible()
  // the panel reads the fixture agent homes — it must render, not sit on its
  // loading line or throw (the sections only appear once a scope has loaded)
  const sections = win.getByRole('tablist', { name: 'Sections' })
  await expect(sections.getByRole('tab', { name: /^Instructions/ })).toBeVisible()
  // scope is the one control above the panel; there is no second tab bar
  await expect(win.getByRole('tablist', { name: 'Agents sections' })).toHaveCount(0)
  // Escape backs out of secondary views — no chat is open yet, so back home
  await win.keyboard.press('Escape')
  await expect(homeHeading()).toBeVisible()
})

test('agents view scopes to a project, and says what a repo cannot carry', async () => {
  await win.getByRole('button', { name: 'Agents', exact: true }).click()
  await expect(win.getByText(/every session, in every repo/)).toBeVisible()
  await win.getByText('A project…').click()
  await win.getByRole('option', { name: /rocket/ }).click()
  await expect(win.getByText(/Applies to sessions in/)).toBeVisible()
  await expect(win.getByText(/installed per machine/)).toBeVisible()
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
  // anchored: bare 'Project' also matches the sidebar's "Choose projects…" button, and
  // the trailing value asserts the Select announces its selection, not just its label
  await expect(win.getByRole('button', { name: /^Project acme\/rocket$/ })).toBeVisible()
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

// placed late on purpose: activating a session binds a chat, and the earlier
// close/cancel tests assert an Escape/Close with no binding returns home
test('⌘K palette jumps to sessions, repos, and views', async () => {
  await win.keyboard.press('ControlOrMeta+k')
  const palette = win.getByRole('dialog', { name: 'Jump to' })
  await expect(palette).toBeVisible()
  const input = palette.getByRole('combobox')
  await expect(input).toBeFocused()
  // empty query = the board in miniature (recent fixtures) + navigation
  await expect(palette.getByRole('option', { name: /fix the login flake/ })).toBeVisible()
  await expect(palette.getByRole('option', { name: 'Settings' })).toBeVisible()
  // Escape closes without navigating anywhere
  await win.keyboard.press('Escape')
  await expect(palette).toBeHidden()
  await expect(homeHeading()).toBeVisible()
  // query mode: repos offer a launch, views match on keywords, Enter takes the top hit
  await win.keyboard.press('ControlOrMeta+k')
  await input.fill('rocket')
  await expect(palette.getByRole('option', { name: 'New session in acme/rocket' })).toBeVisible()
  await input.fill('skills')
  await expect(palette.getByRole('option', { name: 'Agents' })).toBeVisible()
  await input.fill('login')
  await expect(palette.getByRole('option', { name: /fix the login flake/ })).toBeVisible()
  await win.keyboard.press('Enter')
  await expect(palette).toBeHidden()
  await expect(win.locator('.chat-title')).toHaveText('fix the login flake')
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
  // New task while already home exercises the explicit refocus path (no remount)
  await win.getByRole('button', { name: 'New task' }).click()
  await expect(win.getByLabel('Task description')).toBeFocused()
})

test('the window minimum is enforced and every surface holds at exactly that size', async () => {
  // the floor is a contract: the BrowserWindow minima in src/main/index.ts and
  // this audit change together, or this line fails
  const min = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getMinimumSize())
  expect(min).toEqual([560, 420])

  await win.setViewportSize({ width: 560, height: 420 })
  /** Anything escaping the window or overflowing its chrome row is a regression. */
  const audit = (): Promise<string[]> =>
    win.evaluate(() => {
      const bad: string[] = []
      if (document.documentElement.scrollWidth > window.innerWidth + 1)
        bad.push(`document scrolls horizontally (${document.documentElement.scrollWidth})`)
      for (const el of Array.from(document.querySelectorAll('*'))) {
        const r = el.getBoundingClientRect()
        if (r.width > 0 && (r.right > window.innerWidth + 1.5 || r.left < -1.5))
          bad.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} escapes the window`)
      }
      for (const sel of ['.tree-top', '.search-row', '.chat-header', '.composer-bar', '.sidebar-footer']) {
        const el = document.querySelector(sel)
        if (el && el.scrollWidth > el.clientWidth + 1) bad.push(`${sel} overflows its row`)
      }
      return [...new Set(bad)]
    })

  await win.keyboard.press('ControlOrMeta+n')
  await expect(win.getByRole('button', { name: /^Start with/ })).toBeVisible()
  expect(await audit()).toEqual([])

  await win.keyboard.press('ControlOrMeta+k')
  await expect(win.getByRole('dialog', { name: 'Jump to' })).toBeVisible()
  expect(await audit()).toEqual([])
  await win.keyboard.press('Escape')

  // five tabs must wrap inside the narrow card, never overflow it
  await win.getByRole('button', { name: 'Agents', exact: true }).click()
  await expect(win.getByRole('heading', { name: 'Agents' })).toBeVisible()
  expect(await audit()).toEqual([])

  await win.getByRole('treeitem', { name: /fix the login flake/ }).click()
  await expect(win.getByRole('button', { name: 'Send' })).toBeVisible()
  expect(await audit()).toEqual([])

  await win.setViewportSize({ width: 1100, height: 728 })
})
