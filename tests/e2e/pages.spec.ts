import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
import { closeApp } from './close-app'
import { launchEnv } from './launch-env'

const mainEntry = resolve('out/main/index.js')
if (!existsSync(mainEntry)) {
  throw new Error('out/main/index.js missing — run `npm run build` before `npm run test:e2e`')
}

// Hermetic fixture world: a fake git repo, fake Claude and Codex source dirs whose session
// logs point at it, and a pre-seeded cockpit-config.json so the indexer walks only
// these fixtures — never this machine's real ~/.claude.
const root = mkdtempSync(join(tmpdir(), 'cockpit-e2e-pages-'))
const userData = join(root, 'user-data')
const claudeSrc = join(root, 'claude-home')
const codexSrc = join(root, 'codex-home')
const repoDir = join(root, 'rocket')
const noRepoCwd = join(root, 'no-repo')
const fakeBin = join(root, 'bin')

/**
 * A stand-in `gh`, first on the app's PATH: the fixtures' branch carries an open
 * PR whose checks fail, whose review asks for changes and whose unresolved threads
 * run to two digits — the widest a PR badge ever gets. `pr list` and the
 * thread-count `api graphql` answer; everything else exits non-zero, which is what
 * a machine without gh looks like. Without this the run would ask this machine's
 * real gh (or none at all), and the minimum-window audit below would never see a badge.
 */
const FAKE_PR = JSON.stringify([
  {
    number: 42,
    title: 'Fix the login flake',
    state: 'OPEN',
    isDraft: false,
    headRefName: 'main',
    url: 'https://github.com/acme/rocket/pull/42',
    reviewDecision: 'CHANGES_REQUESTED',
    statusCheckRollup: [
      { __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' },
      { __typename: 'CheckRun', status: 'IN_PROGRESS', conclusion: null }
    ]
  }
])
const FAKE_THREADS = JSON.stringify({
  data: {
    repository: {
      pullRequests: {
        nodes: [{ number: 42, reviewThreads: { nodes: Array.from({ length: 12 }, () => ({ isResolved: false })) } }]
      }
    }
  }
})

function writeFakeGh(): void {
  mkdirSync(fakeBin, { recursive: true })
  const gh = join(fakeBin, 'gh')
  writeFileSync(
    gh,
    `#!/bin/sh\ncase "$1 $2" in\n` +
      `  "pr list") cat <<'JSON'\n${FAKE_PR}\nJSON\n  ;;\n` +
      // the badges' count query only — the review panel's pullRequest(number:) query still fails
      `  "api graphql") case "$*" in\n    *'pullRequests('*) cat <<'JSON'\n${FAKE_THREADS}\nJSON\n    ;;\n    *) exit 1 ;;\n  esac ;;\n` +
      `  *) exit 1 ;;\nesac\n`
  )
  chmodSync(gh, 0o755)
}

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
  // one Codex rollout carrying a rate-limit snapshot, so Settings renders usage meters
  // (their fixed-width columns are what outgrew the card at the window floor)
  const rollout = join(codexSrc, 'sessions', '2026', '01', '01', 'rollout-e2e-codex.jsonl')
  mkdirSync(join(rollout, '..'), { recursive: true })
  const resetsAt = Math.floor(Date.now() / 1000) + 3600
  writeFileSync(
    rollout,
    jsonl([
      { timestamp: hoursAgo(4), type: 'session_meta', payload: { id: 'e2e-codex', cwd: repoDir } },
      {
        timestamp: hoursAgo(4),
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'tidy the build script' }] }
      },
      {
        timestamp: hoursAgo(4),
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            primary: { used_percent: 63, window_minutes: 300, resets_at: resetsAt },
            secondary: { used_percent: 31, window_minutes: 10080, resets_at: resetsAt + 86_400 }
          }
        }
      }
    ])
  )

  writeFakeGh()
  mkdirSync(userData, { recursive: true })
  writeFileSync(
    join(userData, 'cockpit-config.json'),
    JSON.stringify({
      sources: [
        { path: claudeSrc, provider: 'claude', label: 'e2e-claude' },
        { path: codexSrc, provider: 'codex', label: 'e2e-codex' }
      ],
      archived: []
    })
  )

  app = await electron.launch({
    args: [mainEntry],
    env: launchEnv({
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      COCKPIT_USER_DATA: userData
    })
  })
  win = await app.firstWindow()
  // links never leave the app: a stray click on a PR badge would otherwise open this
  // machine's browser — on a Linux runner xdg-open starts Chrome in the app's process
  // group, which outlives the app and holds its pipes, so teardown hangs until timeout
  await app.evaluate(({ shell }) => {
    const g = globalThis as { openedUrls?: string[] }
    g.openedUrls = []
    shell.openExternal = async (url: string) => {
      g.openedUrls?.push(url)
    }
  })
})

