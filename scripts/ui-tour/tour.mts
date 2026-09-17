/**
 * `npm run ui:tour` — drive the built app through every view and state it has, against
 * the fixture world in world.mts, and write a screenshot of each plus a contact sheet
 * (test-results/ui-tour/index.html) to review them in one place.
 *
 * Tests assert behaviour; this shows what a person sees. Every state that matters is
 * reached for real rather than mocked: sessions actually run (the stub CLIs stream
 * slowly) so the board flies, then land when you walk away; a first launch runs
 * against an empty home; each view is shot at desktop size and at the 560×420 floor.
 *
 * usage: npm run ui:tour [-- --only <substring,…>] [-- --no-live]
 * A shot that can't be reached is recorded as missing in the sheet and fails the run,
 * so a drifted selector is loud rather than a silently absent picture.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { buildWorld, type World } from './world.mts'

const MAIN = resolve('out/main/index.js')
const OUT = resolve('test-results', 'ui-tour')
const DESKTOP = { width: 1280, height: 820 } as const
const FLOOR = { width: 560, height: 420 } as const

type Size = { readonly width: number; readonly height: number }
type Shot = {
  /** file name and sheet label, e.g. `chat-claude` */
  readonly name: string
  /** the sheet groups shots by view */
  readonly view: string
  /** grow the viewport before capturing, for card views that scroll inside themselves */
  readonly tall?: number
  readonly go: (win: Page) => Promise<void>
}
type Outcome = { readonly shot: Shot; readonly file: string; readonly size: Size } | { readonly shot: Shot; readonly missing: string; readonly size: Size }

const argv = process.argv.slice(2)
const only = argv.includes('--only') ? (argv[argv.indexOf('--only') + 1] ?? '').split(',').filter(Boolean) : []
const live = !argv.includes('--no-live')
const wanted = (s: Shot): boolean => only.length === 0 || only.some((o) => s.name.includes(o) || s.view.includes(o))

// ---------- navigation helpers: the same paths a person takes ----------

const pause = (win: Page, ms: number): Promise<void> => win.waitForTimeout(ms)
async function home(win: Page): Promise<void> {
  // every shot starts from the same place: home, and the whole tree — a search left
  // in the box would turn every later tree lookup into a search-result lookup
  await win.keyboard.press('ControlOrMeta+n')
  const search = win.getByLabel('Search sessions')
  if ((await search.inputValue()) !== '') await search.fill('')
  await pause(win, 400)
}
async function nav(win: Page, label: string): Promise<void> {
  await home(win)
  await win.getByRole('button', { name: label, exact: true }).click()
  await pause(win, 1200)
}
async function open(win: Page, title: RegExp): Promise<void> {
  await home(win)
  await win.getByRole('treeitem', { name: title }).first().click()
  await pause(win, 900)
}
async function send(win: Page, title: RegExp, text: string): Promise<void> {
  await open(win, title)
  const box = win.locator('.composer textarea')
  await box.fill(text)
  await box.press('Enter')
}

// ---------- the shots ----------

