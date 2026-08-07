import { defineConfig } from '@playwright/test'

/** E2E drives the built Electron app (npm run build first) — see tests/e2e. */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  // one Electron instance at a time — parallel apps fight over the display and dock
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: { trace: 'retain-on-failure' }
})
