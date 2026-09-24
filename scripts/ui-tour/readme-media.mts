/**
 * `npm run ui:readme` — the README's pictures: an animated hero of Cockpit at work and
 * a few stills, recorded from the ui-tour's fixture world (world.mts), so nothing in
 * them is anyone's real session, repo or account.
 *
 * The hero is a real run, not a slideshow: a task typed on Home starts an agent in a
 * fresh worktree, a second one is sent to an existing session, the board shows both
 * flying and then one landing, and ⌘K searches every agent's transcripts. The stub CLIs
 * stream slowly (UI_TOUR_STUB_DELAY_MS), which is what makes the flight visible.
 *
 * Also the social card (social-preview.png, 1280×640): GitHub shows it wherever the repo
 * is linked, and the published guide uses it as its og:image. GitHub has no API for it,
 * so a maintainer uploads it by hand under Settings › General › Social preview.
 *
 * usage: npm run ui:readme [-- --only stills,card,hero]   (the card is drawn from the Home still)
 *
 * Writes docs/public/readme/*.{gif,png}. Needs ffmpeg on PATH for the GIF — the one
 * tool outside the repo; without it the stills are still written and the run says so.
 * Unpackaged windows carry a branch banner across the top; it is cropped out, since a
 * packaged app — what a reader would install — has none.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { buildWorld, type World } from './world.mts'

const MAIN = resolve('out/main/index.js')
const OUT = resolve('docs', 'public', 'readme')
const SIZE = { width: 1280, height: 820 } as const
/** The unpackaged window's branch banner, in CSS pixels, cropped off every picture. */
const BANNER = 28

const argv = process.argv.slice(2)
const only = argv.includes('--only') ? (argv[argv.indexOf('--only') + 1] ?? '').split(',').filter(Boolean) : []
const wanted = (part: 'stills' | 'card' | 'hero'): boolean => only.length === 0 || only.includes(part)

const pause = (win: Page, ms: number): Promise<void> => win.waitForTimeout(ms)

async function home(win: Page): Promise<void> {
  await win.keyboard.press('ControlOrMeta+n')
  const search = win.getByLabel('Search sessions')
  if ((await search.inputValue()) !== '') await search.fill('')
  await pause(win, 400)
}

async function open(win: Page, title: RegExp): Promise<void> {
  await home(win)
  const row = win.getByRole('treeitem', { name: title }).first()
  const collapsed = win.locator('.repo-row[aria-expanded="false"]')
  for (let i = 0; i < 20; i++) {
    const shown = await row.waitFor({ state: 'visible', timeout: 1_500 }).then(() => true, () => false)
    if (shown || (await collapsed.count()) === 0) break
    await collapsed.first().click()
  }
  await row.click()
  await pause(win, 900)
}

/**
 * `viewport` emulates the size inside whatever window opened (what a screenshot needs);
 * `window` sizes the real window instead, which a frame stream needs — it records the
 * window's own surface, and an emulated viewport inside it comes out cut off.
 */
type Launch = { readonly env?: NodeJS.ProcessEnv; readonly size?: 'viewport' | 'window' }

async function launch(world: World, opts: Launch = {}): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({
    args: [MAIN],
    env: {
      ...process.env,
      COCKPIT_DEV_BACKGROUND: '1',
      COCKPIT_CLI_LATEST: JSON.stringify({ claude: '2.1.236', codex: '0.155.1', copilot: '1.0.87' }),
      HOME: world.home,
      COCKPIT_USER_DATA: world.userData,
      PATH: `${world.bin}:${process.env['PATH'] ?? ''}`,
      ...opts.env
    }
  })
  const win = await app.firstWindow()
  if (opts.size === 'window') {
    await app.evaluate(({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0]?.setContentSize(s.width, s.height), SIZE)
  } else {
    await win.setViewportSize(SIZE)
  }
  await pause(win, 3500)
  return { app, win }
}

/** Everything below the banner. */
const CLIP = { x: 0, y: BANNER, width: SIZE.width, height: SIZE.height - BANNER } as const

/** A still, without the banner. */
async function still(win: Page, name: string): Promise<void> {
  await win.screenshot({ path: join(OUT, `${name}.png`), clip: CLIP })
  console.log(`  ✓ ${name}.png`)
}

async function stills(world: World): Promise<void> {
  const { app, win } = await launch(world)
  try {
    await home(win)
    await still(win, 'home')
    await open(win, /Fix the login flake/)
    await still(win, 'chat')
    await open(win, /Should usage polling move/)
    await pause(win, 600)
    await still(win, 'roundtable')
    await home(win)
    await win.keyboard.press('ControlOrMeta+k')
    await win.keyboard.type('spans')
    await win.getByRole('option', { name: /Search transcripts for/ }).click()
    await win.getByRole('option', { name: /agent:|you:/ }).first().waitFor()
    await pause(win, 400)
    await still(win, 'search')
  } finally {
    await app.close()
  }
}