const STATIC: readonly Shot[] = [
  { view: 'home', name: 'home', go: home },
  { view: 'home', name: 'home-tall', tall: 1500, go: home },
  { view: 'palette', name: 'palette-empty', go: async (w) => { await home(w); await w.keyboard.press('ControlOrMeta+k'); await pause(w, 500) } },
  { view: 'palette', name: 'palette-query', go: async (w) => { await home(w); await w.keyboard.press('ControlOrMeta+k'); await w.keyboard.type('rocket'); await pause(w, 700) } },
  { view: 'palette', name: 'palette-transcripts', go: async (w) => { await home(w); await w.keyboard.press('ControlOrMeta+k'); await w.keyboard.type('spans'); await w.getByRole('option', { name: /Search transcripts for/ }).click(); await w.getByRole('option', { name: /agent:|you:/ }).first().waitFor(); await pause(w, 400) } },
  { view: 'sidebar', name: 'sidebar-search', go: async (w) => { await home(w); await w.getByLabel('Search sessions').fill('fix'); await pause(w, 800) } },
  { view: 'sidebar', name: 'sidebar-project-filter', go: async (w) => { await home(w); await w.getByRole('button', { name: 'Choose projects to display' }).click(); await pause(w, 300) } },
  { view: 'settings', name: 'settings', tall: 2400, go: (w) => nav(w, 'Settings') },
  { view: 'agents', name: 'agents', tall: 1600, go: (w) => nav(w, 'Agents') },
  ...['Instructions', 'MCP servers', 'Skills', 'Plugins', 'Marketplaces'].map(
    (section): Shot => ({
      view: 'agents',
      name: `agents-${section.toLowerCase().replace(/\s+/g, '-')}`,
      tall: 1600,
      go: async (w) => {
        await nav(w, 'Agents')
        await w.getByRole('tab', { name: new RegExp(`^${section}`) }).click()
        await pause(w, 500)
      }
    })
  ),
  // a disagreement opened up: what each agent runs, and the three answers to it —
  // read-only, so the shots after it see the world unchanged
  {
    view: 'agents',
    name: 'agents-row-open',
    tall: 1100,
    go: async (w) => {
      await nav(w, 'Agents')
      await w.getByRole('tab', { name: /^MCP servers/ }).click()
      await w.locator('.pnl-entry', { hasText: 'github' }).click()
      await pause(w, 500)
    }
  },
  { view: 'profile', name: 'profile', tall: 1700, go: (w) => nav(w, 'Profile') },
  { view: 'cleanup', name: 'cleanup', tall: 1200, go: (w) => nav(w, 'Cleanup') },
  {
    view: 'new session',
    name: 'new-session',
    tall: 1100,
    go: async (w) => {
      await home(w)
      await w.getByRole('treeitem', { name: /acme\/\s*rocket/ }).focus()
      await w.getByRole('button', { name: 'New session in rocket' }).click()
      await pause(w, 500)
    }
  },
  { view: 'roundtable', name: 'new-roundtable', tall: 1000, go: async (w) => { await home(w); await w.getByRole('button', { name: /Start a roundtable/ }).click(); await pause(w, 500) } },
  { view: 'roundtable', name: 'roundtable-consensus', go: (w) => open(w, /Should usage polling move/) },
  { view: 'roundtable', name: 'roundtable-open', go: (w) => open(w, /Monorepo or polyrepo/) },
  { view: 'chat', name: 'chat-claude', go: (w) => open(w, /Fix the login flake/) },
  {
    view: 'chat',
    name: 'chat-work-log-open',
    go: async (w) => {
      await open(w, /Fix the login flake/)
      await w.locator('.messages').evaluate((el) => el.scrollTo({ top: 0 }))
      await w.locator('.tool-run summary').first().click()
      await pause(w, 300)
    }
  },
  { view: 'chat', name: 'chat-worktree', go: (w) => open(w, /Add pagination to the sessions list/) },
  { view: 'chat', name: 'chat-codex', go: (w) => open(w, /Add a fallback when the billing API/) },
  { view: 'chat', name: 'chat-copilot', go: (w) => open(w, /Tidy the usage panel spacing/) },
  {
    view: 'chat',
    name: 'handoff',
    tall: 1300,
    go: async (w) => {
      await open(w, /Tidy the usage panel spacing/)
      await w.getByRole('button', { name: /Continue in another agent/ }).click()
      await pause(w, 900)
    }
  }
]

/** The floor gets the views whose chrome is width-budgeted, not every section again. */
const AT_FLOOR = new Set(['home', 'palette-empty', 'palette-transcripts', 'settings', 'agents', 'profile', 'cleanup', 'new-session', 'chat-claude', 'roundtable-consensus'])

const LIVE: readonly Shot[] = [
  {
    view: 'live',
    name: 'chat-streaming',
    go: async (w) => {
      await send(w, /Fix the login flake/, 'Run the whole suite once more.')
      await pause(w, 1500)
    }
  },
  {
    view: 'live',
    name: 'home-flying',
    go: async (w) => {
      // walk away while it runs, and start a second turn elsewhere
      await send(w, /Add pagination to the sessions list/, 'Cover the cursor edge case.')
      await home(w)
      await pause(w, 1200)
    }
  },
  {
    view: 'live',
    name: 'home-landed',
    go: async (w) => {
      await home(w)
      await w.locator('.board-row.landed').first().waitFor({ timeout: 40_000 })
      await pause(w, 600)
    }
  },
  { view: 'live', name: 'palette-landed', go: async (w) => { await home(w); await w.keyboard.press('ControlOrMeta+k'); await pause(w, 600) } }
]

const FIRST_RUN: readonly Shot[] = [
  { view: 'first run', name: 'first-run-home', go: home },
  { view: 'first run', name: 'first-run-settings', go: (w) => nav(w, 'Settings') },
  { view: 'first run', name: 'first-run-agents', go: (w) => nav(w, 'Agents') }
]

// ---------- running ----------

async function launch(world: World, extraEnv: NodeJS.ProcessEnv = {}): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({
    args: [MAIN],
    env: {
      ...process.env,
      HOME: world.home,
      COCKPIT_USER_DATA: world.userData,
      PATH: `${world.bin}:${process.env['PATH'] ?? ''}`,
      ...extraEnv
    }
  })
  const win = await app.firstWindow()
  await win.setViewportSize(DESKTOP)
  // first index of the world, accounts, usage
  await pause(win, 3500)
  return { app, win }
}

