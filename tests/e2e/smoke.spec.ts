import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { closeApp } from './close-app'

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
      // hermetic run: config, index cache, and worktrees land in a throwaway dir, and
      // agent homes resolve under an empty HOME — no agent signed in, nothing to index —
      // so the home settles on the same screen on a laptop as on a CI runner
      HOME: mkdtempSync(join(tmpdir(), 'cockpit-e2e-home-')),
      COCKPIT_USER_DATA: mkdtempSync(join(tmpdir(), 'cockpit-e2e-')),
      // CI linux runners restrict unprivileged user namespaces; no SUID helper either
      ...(process.env.CI ? { ELECTRON_DISABLE_SANDBOX: '1' } : {})
    }
  })
})

test.afterAll(async () => {
  await closeApp(app)
})

test('boots to the home shell', async () => {
  const win = await app.firstWindow()
  await expect(win).toHaveTitle('Cockpit')
  // home's only heading is the board's masthead (live counts), so the footer line is
  // the marker: home renders it whether or not anything is indexed or signed in
  await expect(win.getByRole('button', { name: /Start a roundtable/ })).toBeVisible()

  // with no agent signed in the home settles on the setup card. The composer stands in
  // until the accounts snapshot lands, and that waits on `gh api user` (bounded at 10s
  // in main), so wait out the swap rather than assert either side of it. The composer
  // itself is covered against a seeded world in pages.spec.ts.
  // the card names itself from its own visible heading now, not an aria-label
  await expect(
    win.getByRole('region', { name: 'Three things and you fly' })
  ).toBeVisible({ timeout: 15_000 })
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
  await win.getByRole('tab', { name: 'Notifications' }).click()
  for (const name of ['Desktop notifications', 'Sound', 'Dock badge']) {
    await expect(win.getByRole('checkbox', { name })).not.toBeChecked()
  }
  expect(await app.evaluate(({ app }) => app.getBadgeCount())).toBe(0)
})
