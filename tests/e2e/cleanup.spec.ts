import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page
} from '@playwright/test'

/**
 * Cleanup against a REAL git repository, unlike the rest of the e2e fixtures: this
 * view's whole job is deciding what git will and won't part with, so a fake .git
 * directory would test nothing. Four worktrees are cut here — Cockpit's own, two
 * outside it, and one whose directory is deleted behind git's back — plus sessions
 * old enough to be stale and one recent enough that it must never appear.
 */

const mainEntry = resolve('out/main/index.js')
if (!existsSync(mainEntry)) {
  throw new Error('out/main/index.js missing — run `npm run build` before `npm run test:e2e`')
}

const DAY = 86_400_000
const root = mkdtempSync(join(tmpdir(), 'cockpit-e2e-cleanup-'))
const userData = join(root, 'user-data')
const claudeSrc = join(root, 'claude-home')
const repoDir = join(root, 'rocket')
const wtRoot = join(userData, 'worktrees')

/** Committed long ago, so a worktree's branch tip is never a sign of recent life. */
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.com',
  GIT_AUTHOR_DATE: new Date(Date.now() - 300 * DAY).toISOString(),
  GIT_COMMITTER_DATE: new Date(Date.now() - 300 * DAY).toISOString()
}

const git = (cwd: string, args: string[]): void => {
  execFileSync('git', args, { cwd, env: gitEnv })
}

/** The scan also reads directory mtime — backdate it or nothing here looks stale. */
const backdate = (path: string, days: number): void => {
  const t = (Date.now() - days * DAY) / 1000
  utimesSync(path, t, t)
}

function writeSession(id: string, cwd: string, prompt: string, daysAgo: number): void {
  const dir = join(claudeSrc, 'projects', 'p')
  mkdirSync(dir, { recursive: true })
  const ts = new Date(Date.now() - daysAgo * DAY).toISOString()
  writeFileSync(
    join(dir, `${id}.jsonl`),
    [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: prompt },
        timestamp: ts,
        sessionId: id,
        cwd,
        gitBranch: 'main'
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: 'x'.repeat(4000) },
        timestamp: ts
      })
    ].join('\n') + '\n'
  )
}

let app: ElectronApplication
let win: Page

const mine = join(wtRoot, 'rocket', 'fix-login')
const ext = join(repoDir, '.claude', 'worktrees', 'back-navigation')
const dirty = join(repoDir, '.claude', 'worktrees', 'edge-cache-spike')
const ghost = join(wtRoot, 'rocket', 'ghost-run')

test.beforeAll(async () => {
  mkdirSync(repoDir, { recursive: true })
  mkdirSync(wtRoot, { recursive: true })
  git(repoDir, ['init', '-q', '-b', 'main'])
  writeFileSync(join(repoDir, 'README.md'), '# rocket\n')
  git(repoDir, ['add', '.'])
  git(repoDir, ['commit', '-q', '-m', 'init'])
  git(repoDir, ['remote', 'add', 'origin', 'https://github.com/acme/rocket.git'])

  // Cockpit's own worktree, one Claude Code would have cut, one with unsaved work
  git(repoDir, ['worktree', 'add', '-q', '-b', 'cockpit/fix-login', mine])
  git(repoDir, ['worktree', 'add', '-q', '-b', 'titan/back-navigation', ext])
  git(repoDir, ['worktree', 'add', '-q', '-b', 'spike/edge-cache', dirty])
  writeFileSync(join(dirty, 'scratch.txt'), 'unsaved work\n')
  writeFileSync(join(ext, 'nav.ts'), 'export const back = 1\n')
  git(ext, ['add', '.'])
  git(ext, ['commit', '-q', '-m', 'back navigation'])
  // registered with git, then deleted behind its back — prune territory
  git(repoDir, ['worktree', 'add', '-q', '-b', 'cockpit/ghost-run', ghost])
  rmSync(ghost, { recursive: true, force: true })

  for (const [path, days] of [[mine, 240], [ext, 71], [dirty, 130]] as const) backdate(path, days)

  writeSession('e2e-parser', repoDir, 'Refactor the session parser for Codex 0.9', 412)
  writeSession('e2e-flake', mine, 'Investigate the flaky indexer test', 180)
  writeSession('e2e-billing', ext, 'Add billing API fallback for the usage panel', 96)
  writeSession('e2e-recent', repoDir, 'this one is recent and must not appear', 1)

  mkdirSync(userData, { recursive: true })
  writeFileSync(
    join(userData, 'cockpit-config.json'),
    JSON.stringify({
      sources: [{ path: claudeSrc, provider: 'claude', label: 'e2e-claude' }],
      // an already-archived session must still be listed — deleting is the next tier
      archived: ['claude:e2e-parser']
    })
  )

  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      COCKPIT_USER_DATA: userData,
      ...(process.env.CI ? { ELECTRON_DISABLE_SANDBOX: '1' } : {})
    }
  })
  win = await app.firstWindow()
})

test.afterAll(async () => {
  const kill = setTimeout(() => app.process().kill('SIGKILL'), 15_000)
  await app.close().catch(() => {})
  clearTimeout(kill)
  rmSync(root, { recursive: true, force: true })
})

