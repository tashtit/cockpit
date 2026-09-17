import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication } from '@playwright/test'
import { closeApp } from './close-app'

/**
 * Smoke test against the PACKAGED app — the .app electron-builder produced, not
 * out/main/index.js like the other specs. It proves what only a bundle can: the asar
 * holds everything the app needs (a dependency left out of it throws at load, and a
 * packaged main shows that as a modal and never opens a window), the fuses and
 * Info.plist let it boot as an installed app, and the updater is wired to the release
 * feed. Playwright attaches through `--inspect` and `--remote-debugging-port`, which is
 * why the nodeCliInspect fuse stays on.
 *
 * Opt-in via COCKPIT_PACKAGED_APP (the path to Cockpit.app/Contents/MacOS/Cockpit —
 * `npm run test:packaged` sets it), because a packaged build refuses COCKPIT_USER_DATA by
 * design: this run uses the real userData dir and provider homes of whoever runs it (a
 * fresh machine on CI).
 */
const exe = process.env['COCKPIT_PACKAGED_APP'] ?? ''
test.skip(!exe, 'set COCKPIT_PACKAGED_APP to the packaged executable (npm run test:packaged)')

let app: ElectronApplication | null = null

test.beforeAll(async () => {
  if (!existsSync(exe)) throw new Error(`packaged app missing at ${exe} — run npm run package first`)
  app = await electron.launch({ executablePath: exe, args: [] })
})

test.afterAll(async () => {
  if (app) await closeApp(app)
})

test('the bundle boots as an installed Cockpit', async () => {
  const info = await app!.evaluate(({ app: a }) => ({
    packaged: a.isPackaged,
    name: a.getName(),
    version: a.getVersion()
  }))
  expect(info.packaged).toBe(true)
  expect(info.name).toBe('Cockpit')
  // a release build carries the tag's version (the release job passes it in);
  // any other build packages as 0.0.0
  expect(info.version).toBe(process.env['COCKPIT_EXPECTED_VERSION'] ?? '0.0.0')

  const win = await app!.firstWindow()
  await expect(win).toHaveTitle('Cockpit')
  await expect(win.getByRole('heading', { name: /What should we ship/ })).toBeVisible()
  expect(await win.evaluate(() => typeof window.cockpit?.pageSessions)).toBe('function')
})

test('the updater is wired to GitHub Releases', async () => {
  // electron-builder writes this from the publish config; without it electron-updater
  // has no feed and every check fails
  const manifest = readFileSync(join(dirname(exe), '..', 'Resources', 'app-update.yml'), 'utf8')
  expect(manifest).toContain('provider: github')
  expect(manifest).toContain('owner: tashtit')
  expect(manifest).toContain('repo: cockpit')

  // the notices ship outside the asar, where About opens them — and Chromium's with them,
  // which electron-builder would otherwise delete from a mac bundle
  const resources = join(dirname(exe), '..', 'Resources')
  const notices = readFileSync(join(resources, 'THIRD_PARTY_NOTICES.txt'), 'utf8')
  for (const shipped of ['react-dom', 'electron-updater', 'IBM Plex Sans', 'GitHub Octicons']) {
    expect(notices).toContain(shipped)
  }
  expect(existsSync(join(resources, 'LICENSES.chromium.html'))).toBe(true)

  // an installed build reports a live updater — never the dev-run "unsupported"
  const win = await app!.firstWindow()
  const state = await win.evaluate(() => window.cockpit.getUpdateState())
  expect(state.status).not.toBe('unsupported')
  const about = await win.evaluate(() => window.cockpit.getAppInfo())
  expect(about.packaged).toBe(true)
})
