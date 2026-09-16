import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'

const mainEntry = resolve('out/main/index.js')
if (!existsSync(mainEntry)) {
  throw new Error('out/main/index.js missing — run `npm run build` before `npm run test:e2e`')
}

let app: ElectronApplication

test.beforeAll(async () => {
  app = await electron.launch({
    args: [mainEntry],
    env: {
      ...process.env,
      // hermetic run: config, index cache, and worktrees land in a throwaway dir
      COCKPIT_USER_DATA: mkdtempSync(join(tmpdir(), 'cockpit-e2e-')),
      // CI linux runners restrict unprivileged user namespaces; no SUID helper either
      ...(process.env.CI ? { ELECTRON_DISABLE_SANDBOX: '1' } : {})
    }
  })
})

test.afterAll(async () => {
  // graceful close occasionally hangs under xvfb on linux CI — bound it with a
  // hard kill so teardown can never eat the 60s hook timeout and fail the run
  const kill = setTimeout(() => app.process().kill('SIGKILL'), 15_000)
  await app.close().catch(() => {})
  clearTimeout(kill)
})

test('boots to the home shell', async () => {
  const win = await app.firstWindow()
  await expect(win).toHaveTitle('Cockpit')
  // the heading may carry the gh login ("What should we ship, dev?") — match the stem
  await expect(win.getByRole('heading', { name: /What should we ship/ })).toBeVisible()

  // this run uses the machine's real agent homes, so the home settles on the composer
  // or — on a runner with no agent signed in — the setup card. The composer shows while
  // accounts load, so asserting it alone races that swap; the composer itself is covered
  // against a seeded world in pages.spec.ts.
  const composer = win.getByRole('textbox', { name: 'Task description' })
  const setup = win.getByRole('region', { name: 'Set up Cockpit' })
  await expect(composer.or(setup)).toBeVisible()
})

test('preload bridge is wired through context isolation', async () => {
  const win = await app.firstWindow()
  expect(await win.evaluate(() => typeof window.cockpit?.pageSessions)).toBe('function')

  // renderer state reacts to input — the sidebar search is there whatever the home shows
  const search = win.getByRole('textbox', { name: 'Search sessions' })
  await search.fill('smoke test')
  await expect(search).toHaveValue('smoke test')
})

test('notifications, sound and the Dock badge start off outside an installed app', async () => {
  // what keeps e2e, the UI tour and `npm run dev` from ever posting, playing or badging
  const win = await app.firstWindow()
  await win.keyboard.press('ControlOrMeta+,')
  await expect(win.getByRole('heading', { name: 'Notifications' })).toBeVisible()
  for (const name of ['Desktop notifications', 'Sound', 'Dock badge']) {
    await expect(win.getByRole('checkbox', { name })).not.toBeChecked()
  }
  expect(await app.evaluate(({ app }) => app.getBadgeCount())).toBe(0)
})