/** URLs the app asked the OS to open since launch — see the stub above. */
const openedUrls = (): Promise<string[]> =>
  app.evaluate(() => (globalThis as { openedUrls?: string[] }).openedUrls ?? [])

test.afterAll(async () => {
  await closeApp(app)
})

/**
 * Home's own marker. The view's only heading is the board's masthead, whose text is
 * the live counts, so "are we home?" is asked of the footer line instead — home
 * renders it in every state, signed in or not, board or no board.
 */
const homeHeading = (): Locator => win.getByRole('button', { name: /Start a roundtable/ })

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
  // fixture sessions surface on the board. They are idle, but the stub gh's PR on their
  // branch fails its checks, so the badges' refresh raises it as a red PR (attention.ts)
  const board = win.locator('.board')
  await expect(board.locator('.board-mast')).toContainText('1 red PR')
  await expect(board.getByText('#42 checks failing')).toBeVisible()
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
  await expect(source.getByRole('button', { name: /^Remove config home e2e-claude/ })).toBeVisible()
  // preferences live on their own tabs, one panel at a time
  const tabs = win.getByRole('tablist', { name: 'Settings sections' })
  await tabs.getByRole('tab', { name: 'View' }).click()
  await expect(win.getByRole('button', { name: 'Sessions to show' })).toBeVisible()
  await expect(win.getByRole('button', { name: 'Time format' })).toBeVisible()
  await expect(source).toBeHidden()

  // the bug the tabs replaced: picking a section used to scroll its heading to the
  // top of the card, which took the title, the tab row and Close off the screen with
  // it. Every tab must leave the head where it is, with nothing scrolled away.
  for (const name of ['Notifications', 'Providers', 'Backup', 'About', 'Accounts']) {
    await tabs.getByRole('tab', { name }).click()
    await expect(tabs.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true')
    await expect(win.getByRole('heading', { name: 'Settings' })).toBeVisible()
    await expect(win.getByRole('button', { name: 'Close' })).toBeVisible()
    const view = await win.evaluate(() => {
      const el = document.querySelector('.settings-view')!
      const tabs = document.querySelector('.ns-tabs')!.getBoundingClientRect()
      return {
        scrollTop: el.scrollTop,
        overflow: el.scrollHeight - el.clientHeight,
        clientHeight: el.clientHeight,
        tabsTop: tabs.top
      }
    })
    expect(view.scrollTop, `${name} scrolled the card`).toBe(0)
    expect(view.tabsTop, `${name} pushed the tab row off the top`).toBeGreaterThan(0)
    // one panel is at most one screen past the fold — the single card was 2.5 of them
    expect(view.overflow, `${name} is a page, not a panel`).toBeLessThan(view.clientHeight)
  }
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
  // the per-agent breakdown is the view's reason to exist — one tab over, a page of its own
  const tabs = win.getByRole('tablist', { name: 'Profile sections' })
  await tabs.getByRole('tab', { name: 'Agents' }).click()
  await expect(win.locator('.pv-agent')).not.toHaveCount(0)
  await expect(win.getByRole('img', { name: /activity over the last \d+ days/i })).toHaveCount(0)
  // the headline numbers are the glance every tab keeps
  await expect(stats).toBeVisible()
  await win.getByRole('button', { name: 'Close' }).click()
  await expect(homeHeading()).toBeVisible()
})