async function capture(win: Page, shots: readonly Shot[], size: Size, suffix: string): Promise<Outcome[]> {
  const out: Outcome[] = []
  for (const shot of shots.filter(wanted)) {
    const file = `${shot.name}${suffix}.png`
    try {
      await win.setViewportSize(size)
      await win.keyboard.press('Escape')
      await shot.go(win)
      if (shot.tall && size === DESKTOP) {
        await win.setViewportSize({ width: size.width, height: shot.tall })
        await pause(win, 500)
      }
      await win.screenshot({ path: join(OUT, file) })
      out.push({ shot, file, size })
      console.log(`  ✓ ${file}`)
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? 'unreachable'
      out.push({ shot, missing: reason, size })
      console.log(`  ✗ ${file} — ${reason}`)
    }
  }
  return out
}

function sheet(outcomes: readonly Outcome[]): string {
  const views = [...new Set(outcomes.map((o) => o.shot.view))]
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const card = (o: Outcome): string =>
    'file' in o
      ? `<figure><a href="${o.file}"><img src="${o.file}" loading="lazy" alt="${esc(o.shot.name)}"></a><figcaption>${esc(o.file)} · ${o.size.width}×${o.size.height}</figcaption></figure>`
      : `<figure class="missing"><div>missing</div><figcaption>${esc(o.shot.name)} · ${esc(o.missing)}</figcaption></figure>`
  return `<!doctype html><meta charset="utf-8"><title>Cockpit ui-tour</title>
<style>
  body { margin: 0; padding: 24px; background: #070b11; color: #e7edf3; font: 13px/1.5 ui-monospace, 'SF Mono', monospace; }
  h1 { font-size: 15px; letter-spacing: 1px; text-transform: uppercase; margin: 0 0 4px; }
  h2 { font-size: 11px; letter-spacing: 1px; text-transform: uppercase; color: #94a3b3; margin: 28px 0 10px; }
  p { color: #94a3b3; margin: 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; }
  figure { margin: 0; }
  img { width: 100%; border: 1px solid rgba(156,178,198,.24); border-radius: 6px; display: block; }
  figcaption { color: #94a3b3; font-size: 11px; margin-top: 6px; }
  .missing div { aspect-ratio: 16/10; display: grid; place-items: center; border: 1px dashed #d29922; color: #d29922; border-radius: 6px; }
</style>
<h1>Cockpit ui-tour</h1>
<p>${outcomes.filter((o) => 'file' in o).length} shots · ${outcomes.filter((o) => !('file' in o)).length} missing · fixture data, invented</p>
${views.map((v) => `<h2>${esc(v)}</h2><div class="grid">${outcomes.filter((o) => o.shot.view === v).map(card).join('')}</div>`).join('\n')}
`
}

async function main(): Promise<void> {
  const { existsSync } = await import('node:fs')
  if (!existsSync(MAIN)) {
    console.error('out/main/index.js missing — run `npm run build` (npm run ui:tour does it for you)')
    process.exit(1)
  }
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(OUT, { recursive: true })
  const scratch = mkdtempSync(join(tmpdir(), 'cockpit-ui-tour-'))
  const outcomes: Outcome[] = []
  try {
    console.log('world: desktop')
    const world = buildWorld(join(scratch, 'world'))
    {
      const { app, win } = await launch(world)
      outcomes.push(...(await capture(win, STATIC, DESKTOP, '')))
      console.log('world: 560×420')
      outcomes.push(...(await capture(win, STATIC.filter((s) => AT_FLOOR.has(s.name)), FLOOR, '-floor')))
      await app.close()
    }
    if (live) {
      console.log('world: live turns (stub agents stream, then land)')
      const fresh = buildWorld(join(scratch, 'live'))
      const { app, win } = await launch(fresh, { UI_TOUR_STUB_DELAY_MS: '900' })
      outcomes.push(...(await capture(win, LIVE, DESKTOP, '')))
      await app.close()
    }
    console.log('world: first run')
    const empty = buildWorld(join(scratch, 'empty'), { populated: false })
    {
      const { app, win } = await launch(empty)
      outcomes.push(...(await capture(win, FIRST_RUN, DESKTOP, '')))
      await app.close()
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
  writeFileSync(join(OUT, 'index.html'), sheet(outcomes))
  const missing = outcomes.filter((o) => !('file' in o)).length
  console.log(`\n${outcomes.length - missing} shots${missing ? `, ${missing} missing` : ''} → ${join(OUT, 'index.html')}`)
  process.exit(missing ? 1 : 0)
}

await main()
