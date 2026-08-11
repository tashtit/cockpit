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

test('boots to the home shell with a live composer', async () => {
  const win = await app.firstWindow()
  await expect(win).toHaveTitle('Cockpit')
  // the heading may carry the gh login ("What should we ship, dev?") — match the stem
  await expect(win.getByRole('heading', { name: /What should we ship/ })).toBeVisible()

  // composer wiring is alive: renderer state reacts through the preload bridge
  const prompt = win.getByRole('textbox', { name: 'Task description' })
  await expect(prompt).toBeVisible()
  const start = win.getByRole('button', { name: /^Start with / })
  await expect(start).toBeDisabled()
})

test('preload bridge is wired through context isolation', async () => {
  const win = await app.firstWindow()
  expect(await win.evaluate(() => typeof window.cockpit?.pageSessions)).toBe('function')

  const prompt = win.getByRole('textbox', { name: 'Task description' })
  await prompt.fill('smoke test task')
  await expect(prompt).toHaveValue('smoke test task')
})