test('cleanup opens on a completed scan of sessions and worktrees', async () => {
  await win.getByRole('button', { name: 'Cleanup', exact: true }).click()
  await expect(win.getByRole('heading', { name: 'Cleanup' })).toBeVisible()
  // the scan must finish, not sit on its loading line: the summary replaces it
  await expect(win.getByText(/of \d+ sessions/)).toBeVisible()
  await expect(win.getByText(/of \d+ worktrees/)).toBeVisible()
  // the threshold is the view's one setting, over tabs that page one list at a time
  await expect(win.getByRole('button', { name: /^Idle threshold/ })).toBeVisible()
  const tabs = win.getByRole('tablist', { name: 'Cleanup sections' })
  for (const name of ['Sessions', 'Processes', 'Roundtables', 'Worktrees']) {
    const tab = tabs.getByRole('tab', { name: new RegExp(`^${name}`) })
    await tab.click()
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    await expect(win.getByRole('tabpanel')).toHaveCount(1)
    // a tab replaces the page under it; it never scrolls one further down into view
    const view = await win.evaluate(() => ({
      scrollTop: document.querySelector('.settings-view')!.scrollTop,
      tabsTop: document.querySelector('.ns-tabs')!.getBoundingClientRect().top
    }))
    expect(view.scrollTop, `${name} scrolled the card`).toBe(0)
    expect(view.tabsTop, `${name} pushed the tab row off the top`).toBeGreaterThan(0)
  }
  await win.keyboard.press('Escape')
  await expect(homeHeading()).toBeVisible()
})