type Frame = { readonly file: string; readonly at: number }

/**
 * Chromium's own frame stream (CDP `Page.startScreencast`): a frame each time the page
 * repaints and nothing while it holds still, so a still board costs one frame. Polling
 * screenshots instead stalls the renderer on every capture and plays back choppy.
 * A frame's time on screen is the gap to the next one.
 */
async function recorder(win: Page, dir: string): Promise<{ readonly stop: () => Promise<Frame[]> }> {
  const cdp = await win.context().newCDPSession(win)
  const frames: Frame[] = []
  cdp.on('Page.screencastFrame', (f) => {
    const file = join(dir, `f${String(frames.length).padStart(5, '0')}.jpg`)
    writeFileSync(file, Buffer.from(f.data, 'base64'))
    frames.push({ file, at: (f.metadata.timestamp ?? Date.now() / 1000) * 1000 })
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined)
  })
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: SIZE.width, maxHeight: SIZE.height })
  return {
    stop: async () => {
      await cdp.send('Page.stopScreencast')
      frames.push({ file: '', at: Date.now() })
      return frames
    }
  }
}

/** The hero run, as frames on disk with the time each was taken. */
async function hero(world: World, dir: string): Promise<Frame[]> {
  mkdirSync(dir, { recursive: true })
  const { app, win } = await launch(world, { env: { UI_TOUR_STUB_DELAY_MS: '600' }, size: 'window' })
  try {
    await home(win)
    const rec = await recorder(win, dir)
    await pause(win, 1400)

    // a new task from Home: its own worktree, its own branch, the agent streaming
    const task = win.getByRole('textbox', { name: 'Task description' })
    await task.click()
    await task.pressSequentially('Add a retry budget to the webhook worker', { delay: 40 })
    await pause(win, 400)
    await win.keyboard.press('ControlOrMeta+Enter')
    await pause(win, 2600)

    // a follow-up to an earlier session, then back to the board with both in flight
    await open(win, /Add pagination to the sessions list/)
    const box = win.locator('.composer textarea')
    await box.pressSequentially('Cover the cursor edge case.', { delay: 40 })
    await box.press('Enter')
    await pause(win, 1400)
    await home(win)
    await pause(win, 1800)
    await win.locator('.board-row.landed').first().waitFor({ timeout: 40_000 })
    await pause(win, 1800)

    // every agent's transcripts, one search
    await win.keyboard.press('ControlOrMeta+k')
    await pause(win, 300)
    await win.keyboard.type('spans', { delay: 80 })
    await pause(win, 300)
    await win.getByRole('option', { name: /Search transcripts for/ }).click()
    await win.getByRole('option', { name: /agent:|you:/ }).first().waitFor()
    await pause(win, 2800)
    return await rec.stop()
  } finally {
    await app.close()
  }
}

/** The frames as a looping GIF, each held for as long as it was on screen. */
function gif(frames: readonly Frame[], dir: string): void {
  const gifPath = join(OUT, 'hero.gif')
  const shown = frames.slice(0, -1)
  const list = shown.flatMap((f, i) => [
    `file '${f.file}'`,
    `duration ${(((frames[i + 1]?.at ?? f.at) - f.at) / 1000).toFixed(3)}`
  ])
  // the concat demuxer drops the last entry's duration unless the file is named again
  list.push(`file '${shown[shown.length - 1]?.file ?? ''}'`)
  const listFile = join(dir, 'frames.txt')
  writeFileSync(listFile, `${list.join('\n')}\n`)
  // frames arrive at whatever size the stream chose, so the banner is cropped by ratio
  const filter =
    `crop=iw:ih*${(SIZE.height - BANNER) / SIZE.height}:0:ih*${BANNER / SIZE.height},fps=15,` +
    'scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle'
  try {
    execFileSync(
      'ffmpeg',
      ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-filter_complex', filter, '-loop', '0', gifPath],
      { stdio: 'inherit' }
    )
  } catch (err) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT'
    console.log(missing ? '  ✗ hero.gif — ffmpeg is not on PATH' : `  ✗ hero.gif — ${String(err)}`)
    return
  }
  const seconds = ((frames[frames.length - 1]?.at ?? 0) - (frames[0]?.at ?? 0)) / 1000
  console.log(`  ✓ hero.gif (${shown.length} frames, ${seconds.toFixed(1)}s, ${(statSync(gifPath).size / 1e6).toFixed(1)} MB)`)
}