/** Land on a freshly scanned Cleanup view, whatever the previous test left behind. */
const openCleanup = async (): Promise<void> => {
  const open = await win
    .getByRole('heading', { name: 'Cleanup' })
    .isVisible()
    .catch(() => false)
  if (open) {
    await win.getByRole('button', { name: 'Rescan' }).click()
    return
  }
  await win.getByRole('button', { name: 'Cleanup', exact: true }).click()
  await expect(win.getByRole('heading', { name: 'Cleanup' })).toBeVisible()
}

test('lists only what is idle past the threshold, and says how it counted', async () => {
  await openCleanup()
  // three of the four sessions are old enough; the day-old one must never show
  await expect(win.getByText('3 of 4 sessions', { exact: false })).toBeVisible()
  await expect(win.locator('.cl-row', { hasText: 'this one is recent' })).toHaveCount(0)
  // an archived session is still listed — archiving is the reversible tier, not the end
  await expect(win.locator('.cl-row', { hasText: 'Refactor the session parser' })).toContainText(
    'archived'
  )
  await expect(win.locator('.cl-row', { hasText: 'directory gone' })).toBeVisible()
})

test('rides a worktree on the session that ran in it, rather than listing it twice', async () => {
  await openCleanup()
  // the session in Cockpit's own worktree says what deleting it would take
  const row = win.locator('.cl-row', { hasText: 'Investigate the flaky indexer test' })
  await expect(row.locator('.cl-carry')).toContainText('takes its worktree')
  // and that worktree is not also standing on its own in the leftovers
  await expect(win.locator('.cl-row', { hasText: 'c/fix-login' })).toHaveCount(0)
})

test('leaves only the worktrees no session claims, marked by origin', async () => {
  await openCleanup()
  // the dirty one has no session of its own, and Claude Code cut it — external
  await expect(
    win.locator('.cl-row', { hasText: 'spike/edge-cache' }).locator('.cl-origin')
  ).toHaveText('external')
  // the registration whose directory is gone is Cockpit's own
  await expect(
    win.locator('.cl-row', { hasText: 'directory gone' }).locator('.cl-origin')
  ).toHaveText('cockpit')
})

test('a worktree with uncommitted work is shown, explained, and never selectable', async () => {
  await openCleanup()
  const row = win.locator('.cl-row', { hasText: 'spike/edge-cache' })
  await expect(row).toBeVisible()
  await expect(row).toContainText('uncommitted changes')
  await expect(row.locator('.cl-pick')).toBeDisabled()
})

test('archiving a session takes it off the list', async () => {
  await openCleanup()
  await win.getByLabel('Select session Investigate the flaky indexer test').check()
  await win.getByRole('button', { name: 'Archive 1' }).click()
  await expect(win.getByText(/Archived 1/)).toBeVisible()
})

test('deleting a session takes its worktree and merged branch off the disk', async () => {
  await openCleanup()
  await win.getByLabel('Select session Investigate the flaky indexer test').check()
  await win.getByRole('button', { name: 'Delete 1…' }).click()
  await win.getByRole('button', { name: 'Delete 1 for good?' }).click()
  await expect(win.getByText(/Deleted 1/)).toBeVisible()
  // the transcript AND the checkout it ran in — leaving the worktree would not be a cleanup
  expect(existsSync(mine)).toBe(false)
  expect(execFileSync('git', ['branch', '--list'], { cwd: repoDir, encoding: 'utf8' })).not.toMatch(
    /cockpit\/fix-login/
  )
})

test('removing an orphan whose directory is already gone clears the registration', async () => {
  await openCleanup()
  const row = win.locator('.cl-row', { hasText: 'directory gone' })
  await expect(row).toBeVisible()
  await row.locator('.cl-pick').check()
  await win.getByRole('button', { name: 'Remove 1…' }).click()
  await win.getByRole('button', { name: 'Remove 1 worktree?' }).click()
  await expect(win.getByText(/Removed 1/)).toBeVisible()
  expect(execFileSync('git', ['worktree', 'list'], { cwd: repoDir, encoding: 'utf8' })).not.toMatch(
    /ghost-run/
  )
})

test('the filter bar narrows by dimension, and select-all follows it', async () => {
  await openCleanup()
  const bar = win.locator('.fb-bar').first()
  await bar.getByRole('button', { name: /^Agent/ }).click()
  await win.getByRole('button', { name: 'Claude', exact: true }).click()
  await win.keyboard.press('Escape')
  // every fixture session is Claude's, so the pill names it outright
  await expect(bar.getByRole('button', { name: /^Agent Claude/ })).toBeVisible()
  await bar.getByRole('button', { name: /^Project/ }).click()
  await win.getByRole('button', { name: 'Exclude rocket' }).click()
  await win.keyboard.press('Escape')
  // excluding the only project empties the list
  await expect(win.getByText('No sessions match this filter.')).toBeVisible()
  await win.getByRole('button', { name: 'Clear all' }).first().click()
  await expect(win.locator('.cl-row', { hasText: 'Add billing API fallback' })).toBeVisible()
})