test('agents view opens on the panel, with sections as its only navigation', async () => {
  await win.getByRole('button', { name: 'Agents', exact: true }).click()
  await expect(win.getByRole('heading', { name: 'Agents' })).toBeVisible()
  // the panel reads the fixture agent homes — it must render, not sit on its
  // loading line or throw (the sections only appear once a scope has loaded)
  const sections = win.getByRole('tablist', { name: 'Agents sections' })
  await expect(sections.getByRole('tab', { name: /^Instructions/ })).toBeVisible()
  // scope is the one control above the panel; the sections are the only tab bar
  await expect(win.getByRole('tablist')).toHaveCount(1)
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
  // transcripts mode first: a phrase no session is *named* by, only said in — the door
  // is the top row, Enter takes it, the hit carries the marked snippet. Backspace then
  // lands on the recent list, which the 'skills' query below empties before 'login'
  // has to be the top hit.
  await input.fill('retry loop')
  await expect(palette.getByRole('option', { name: /fix the login flake/ })).toHaveCount(0)
  await expect(
    palette.getByRole('option', { name: 'Search transcripts for “retry loop” in all repos' })
  ).toBeVisible()
  await win.keyboard.press('Enter')
  await expect(palette.getByRole('button', { name: /Searching transcripts/ })).toBeVisible()
  const hit = palette.getByRole('option', { name: /fix the login flake — agent: Patched the retry loop/ })
  await expect(hit).toBeVisible()
  await expect(hit.locator('mark')).toHaveText('retry loop')
  // Backspace on an emptied query returns to jump; the palette stays open
  await input.fill('')
  await win.keyboard.press('Backspace')
  await expect(palette.getByRole('button', { name: /Searching transcripts/ })).toBeHidden()
  await expect(palette.getByRole('option', { name: 'Settings' })).toBeVisible()
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
  // home is a frame, not a page: the composer is docked to the bottom edge and on
  // screen without a scroll however many rows the board has, and the board is what
  // gives way — it scrolls its own list. This is the shape at its tightest.
  expect(
    await win.evaluate(() => {
      const bad: string[] = []
      const doc = document.documentElement
      if (doc.scrollHeight > window.innerHeight + 1) bad.push('the page itself scrolls')
      const start = document.querySelector('.composer-bar .btn-primary')!.getBoundingClientRect()
      if (start.top < 0 || start.bottom > window.innerHeight + 1) bad.push('Start is off screen')
      const list = document.querySelector('.board-list')!
      if (list.scrollHeight <= list.clientHeight + 1) bad.push('the board is not the one giving way')
      return bad
    })
  ).toEqual([])

  await win.keyboard.press('ControlOrMeta+k')
  await expect(win.getByRole('dialog', { name: 'Jump to' })).toBeVisible()
  expect(await audit()).toEqual([])
  await win.keyboard.press('Escape')

  // five tabs must wrap inside the narrow card, never overflow it
  await win.getByRole('button', { name: 'Agents', exact: true }).click()
  await expect(win.getByRole('heading', { name: 'Agents' })).toBeVisible()
  expect(await audit()).toEqual([])
  // fitting is not the same as usable: beside the scope switch the search box once
  // squeezed to a 16px sliver without overflowing anything
  expect((await win.getByPlaceholder('Search…').boundingBox())?.width ?? 0).toBeGreaterThan(200)

  // settings' rows carry an identity chip, a path, a count and an action, and its
  // usage windows fixed-width meters — both outgrew the card here once, unaudited.
  // Every tab is audited: each is its own page now, and only the open one is mounted.
  await win.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(win.getByRole('heading', { name: 'Settings' })).toBeVisible()
  expect(await audit()).toEqual([])
  const settingsTabs = win.getByRole('tablist', { name: 'Settings sections' })
  for (const name of ['View', 'Notifications', 'Providers', 'Backup', 'About']) {
    await settingsTabs.getByRole('tab', { name }).click()
    await expect(settingsTabs.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true')
    expect(await audit(), `settings › ${name} at the window floor`).toEqual([])
  }

  // profile's heatmap and bars, one tab at a time
  await win.getByRole('button', { name: 'Profile', exact: true }).click()
  await expect(win.getByRole('heading', { name: 'Profile' })).toBeVisible()
  const profileTabs = win.getByRole('tablist', { name: 'Profile sections' })
  for (const name of ['Activity', 'Agents', 'Code']) {
    await profileTabs.getByRole('tab', { name }).click()
    await expect(profileTabs.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true')
    expect(await audit(), `profile › ${name} at the window floor`).toEqual([])
  }

  // cleanup's rows carry a path, a size and a reason — the widest content in the app
  await win.getByRole('button', { name: 'Cleanup', exact: true }).click()
  await expect(win.getByRole('heading', { name: 'Cleanup' })).toBeVisible()
  await expect(win.getByText(/of \d+ sessions/)).toBeVisible({ timeout: 30_000 })
  const cleanupTabs = win.getByRole('tablist', { name: 'Cleanup sections' })
  for (const name of ['Sessions', 'Processes', 'Roundtables', 'Worktrees']) {
    const tab = cleanupTabs.getByRole('tab', { name: new RegExp(`^${name}`) })
    await tab.click()
    await expect(tab).toHaveAttribute('aria-selected', 'true')
    expect(await audit(), `cleanup › ${name} at the window floor`).toEqual([])
  }
  await win.keyboard.press('Escape')

  // aim at the title, as a person would: at this width the row's compact PR badge takes
  // nearly half the row, and a click that lands on it opens the PR instead
  await win.getByRole('treeitem', { name: /fix the login flake/ }).locator('.session-title').click()
  await expect(win.getByRole('button', { name: 'Send' })).toBeVisible()
  // the chat header at its widest: an open PR's badge (state, checks glyph, a
  // two-digit thread count and the changes-requested mark) beside the review key
  // and the mode picker
  await expect(win.locator('.chat-header .pr-badge .pr-threads')).toHaveText('12')
  expect(await audit()).toEqual([])
  // the composer's textarea keeps a readable width rather than sharing its row with
  // the controls (it was ~180px, its placeholder wrapped to five lines)
  expect((await win.getByLabel('Message Claude').boundingBox())?.width ?? 0).toBeGreaterThan(260)
  // and the review, whose PR strip and diff controls wrap into the same width
  await win.getByRole('button', { name: 'Changes', exact: true }).click()
  await expect(win.getByRole('region', { name: 'Changes to review' })).toBeVisible()
  expect(await audit()).toEqual([])
  await win.getByRole('button', { name: 'Changes', exact: true }).click()
  // every click above landed on what it aimed at — none of them opened a PR
  expect(await openedUrls()).toEqual([])

  await win.setViewportSize({ width: 1100, height: 728 })
})

test('the floor is in CSS pixels: zoom raises the window minimum instead of falling through it', async () => {
  const minimum = (): Promise<number[]> =>
    app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getMinimumSize())
  const zoom = (factor: number): Promise<unknown> =>
    win.evaluate((f) => window.cockpit.setZoomFactor(f), factor)

  // 560pt holds 560 CSS px only at 100% — at 150% the same window lays out 373 of them,
  // three breakpoints below anything the layout is written for. The minimum grows with it.
  await zoom(1.5)
  await expect.poll(minimum).toEqual([840, 630])

  // the level is the user's, so main writes it down — next launch restores it before
  // the first paint, which is also when it needs it to size the window
  expect(JSON.parse(readFileSync(join(userData, 'cockpit-config.json'), 'utf8')).zoom).toBe(1.5)

  // and with the minimum in step, the floor is the floor: at 150% in an 840x630 window
  // the layout gets exactly the 560x420 it is audited at above
  await win.setViewportSize({ width: 840, height: 630 })
  expect(await win.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([560, 420])
  await win.keyboard.press('ControlOrMeta+n')
  await expect(win.getByRole('button', { name: /^Start with/ })).toBeVisible()
  const escapes = await win.evaluate(() => {
    const bad: string[] = []
    if (document.documentElement.scrollWidth > window.innerWidth + 1) bad.push('document scrolls horizontally')
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const r = el.getBoundingClientRect()
      if (r.width > 0 && (r.right > window.innerWidth + 1.5 || r.left < -1.5))
        bad.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} escapes the window`)
    }
    return [...new Set(bad)]
  })
  expect(escapes).toEqual([])

  // zooming out only ever hands the layout more CSS pixels — the floor stays the floor
  await zoom(0.7)
  await expect.poll(minimum).toEqual([560, 420])
  await zoom(1)
  await expect.poll(minimum).toEqual([560, 420])
  await win.setViewportSize({ width: 1100, height: 728 })
})

test('and where a display cannot grant the zoomed floor, the views give way instead of breaking', async () => {
  /** Every element whose box leaves the window, ignoring what a scroller legitimately holds. */
  const escapes = (): Promise<string[]> =>
    win.evaluate(() => {
      const vw = document.documentElement.clientWidth
      const bad: string[] = []
      for (const el of Array.from(document.querySelectorAll('body *'))) {
        const cs = getComputedStyle(el)
        if (cs.display === 'none' || cs.visibility === 'hidden') continue
        let scrolled = false
        for (let n = el.parentElement; n; n = n.parentElement) {
          const c = getComputedStyle(n)
          if (/auto|scroll/.test(c.overflowX) || /auto|scroll/.test(c.overflowY)) { scrolled = true; break }
        }
        if (scrolled) continue
        const r = el.getBoundingClientRect()
        if (r.width > 0 && (r.right > vw + 1.5 || r.left < -1.5))
          bad.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]}`)
      }
      return [...new Set(bad)]
    })
  const openChat = async (): Promise<void> => {
    await win.keyboard.press('ControlOrMeta+n')
    const row = win.getByRole('treeitem', { name: /fix the login flake/ })
    // repos keep their own expanded state, and this test stands alone: open them in
    // turn until the session is on screen rather than assuming an earlier test did
    const collapsed = win.locator('.repo-row[aria-expanded="false"]')
    for (let i = 0; i < 20; i++) {
      const shown = await row.first().isVisible()
      if (shown || (await collapsed.count()) === 0) break
      await collapsed.first().click()
    }
    // aim at the title: at these widths the row's compact PR badge takes nearly half of
    // it, and a click that lands there opens the PR instead of the session
    await row.first().locator('.session-title').click()
    await expect(win.locator('.chat-header')).toBeVisible()
  }

  // The header's keys and PR badge are already as small as they shed to, so the row has
  // nowhere left to give — it takes a second line rather than walking out of the window.
  // At the floor it must still be one line: that is the layout every shot is taken of.
  await win.evaluate(() => window.cockpit.setZoomFactor(1))
  await win.setViewportSize({ width: 560, height: 420 })
  await openChat()
  const oneLine = (await win.locator('.chat-header').boundingBox())?.height ?? 0
  expect(oneLine).toBeLessThan(60)
  expect(await escapes()).toEqual([])

  // A 1280x800 laptop at 200% is the case the display really does bound: 1120 points of
  // width is the zoomed floor, but 775 of height is all there is — 560x387 of layout.
  await win.evaluate(() => window.cockpit.setZoomFactor(2))
  await win.setViewportSize({ width: 1120, height: 775 })
  await openChat()
  expect(await escapes()).toEqual([])

  // and past the floor on width, which needs a display narrower than any Mac has: the
  // header wraps (it is taller than the one-line row above) and still nothing escapes
  await win.evaluate(() => window.cockpit.setZoomFactor(1.5))
  await win.setViewportSize({ width: 630, height: 480 })
  await openChat()
  expect((await win.locator('.chat-header').boundingBox())?.height ?? 0).toBeGreaterThan(oneLine)
  expect(await escapes()).toEqual([])

  await win.evaluate(() => window.cockpit.setZoomFactor(1))
  await win.setViewportSize({ width: 1100, height: 728 })
})