/**
 * The social card, drawn from the app's own tokens and fonts, the logo exactly as it
 * ships, and the Home still beside it. Rendered in headless Chromium — no window.
 */
async function socialCard(): Promise<void> {
  const file = (p: string): string => pathToFileURL(resolve(p)).href
  const font = (w: number): string =>
    `@font-face { font-family: 'Plex Sans'; font-weight: ${w}; src: url('${file(`src/renderer/src/assets/fonts/ibm-plex-sans-latin-${w}-normal.woff2`)}'); }`
  const chip = (label: string, color: string): string =>
    `<span class="chip" style="--c:${color}">${label}</span>`
  const html = `<!doctype html><html><head><style>
    ${font(400)} ${font(600)} ${font(700)}
    @font-face { font-family: 'Plex Mono'; src: url('${file('src/renderer/src/assets/fonts/ibm-plex-mono-latin-400-normal.woff2')}'); }
    html, body { margin: 0; width: 1280px; height: 640px; overflow: hidden; }
    body { font-family: 'Plex Sans', sans-serif; color: #e8edf2;
      background: radial-gradient(ellipse at 30% 35%, #131a23 0%, #0c1219 45%, #03070c 100%); position: relative; }
    .rings { position: absolute; inset: 0; background:
      repeating-radial-gradient(circle at 30% 40%, transparent 0 58px, rgba(156,178,198,0.05) 58px 59px); }
    .copy { position: absolute; left: 72px; top: 96px; width: 520px; }
    .logo { width: 104px; height: 104px; border-radius: 22px; display: block; }
    h1 { font-size: 78px; font-weight: 700; letter-spacing: -1px; margin: 26px 0 10px; }
    p { font-size: 29px; line-height: 1.32; color: #96a5b4; margin: 0 0 30px; }
    p b { color: #e8edf2; font-weight: 600; }
    .chips { display: flex; gap: 10px; }
    .chip { font-size: 19px; font-weight: 600; padding: 7px 15px; border-radius: 999px; color: var(--c);
      border: 1.5px solid color-mix(in srgb, var(--c) 55%, transparent);
      background: color-mix(in srgb, var(--c) 12%, transparent); }
    .meta { position: absolute; left: 72px; bottom: 56px; font-family: 'Plex Mono', monospace; font-size: 17px;
      color: #7fa9cf; letter-spacing: 0.3px; }
    .shot { position: absolute; left: 640px; top: 104px; width: 780px; border-radius: 14px;
      border: 1px solid rgba(156,178,198,0.19); box-shadow: 0 24px 80px rgba(0,0,0,0.6), 0 0 0 8px rgba(72,110,148,0.08); }
  </style></head><body>
    <div class="rings"></div>
    <img class="shot" src="${file(join(OUT, 'home.png'))}">
    <div class="copy">
      <img class="logo" src="${file('resources/icon-original.webp')}">
      <h1>Cockpit</h1>
      <p>Every agent session, in every repo — <b>one window</b>.</p>
      <div class="chips">${chip('Claude Code', '#d97757')}${chip('Codex', '#10a37f')}${chip('Copilot CLI', '#9a7bff')}</div>
    </div>
    <div class="meta">macOS · open source · github.com/tashtit/cockpit</div>
  </body></html>`
  const scratch = mkdtempSync(join(tmpdir(), 'cockpit-card-'))
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 640 } })
    const htmlFile = join(scratch, 'card.html')
    writeFileSync(htmlFile, html)
    await page.goto(pathToFileURL(htmlFile).href)
    await page.evaluate(() => document.fonts.ready)
    await page.screenshot({ path: join(OUT, 'social-preview.png') })
    console.log('  ✓ social-preview.png')
  } finally {
    await browser.close()
    rmSync(scratch, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const { existsSync } = await import('node:fs')
  if (!existsSync(MAIN)) {
    console.error('out/main/index.js missing — run `npm run build` (npm run ui:readme does it for you)')
    process.exit(1)
  }
  mkdirSync(OUT, { recursive: true })
  const scratch = mkdtempSync(join(tmpdir(), 'cockpit-readme-'))
  try {
    if (wanted('stills')) {
      console.log('stills')
      await stills(buildWorld(join(scratch, 'stills')))
    }
    if (wanted('card')) await socialCard()
    if (wanted('hero')) {
      console.log('hero')
      const frames = await hero(buildWorld(join(scratch, 'hero')), join(scratch, 'frames'))
      gif(frames, join(scratch, 'frames'))
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

await main()
