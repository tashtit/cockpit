import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { _electron as electron, expect, test } from '@playwright/test'
import { closeApp } from './close-app'
import { launchEnv } from './launch-env'

/** Desktop engines pass through the real main-process CLI status to the Accounts UI. */
test('desktop engines are usable, app-managed, and fit every supported window size', async ({}, info) => {
  const root = mkdtempSync(join(tmpdir(), 'cockpit-desktop-ui-'))
  const home = join(root, 'home')
  const bin = join(root, 'bin')
  const applications = join(home, 'Applications')
  const userData = join(root, 'user-data')
  const codex = join(applications, 'Codex.app/Contents/Resources/codex')
  const claude = join(home, 'Library/Application Support/Claude/claude-code/2.1.284/claude.app/Contents/MacOS/claude')
  for (const dir of [bin, userData, join(home, '.claude'), join(home, '.codex'), join(applications, 'Claude.app')]) {
    mkdirSync(dir, { recursive: true })
  }
  const writeCli = (path: string, body: string): void => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  }
  writeCli(codex, 'case "$1" in --version) echo "codex-cli 0.160.0";; login) echo "Logged in using ChatGPT" >&2;; esac')
  writeCli(claude, 'case "$1" in --version) echo "2.1.284 (Claude Code)";; auth) echo \'{"loggedIn":true,"authMethod":"claude.ai"}\';; esac')
  // Explicit command links keep the fixture ahead of any standalone CLIs on this Mac;
  // realpath must still recognize their desktop owner. Discovery is covered in unit tests.
  symlinkSync(codex, join(bin, 'codex'))
  symlinkSync(claude, join(bin, 'claude'))
  writeCli(join(bin, 'copilot'), 'echo "1.0.87"')
  writeCli(join(bin, 'gh'), 'exit 1')

  const app = await electron.launch({
    args: [resolve('.')],
    env: launchEnv({ HOME: home, COCKPIT_USER_DATA: userData, COCKPIT_DESKTOP_APPLICATIONS: applications, PATH: `${bin}:/usr/bin:/bin` })
  })
  try {
    const win = await app.firstWindow()
    await win.getByRole('button', { name: 'Settings', exact: true }).click()
    await expect(win.getByText('via Codex desktop')).toBeVisible()
    await expect(win.getByText('via Claude desktop')).toBeVisible()
    await expect(win.getByText('updated by desktop app')).toHaveCount(2)
    const statuses = await win.evaluate(() => window.cockpit.listCliStatus(true))
    for (const provider of ['claude', 'codex']) {
      expect(statuses.find((s) => s.provider === provider)).toMatchObject({
        installed: true, install: 'desktop', latest: null, updateAvailable: false, updateCommand: null
      })
    }
    const desktopRows = win.locator('.source-row').filter({ hasText: 'updated by desktop app' })
    await expect(desktopRows.getByRole('button', { name: 'Update…', exact: true })).toHaveCount(0)
    expect(await win.evaluate(async () => {
      try {
        await window.cockpit.openCliUpdate('claude')
        return 'unexpectedly opened updater'
      } catch (err) {
        return String(err)
      }
    })).toContain('managed by Claude desktop')
    for (const width of [1280, 900, 560]) {
      await win.setViewportSize({ width, height: width === 560 ? 420 : 820 })
      await win.getByRole('heading', { name: 'Agent CLIs' }).scrollIntoViewIfNeeded()
      expect(await desktopRows.evaluateAll((rows) => rows.every((row) => {
        const box = row.getBoundingClientRect()
        return box.left >= 0 && box.right <= window.innerWidth
      }))).toBe(true)
      await win.screenshot({ path: info.outputPath(`desktop-tools-${width}.png`) })
    }
    await win.setViewportSize({ width: 1280, height: 820 })
    await win.evaluate(() => window.cockpit.setZoomFactor(2))
    await win.getByRole('heading', { name: 'Agent CLIs' }).scrollIntoViewIfNeeded()
    expect(await desktopRows.evaluateAll((rows) => rows.every((row) => row.getBoundingClientRect().right <= window.innerWidth))).toBe(true)
    await win.screenshot({ path: info.outputPath('desktop-tools-zoom200.png') })
  } finally {
    await closeApp(app)
    rmSync(root, { recursive: true, force: true })
  }
})
