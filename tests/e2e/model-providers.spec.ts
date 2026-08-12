import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'

const mainEntry = resolve('out/main/index.js')
if (!existsSync(mainEntry)) {
  throw new Error('out/main/index.js missing — run `npm run build` before `npm run test:e2e`')
}

// Hermetic fixture world (same recipe as pages.spec.ts): a fake repo + claude source
// so the session form has a project, and a config pre-seeded with BYOK providers.
// No provider carries a stored key — the OS keychain must stay out of e2e.
const root = mkdtempSync(join(tmpdir(), 'cockpit-e2e-byok-'))
const userData = join(root, 'user-data')
const claudeSrc = join(root, 'claude-home')
const repoDir = join(root, 'rocket')

let app: ElectronApplication
let win: Page

test.beforeAll(async () => {
  mkdirSync(join(repoDir, '.git'), { recursive: true })
  writeFileSync(
    join(repoDir, '.git', 'config'),
    '[remote "origin"]\n\turl = https://github.com/acme/rocket.git\n'
  )
  const sessions = join(claudeSrc, 'projects', 'p')
  mkdirSync(sessions, { recursive: true })
  const ts = new Date(Date.now() - 3_600_000).toISOString()
  writeFileSync(
    join(sessions, 'e2e-byok.jsonl'),
    [
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: 'seed session' },
        timestamp: ts,
        sessionId: 'e2e-byok',
        cwd: repoDir,
        gitBranch: 'main'
      }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'ok' }, timestamp: ts })
    ].join('\n') + '\n'
  )

  mkdirSync(userData, { recursive: true })
  writeFileSync(
    join(userData, 'cockpit-config.json'),
    JSON.stringify({
      sources: [{ path: claudeSrc, provider: 'claude', label: 'e2e-claude' }],
      archived: [],
      modelEndpoints: [
        {
          id: 'ep-anthropic',
          label: 'anthropic-gw',
          type: 'anthropic',
          baseUrl: 'https://gw.example.com',
          models: ['claude-fable-5', 'claude-haiku-4-5']
        },
        {
          id: 'ep-ollama',
          label: 'ollama-local',
          type: 'openai',
          baseUrl: 'http://localhost:11434/v1',
          models: ['llama3.3']
        }
      ]
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
})

test('settings lists seeded providers with agent applicability, and adds/removes one live', async () => {
  await win.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(win.getByRole('heading', { name: 'Model providers' })).toBeVisible()

  // seeded rows: type chip, per-type agent applicability, cached model count
  const anthropicRow = win.locator('.source-row', { hasText: 'anthropic-gw' })
  await expect(anthropicRow).toContainText('https://gw.example.com')
  await expect(anthropicRow.getByRole('img', { name: 'works with Claude and Copilot' })).toBeVisible()
  await expect(anthropicRow).toContainText('no key · 2 models')
  const ollamaRow = win.locator('.source-row', { hasText: 'ollama-local' })
  await expect(ollamaRow.getByRole('img', { name: 'works with Copilot' })).toBeVisible()

  // a bad definition is refused by main and surfaces verbatim
  await win.getByLabel('Display name').fill('broken')
  await win.getByLabel('Base URL').fill('not a url')
  await win.getByRole('button', { name: 'Add provider' }).click()
  await expect(win.getByText(/Invalid provider:/)).toBeVisible()

  // a real add round-trips through main into config; the model probe fails fast
  // (nothing listens on the port) and reports as advice, not an error
  await win.getByLabel('Base URL').fill('http://127.0.0.1:9/v1')
  await win.getByLabel('Display name').fill('local-probe')
  await win.getByRole('button', { name: 'Add provider' }).click()
  const added = win.locator('.source-row', { hasText: 'local-probe' })
  await expect(added).toContainText('no key')
  // the outcome line renders visibly and is mirrored to the sr-only status region —
  // assert the visible hint specifically
  await expect(win.locator('.ns-hint', { hasText: /couldn't list models/ })).toBeVisible({
    timeout: 15_000
  })

  // two-step remove deletes it again
  await added.getByRole('button', { name: /^Remove provider local-probe/ }).click()
  await added.getByRole('button', { name: /^Confirm removing provider local-probe/ }).click()
  await expect(win.locator('.source-row', { hasText: 'local-probe' })).toHaveCount(0)
  await win.getByRole('button', { name: 'Close' }).click()
})

test('new session gates providers per agent and offers the model catalog', async () => {
  await win.getByRole('treeitem', { name: /acme\/\s*rocket/ }).focus()
  await win.getByRole('button', { name: 'New session in rocket' }).click()
  await expect(win.getByRole('heading', { name: 'New session' })).toBeVisible()
  const agents = win.getByRole('group', { name: 'Agent' })

  // claude: only the anthropic-type provider is offered
  await win.getByLabel('Model provider').click()
  await expect(win.getByRole('option', { name: 'anthropic-gw' })).toBeVisible()
  await expect(win.getByRole('option', { name: 'ollama-local' })).toHaveCount(0)
  await win.getByRole('option', { name: 'anthropic-gw' }).click()
  await expect(win.getByText(/Runs on https:\/\/gw\.example\.com/)).toBeVisible()
  // the model control is a picker of the provider's cached catalog
  await win.getByLabel('Model', { exact: true }).click()
  await expect(win.getByRole('option', { name: 'claude-fable-5' })).toBeVisible()
  await win.keyboard.press('Escape')

  // codex: no provider fits, and the form says why instead of hiding silently
  await agents.getByRole('button', { name: /Codex/ }).click()
  await expect(win.getByLabel('Model provider')).toHaveCount(0)
  await expect(win.getByText(/can’t run Codex/)).toBeVisible()

  // copilot: both providers fit, and BYOK requires picking a model before Start arms
  await agents.getByRole('button', { name: /Copilot/ }).click()
  await win.getByLabel('Model provider').click()
  await expect(win.getByRole('option', { name: 'ollama-local' })).toBeVisible()
  await win.getByRole('option', { name: 'ollama-local' }).click()
  await win.getByLabel('Task', { exact: true }).fill('never actually started')
  const start = win.getByRole('button', { name: 'Start session' })
  await expect(start).toBeDisabled()
  await win.getByLabel('Model', { exact: true }).click()
  await win.getByRole('option', { name: 'llama3.3' }).click()
  await expect(start).toBeEnabled()
  await win.getByRole('button', { name: 'Cancel' }).click()
})