test('the rail holds its own top row at every zoom, not just at 100%', async () => {
  // The bug this pins: the wordmark's text used to shed on a *viewport* breakpoint
  // while the row it has to fit in is the rail, which is `clamp()`ed off that same
  // viewport — zoom pulls the two apart. At 120% in a 1100pt window the viewport was
  // still 916 CSS px (no shed) and the rail had already clamped to 240, so the four
  // nav keys walked across the rail's border and painted onto the deck. Nothing left
  // the *window*, which is all the audits above ever asked.
  const audit = (): Promise<string[]> =>
    win.evaluate(() => {
      const bad: string[] = []
      const rail = document.querySelector('.tree-sidebar')!.getBoundingClientRect()
      const top = document.querySelector('.tree-top')!
      const title = document.querySelector('.app-title')
      if (top.scrollWidth > top.clientWidth + 1) bad.push(`.tree-top overflows its row (${top.scrollWidth} in ${top.clientWidth})`)
      for (const key of document.querySelectorAll('.tree-nav .nav-btn, .zoom-chip, .app-title')) {
        const r = key.getBoundingClientRect()
        const name = key.getAttribute('aria-label') ?? key.className
        if (r.right > rail.right + 0.5 || r.left < rail.left - 0.5) bad.push(`${name} leaves the rail`)
        // a zoomed reader is the last person to hand a smaller target to, so the row
        // gives way by reflowing rather than by shrinking its keys. (.app-title is
        // exempt: it renders 22px tall at every zoom, a target-size miss that predates
        // this row's shed rules and is not this rule's to fix.)
        if (key !== title && (r.width < 23.5 || r.height < 23.5))
          bad.push(`${name} shrank to ${r.width.toFixed(1)}×${r.height.toFixed(1)}`)
      }
      return [...new Set(bad)]
    })

  // every level the menu can reach, in the window each one's floor allows: main keeps
  // the zoomed floor at 560x420 of layout, which is the narrowest rail there is (200px)
  for (const factor of [0.7, 1, 1.1, 1.2, 1.3, 1.5, 1.75, 2]) {
    await win.evaluate((f) => window.cockpit.setZoomFactor(f), factor)
    await win.setViewportSize({ width: Math.round(560 * Math.max(1, factor)), height: Math.round(420 * Math.max(1, factor)) })
    await expect.poll(() => win.locator('.zoom-chip').count()).toBe(factor === 1 ? 0 : 1)
    expect(await audit(), `the rail at ${Math.round(factor * 100)}%, at its floor`).toEqual([])
    // and in an ordinary window, where the rail is wider but the viewport is past
    // every breakpoint — the band the bug actually lived in
    await win.setViewportSize({ width: 1100, height: 760 })
    expect(await audit(), `the rail at ${Math.round(factor * 100)}%, in a 1100pt window`).toEqual([])
  }

  /** Have the nav keys dropped below the wordmark, i.e. is the row on two lines? */
  const wrapped = (): Promise<boolean> =>
    win.evaluate(
      () =>
        document.querySelector('.tree-nav')!.getBoundingClientRect().top >=
        document.querySelector('.app-title')!.getBoundingClientRect().bottom
    )
  const rowHeight = (): Promise<number> =>
    win.evaluate(() => document.querySelector('.tree-top')!.getBoundingClientRect().height)

  // the reflow is the floor's answer and only the floor's: at 100% the row is one line
  // at every width, which is the layout every screenshot and every audit above is of
  await win.evaluate(() => window.cockpit.setZoomFactor(1))
  await win.setViewportSize({ width: 560, height: 420 })
  // the chip leaves on the renderer's next zoom report, not with the call: measured
  // before it goes, the row is still the chip-up row and reads as wrapped
  await expect(win.locator('.zoom-chip')).toHaveCount(0)
  const oneLine = await rowHeight()
  expect(await wrapped()).toBe(false)

  // with the chip up in the same 200px rail the keys take their own line rather than
  // shrinking or leaving: nothing is lost, the row is simply taller
  await win.evaluate(() => window.cockpit.setZoomFactor(1.1))
  await win.setViewportSize({ width: 616, height: 462 })
  await expect(win.locator('.zoom-chip')).toBeVisible()
  expect(await wrapped()).toBe(true)
  expect(await rowHeight()).toBeGreaterThan(oneLine)
  expect(await audit()).toEqual([])

  await win.evaluate(() => window.cockpit.setZoomFactor(1))
  await win.setViewportSize({ width: 1100, height: 728 })
})
