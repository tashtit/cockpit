import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { closeApp } from './close-app'
import { launchEnv } from './launch-env'

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
const ghConfig = join(root, 'gh-config')

// The seeded providers point at this stub gateway, never at a real host: main fetches a
// provider's live catalog the moment it is picked, and a dev machine running Ollama on
// its default port (11434) answered with its own models in place of the seeded ones.
// One server covers both catalog shapes main knows — anthropic (`<base>/v1/models`)
// and openai (`<base>/models`) — under distinct path prefixes.
const ANTHROPIC_MODELS = ['claude-fable-5', 'claude-haiku-4-5']
const OLLAMA_MODELS = ['llama3.3', 'mistral-small']
const catalogs: Record<string, readonly string[]> = {
  '/anthropic/v1/models': ANTHROPIC_MODELS,
  '/ollama/v1/models': OLLAMA_MODELS
}
const gateway = createServer((req, res) => {
  const models = catalogs[new URL(req.url ?? '/', 'http://localhost').pathname]
  if (!models) {
    res.writeHead(404).end()
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ object: 'list', data: models.map((id) => ({ id })) }))
})
let gatewayUrl = ''

let app: ElectronApplication
let win: Page

test.beforeAll(async () => {
  // a port the OS hands out, on loopback only — no fixed port can collide with a real service
  await new Promise<void>((ready) => gateway.listen(0, '127.0.0.1', ready))
  gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`

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
          baseUrl: `${gatewayUrl}/anthropic`,
          models: ANTHROPIC_MODELS
        },
        {
          id: 'ep-ollama',
          label: 'ollama-local',
          type: 'openai',
          baseUrl: `${gatewayUrl}/ollama/v1`,
          // cached catalog deliberately behind the live one: the picker offering
          // mistral-small proves the listing came from the gateway, not this seed
          models: ['llama3.3']
        }
      ]
    })
  )

  // an empty gh config home: the GitHub identity the sidebar shows must not be this
  // machine's real `gh` login (and `gh api user` then fails fast, without a network call)
  mkdirSync(ghConfig, { recursive: true })
  app = await electron.launch({
    args: [mainEntry],
    env: launchEnv({ COCKPIT_USER_DATA: userData, GH_CONFIG_DIR: ghConfig })
  })
  win = await app.firstWindow()
})

test.afterAll(async () => {
  await closeApp(app)
  gateway.closeAllConnections()
  await new Promise<void>((done) => gateway.close(() => done()))
})

test('settings lists seeded providers with agent applicability, and adds/removes one live', async () => {
  await win.getByRole('button', { name: 'Settings', exact: true }).click()
  await win.getByRole('tab', { name: 'Providers' }).click()
  await expect(win.getByRole('button', { name: 'Add a model provider…' })).toBeVisible()

  // seeded rows: type chip, per-type agent applicability, cached model count
  const anthropicRow = win.locator('.source-row', { hasText: 'anthropic-gw' })
  await expect(anthropicRow).toContainText(`${gatewayUrl}/anthropic`)
  await expect(anthropicRow).toContainText('works with Claude and Copilot')
  await expect(anthropicRow).toContainText('no key · 2 models')
  const ollamaRow = win.locator('.source-row', { hasText: 'ollama-local' })
  await expect(ollamaRow).toContainText('works with Copilot')

  // the add form is folded until asked for — Settings opens as a readout
  await expect(win.getByLabel('Display name')).toHaveCount(0)
  await win.getByRole('button', { name: 'Add a model provider…' }).click()

  // a bad definition is refused by main and surfaces verbatim
  await win.getByLabel('Display name').fill('broken')
  await win.getByLabel('Base URL').fill('not a url')
  await win.getByRole('button', { name: 'Add provider' }).click()
  await expect(win.getByText(/Invalid provider:/)).toBeVisible()

  // a real add round-trips through main into config; the model probe fails fast
  // (nothing listens on the port) and reports as advice, not an error. The refused
  // attempt left the form open with its values — a rejected add must not fold away
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
  // The composer card mounts only once the accounts snapshot lands, and that waits on
  // `gh api user` (bounded at 10s in main) — on a slow runner it can appear after this
  // test has started. Wait it out before touching the tree: row actions are display:none
  // until the row is hovered or holds focus (the real cursor makes synthetic :hover
  // flaky in a headed window, so this uses the keyboard path), and a mount arriving
  // between the focus and the click must not be what decides whether the button is there.
  await expect(win.getByLabel('Task description')).toBeVisible({ timeout: 15_000 })
  await win.getByRole('treeitem', { name: /acme\/\s*rocket/ }).focus()
  await win.getByRole('button', { name: 'New session in rocket' }).click()
  await expect(win.getByRole('heading', { name: 'New session' })).toBeVisible()
  const agents = win.getByRole('group', { name: 'Agent' })

  // claude: only the anthropic-type provider is offered
  await win.getByLabel('Model provider').click()
  await expect(win.getByRole('option', { name: 'anthropic-gw' })).toBeVisible()
  await expect(win.getByRole('option', { name: 'ollama-local' })).toHaveCount(0)
  await win.getByRole('option', { name: 'anthropic-gw' }).click()
  await expect(win.getByText(`Runs on ${gatewayUrl}/anthropic`)).toBeVisible()
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
  // the live listing replaced the cached one: only the gateway serves mistral-small
  await expect(win.getByRole('option', { name: 'mistral-small' })).toBeVisible()
  await win.getByRole('option', { name: 'llama3.3' }).click()
  await expect(start).toBeEnabled()
  await win.getByRole('button', { name: 'Cancel' }).click()
})
