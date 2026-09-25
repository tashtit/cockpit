/**
 * `npm run ui:tour` — drive the built app through every view and state it has, against
 * the fixture world in world.mts, and write a screenshot of each plus a contact sheet
 * (test-results/ui-tour/index.html) to review them in one place.
 *
 * Tests assert behaviour; this shows what a person sees. Every state that matters is
 * reached for real rather than mocked: sessions actually run (the stub CLIs stream
 * slowly) so the board flies, then land when you walk away; a first launch runs
 * against an empty home; each width-budgeted view is shot at desktop size, at an
 * ordinary 900×700 window, at the 560×420 floor, and at 200% zoom.
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
/**
 * An ordinary working window — and the band two fixed sizes miss. Cards are as wide as
 * the window minus a sidebar the user drags, so a layout can be right at 1280 and right
 * at the floor and still be wrong here: the home board pushed the composer off the
 * bottom edge at exactly this size, and a Settings usage row painted its reset time over
 * the session count. Both looked perfect at the other two.
 */
const MID = { width: 900, height: 700 } as const
const FLOOR = { width: 560, height: 420 } as const

type Size = { readonly width: number; readonly height: number }
type Shot = {
  /** file name and sheet label, e.g. `chat-claude` */
  readonly name: string
  /** the sheet groups shots by view */
  readonly view: string
  /** grow the viewport before capturing, for card views that scroll inside themselves */
  readonly tall?: number
  /** `app` is main, for the states only main can put the window in (see `pushUpdate`) */
  readonly go: (win: Page, app: ElectronApplication) => Promise<void>
  /** undo what `go` left in the app's own memory (a dragged rail), so later shots start clean */
  readonly after?: (win: Page, app: ElectronApplication) => Promise<void>
}
/** How a pass is shot: the window, and the zoom the person is at inside it. */
type Pass = { readonly size: Size; readonly suffix: string; readonly zoom?: number }
type Outcome = ({ readonly file: string } | { readonly missing: string }) & {
  readonly shot: Shot
  readonly size: Size
  readonly zoom: number
}

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
  const row = win.getByRole('treeitem', { name: title }).first()
  // repos keep a-z (or dragged) order and only the first one auto-expands, so the
  // session may sit in a collapsed repo: open them in turn until it is on screen
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
 * Stand in for main where a fixture file can't: the updater (a build run from out/
 * reports `unsupported` and never checks) and the daily cleanup check (it waits minutes
 * after launch). The tour pushes what main would, on the channel main itself uses
 * (`PUSH.updateState`, `PUSH.cleanupNotice` — the tour cannot import the contract, so a
 * renamed channel shows up here as a missing shot).
 */
async function push(app: ElectronApplication, channel: string, payload: unknown): Promise<void> {
  await app.evaluate(({ BrowserWindow }, [c, p]) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(c as string, p)
  }, [channel, payload] as const)
}
const pushUpdate = (app: ElectronApplication, state: Record<string, unknown>): Promise<void> =>
  push(app, 'update-state', state)
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
  {
    view: 'sidebar',
    name: 'sidebar-archived',
    go: async (w) => {
      await home(w)
      // a row in the tree, so role=treeitem and not button — a role=tree may own
      // nothing else, and asking for the wrong role is a 30s wait, not a miss
      await w.getByRole('treeitem', { name: /^Archived/ }).first().click()
      await pause(w, 300)
    }
  },
  { view: 'sidebar', name: 'sidebar-project-filter', go: async (w) => { await home(w); await w.getByRole('button', { name: 'Choose projects to display' }).click(); await pause(w, 300) } },
  // the rail dragged out to its ceiling — a width no window size reaches on its own,
  // with the deck reflowing behind it; the sash itself is the lit hairline on the border
  {
    view: 'sidebar',
    name: 'sidebar-wide',
    go: async (w) => {
      await home(w)
      await w.getByRole('separator', { name: 'Sidebar width' }).focus()
      await w.keyboard.press('End')
      await pause(w, 400)
    },
    // a double-click on the sash forgets the width; on the rail's side of the border
    after: (w) => w.getByRole('separator', { name: 'Sidebar width' }).dblclick({ position: { x: 2, y: 300 } })
  },
  // a newer build downloaded and waiting: the footer's one-click restart, over the usage
  // meters — the rail's most crowded row stack, and at the floor its tightest width
  {
    view: 'sidebar',
    name: 'sidebar-update',
    go: async (w, app) => {
      await home(w)
      await pushUpdate(app, { status: 'ready', version: '0.30.0' })
      await w.getByRole('button', { name: 'Restart to update Cockpit to 0.30.0' }).waitFor()
    },
    after: (_w, app) => pushUpdate(app, { status: 'unsupported', message: 'development run' })
  },
  // a download that could not be installed: the bar turns to why, and opens About for it
  {
    view: 'sidebar',
    name: 'sidebar-update-failed',
    go: async (w, app) => {
      await home(w)
      await pushUpdate(app, { status: 'error', version: '0.30.0', message: 'No space left on device' })
      await w.getByRole('button', { name: /0\.30\.0 could not be installed/ }).waitFor()
    },
    after: (_w, app) => pushUpdate(app, { status: 'unsupported', message: 'development run' })
  },
  // the daily cleanup check found something new: the Cleanup key's amber dot, and its name
  // saying what is waiting
  {
    view: 'sidebar',
    name: 'sidebar-cleanup-reminder',
    go: async (w, app) => {
      await home(w)
      await push(app, 'cleanup-notice', {
        at: Date.now(),
        staleDays: 30,
        sessions: 12,
        worktrees: 3,
        tables: 0,
        processes: 1,
        bytes: 2_100_000_000
      })
      await w.getByRole('button', { name: /^Cleanup can free 2\.1 GB/ }).waitFor()
    },
    after: (_w, app) => push(app, 'cleanup-notice', null)
  },
  { view: 'settings', name: 'settings', go: (w) => nav(w, 'Settings') },
  // the agent CLIs against their latest releases — one behind, with its Update
  {
    view: 'settings',
    name: 'settings-clis',
    go: async (w) => {
      await nav(w, 'Settings')
      const behind = w.getByText('2.1.278 available')
      await behind.waitFor()
      await behind.evaluate((el) => el.scrollIntoView({ block: 'center' }))
      await pause(w, 300)
    }
  },
  // one shot per tab: each is its own page now, and a tab nobody opens is a tab
  // nobody sees break
  ...['View', 'Notifications', 'Providers', 'Backup', 'About'].map(
    (t): Shot => ({
      view: 'settings',
      name: `settings-${t.toLowerCase().replace(/\s+/g, '-')}`,
      go: async (w) => {
        await nav(w, 'Settings')
        await w.getByRole('tab', { name: t }).click()
        await pause(w, 400)
      }
    })
  ),
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
  // the version question, on the one kind of server that can have an answer: a
  // pinned package. Needs the network — offline the line says so instead
  {
    view: 'agents',
    name: 'agents-mcp-version',
    tall: 1100,
    go: async (w) => {
      await nav(w, 'Agents')
      await w.getByRole('tab', { name: /^MCP servers/ }).click()
      await w.locator('.pnl-entry', { hasText: 'playwright' }).click()
      await pause(w, 900)
    }
  },
  { view: 'profile', name: 'profile', tall: 1100, go: (w) => nav(w, 'Profile') },
  ...['Agents', 'Code'].map(
    (t): Shot => ({
      view: 'profile',
      name: `profile-${t.toLowerCase()}`,
      tall: 1100,
      go: async (w) => {
        await nav(w, 'Profile')
        await w.getByRole('tab', { name: t }).click()
        await pause(w, 300)
      }
    })
  ),
  // one shot per list: each is its own page now
  ...['Sessions', 'Processes', 'Roundtables', 'Worktrees'].map(
    (t, i): Shot => ({
      view: 'cleanup',
      name: i === 0 ? 'cleanup' : `cleanup-${t.toLowerCase()}`,
      tall: 1200,
      go: async (w) => {
        await nav(w, 'Cleanup')
        // the scan walks every source and repo — a shot taken mid-scan shows empty lists
        await w.getByRole('button', { name: 'Rescan' }).waitFor({ timeout: 60_000 })
        await w.getByRole('tab', { name: new RegExp(`^${t}`) }).click()
        await pause(w, 300)
      }
    })
  ),
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
  // a seat row is three controls wide and a twin can be an exact repeat: the state the
  // plain form never shows — the duplicate mark, its hint, and the row wrapping at the floor
  {
    view: 'roundtable',
    name: 'new-roundtable-seats',
    tall: 1000,
    go: async (w) => {
      await home(w)
      await w.getByRole('button', { name: /Start a roundtable/ }).click()
      await w.getByRole('button', { name: 'Add Claude seat' }).click()
      await w.getByRole('button', { name: 'Add Copilot seat' }).click()
      await w.getByRole('group', { name: 'Claude #2 seat' }).scrollIntoViewIfNeeded()
      await pause(w, 400)
    }
  },
  { view: 'roundtable', name: 'roundtable-consensus', go: (w) => open(w, /Should usage polling move/) },
  // a seat on an account whose CLI session has expired: said on the card, before the
  // table starts, with the command that fixes it — and Open held until it is
  {
    view: 'roundtable',
    name: 'new-roundtable-signed-out',
    tall: 1000,
    go: async (w) => {
      await home(w)
      await w.getByRole('button', { name: /Start a roundtable/ }).click()
      // by keyboard: at the floor the pinned footer can sit over the picker
      const account = w.getByRole('button', { name: /^Claude account / })
      await account.focus()
      await w.keyboard.press('Enter')
      await w.keyboard.press('ArrowDown')
      await w.keyboard.press('Enter')
      await w.getByRole('group', { name: 'Claude seat' }).scrollIntoViewIfNeeded()
      await pause(w, 800)
    }
  },
  // the model picker open on a codex seat: every model the CLI's own catalog lists
  {
    view: 'roundtable',
    name: 'new-roundtable-models',
    // no `tall`: growing the viewport before the capture would close the open listbox
    go: async (w) => {
      await home(w)
      await w.getByRole('button', { name: /Start a roundtable/ }).click()
      await w.getByRole('button', { name: /^Codex model / }).click()
      await pause(w, 400)
    }
  },
  // a table's spend in its header, and the in-place editor it opens
  {
    view: 'roundtable',
    name: 'roundtable-limits',
    go: async (w) => {
      await open(w, /Monorepo or polyrepo/)
      await w.locator('.rt-budget').click()
      await pause(w, 300)
    }
  },
  { view: 'roundtable', name: 'roundtable-open', go: (w) => open(w, /Monorepo or polyrepo/) },
  { view: 'chat', name: 'chat-claude', go: (w) => open(w, /Fix the login flake/) },
  // a transcript-search hit opens its session at the message: ringed, mid-viewport
  {
    view: 'chat',
    name: 'chat-from-search',
    go: async (w) => {
      await home(w)
      await w.keyboard.press('ControlOrMeta+k')
      await w.keyboard.type('spans')
      await w.getByRole('option', { name: /Search transcripts for/ }).click()
      await w.getByRole('option', { name: /agent:/ }).first().click()
      await w.locator('.messages .anchored').waitFor()
      await pause(w, 400)
    }
  },
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
  // the agent stopped to ask: its options, answerable in place
  { view: 'chat', name: 'chat-asks', go: (w) => open(w, /Split the SDK into a monorepo/) },
  // the agent's work beside the conversation: a row opens the panel at its own edit
  {
    view: 'chat',
    name: 'chat-work-edits',
    go: async (w) => {
      await open(w, /Fix the login flake/)
      await w.locator('.messages').evaluate((el) => el.scrollTo({ top: 0 }))
      await w.locator('.tool-run summary').first().click()
      await w.locator('.tool-open', { hasText: 'src/auth/login.ts' }).first().click()
      await pause(w, 500)
    }
  },
  // ⌘J opens on what matters now — here the task list still under way
  {
    view: 'chat',
    name: 'chat-work-todos',
    go: async (w) => {
      await open(w, /Fix the login flake/)
      await w.keyboard.press('ControlOrMeta+j')
      await pause(w, 400)
    }
  },
  // how the checks it ran ended: e2e failed then passed, with a file written since
  {
    view: 'chat',
    name: 'chat-work-checks',
    go: async (w) => {
      await open(w, /Fix the login flake/)
      await w.keyboard.press('ControlOrMeta+j')
      await w.getByRole('tab', { name: /Checks/ }).click()
      await pause(w, 400)
    }
  },
  // what it sent: a report drawn as markdown, a chart drawn as itself, the page it opened
  {
    view: 'chat',
    name: 'chat-work-files',
    go: async (w) => {
      await open(w, /Why is the bundle 2MB/)
      await w.keyboard.press('ControlOrMeta+j')
      await w.locator('.work-shared-image').waitFor()
      await pause(w, 400)
    }
  },
  // a plan waiting for approval is read in its card, and opens in the panel
  { view: 'chat', name: 'chat-plan', go: (w) => open(w, /Plan rate limiting for the public API/) },
  {
    view: 'chat',
    name: 'chat-work-plan',
    go: async (w) => {
      await open(w, /Plan rate limiting for the public API/)
      await w.getByRole('button', { name: 'Open in the Work panel' }).click()
      await pause(w, 500)
    }
  },
  { view: 'chat', name: 'chat-codex', go: (w) => open(w, /Add a fallback when the billing API/) },
  { view: 'chat', name: 'chat-copilot', go: (w) => open(w, /Tidy the usage panel spacing/) },
  // Copilot's to-do table, read from its session database — one step blocked
  {
    view: 'chat',
    name: 'chat-work-copilot-todos',
    go: async (w) => {
      await open(w, /Tidy the usage panel spacing/)
      await w.keyboard.press('ControlOrMeta+j')
      await pause(w, 400)
    }
  },
  // a subagent's edit, from its own log, after the call that handed the work off
  {
    view: 'chat',
    name: 'chat-work-subagent',
    go: async (w) => {
      await open(w, /Add pagination to the sessions list/)
      await w.locator('.tool-open', { hasText: 'src/sessions.ts' }).first().click()
      await pause(w, 500)
    }
  },
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

/**
 * The views whose chrome is width-budgeted, not every section again — the same list
 * serves every narrow pass, so there is no second hand-curated set to drift out of
 * step with this one.
 */
const AT_FLOOR = new Set(['home', 'sidebar-update', 'palette-empty', 'palette-transcripts', 'settings', 'agents', 'profile', 'profile-agents', 'cleanup', 'new-session', 'chat-claude', 'chat-asks', 'chat-work-edits', 'chat-work-checks', 'chat-work-files', 'chat-plan', 'new-roundtable-seats', 'new-roundtable-signed-out', 'roundtable-consensus'])

const LIVE: readonly Shot[] = [
  // a table mid-round: each seat still at it with its time and skip, and a follow-up
  // typed while it runs — the composer offers to send it after the round, or now
  {
    view: 'live',
    name: 'roundtable-running',
    go: async (w) => {
      await open(w, /Monorepo or polyrepo/)
      const box = w.getByRole('textbox', { name: 'Message the roundtable' })
      await box.fill('Which one is cheaper to run in CI?')
      await box.press('Enter')
      await pause(w, 1500)
      await box.fill('And how do releases work?')
      await pause(w, 400)
    }
  },
  {
    view: 'live',
    name: 'chat-streaming',
    go: async (w) => {
      await send(w, /Fix the login flake/, 'Run the whole suite once more.')
      await pause(w, 1500)
    }
  },
  // a turn read from the top: the reply keeps arriving below, and the key says so. The
  // chat stays open from the shot above (re-opening a session detaches the view from
  // the turn Cockpit is running in it), and this turn waits for that one's Send to be
  // back before it starts
  {
    view: 'live',
    name: 'chat-new-below',
    go: async (w) => {
      if (!(await w.locator('.chat-title').isVisible())) await open(w, /Fix the login flake/)
      const box = w.locator('.composer textarea')
      await box.fill('And the slow DNS case?')
      // Send comes back when the turn above ends — and stays held a beat longer while the
      // log's own liveness settles ("working elsewhere"), so wait for it to be pressable
      await w.waitForFunction(
        () => {
          const send = [...document.querySelectorAll<HTMLButtonElement>('.composer button')].find(
            (b) => b.textContent?.trim() === 'Send'
          )
          return !!send && !send.disabled
        },
        undefined,
        { timeout: 40_000 }
      )
      await box.press('Enter')
      await w.locator('.messages').evaluate((el) => el.scrollTo({ top: 0 }))
      // the key's line is zero-height on purpose (Playwright reads that as hidden), so
      // wait for the key itself
      await w.locator('.jump-latest.on button').waitFor({ timeout: 15_000 })
      await pause(w, 300)
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

/**
 * Every window the tour opens stays in the background — never fronted, never focused —
 * and inherits `COCKPIT_DEV_DISPLAY`, so a developer who exports it gets the tour on
 * that screen rather than the one they are working on. Mirrors tests/e2e/launch-env.ts;
 * kept separate because tests import from scripts/, never the other way.
 */
const PINNED = {
  COCKPIT_DEV_BACKGROUND: '1',
  // the agent-CLI update check's "latest" releases, so the tour never reaches the
  // network — and shows one CLI behind (the stubs report 2.1.236 / 0.155.1 / 1.0.87)
  COCKPIT_CLI_LATEST: JSON.stringify({ claude: '2.1.278', codex: '0.155.1', copilot: '1.0.87' })
}

async function launch(world: World, extraEnv: NodeJS.ProcessEnv = {}): Promise<{ app: ElectronApplication; win: Page }> {
  const app = await electron.launch({
    args: [MAIN],
    env: {
      ...process.env,
      ...PINNED,
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

async function capture(
  { app, win }: { readonly app: ElectronApplication; readonly win: Page },
  shots: readonly Shot[],
  pass: Pass
): Promise<Outcome[]> {
  const { size, suffix, zoom = 1 } = pass
  const out: Outcome[] = []
  await win.evaluate((z) => window.cockpit.setZoomFactor(z), zoom)
  for (const shot of shots.filter(wanted)) {
    const file = `${shot.name}${suffix}.png`
    try {
      await win.setViewportSize(size)
      await win.keyboard.press('Escape')
      await shot.go(win, app)
      // the floor is the constraint under test, so it is shot at its real height; every
      // other size grows to show the whole card, which is where a long panel's bugs are
      if (shot.tall && size !== FLOOR) {
        await win.setViewportSize({ width: size.width, height: shot.tall })
        await pause(win, 500)
      }
      await win.screenshot({ path: join(OUT, file) })
      out.push({ shot, file, size, zoom })
      console.log(`  ✓ ${file}`)
      if (shot.after) await shot.after(win, app)
    } catch (err) {
      const reason = (err instanceof Error ? err.message : String(err)).split('\n')[0] ?? 'unreachable'
      out.push({ shot, missing: reason, size, zoom })
      console.log(`  ✗ ${file} — ${reason}`)
    }
  }
  await win.evaluate(() => window.cockpit.setZoomFactor(1))
  return out
}

function sheet(outcomes: readonly Outcome[]): string {
  const views = [...new Set(outcomes.map((o) => o.shot.view))]
  const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const card = (o: Outcome): string =>
    'file' in o
      ? `<figure><a href="${o.file}"><img src="${o.file}" loading="lazy" alt="${esc(o.shot.name)}"></a><figcaption>${esc(o.file)} · ${o.size.width}×${o.size.height}${o.zoom === 1 ? '' : ` · ${Math.round(o.zoom * 100)}% → ${Math.round(o.size.width / o.zoom)}×${Math.round(o.size.height / o.zoom)}`}</figcaption></figure>`
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
      outcomes.push(...(await capture({ app, win }, STATIC, { size: DESKTOP, suffix: '' })))
      const narrow = STATIC.filter((s) => AT_FLOOR.has(s.name))
      console.log('world: 900×700')
      outcomes.push(...(await capture({ app, win }, narrow, { size: MID, suffix: '-mid' })))
      console.log('world: 560×420')
      outcomes.push(...(await capture({ app, win }, narrow, { size: FLOOR, suffix: '-floor' })))
      // The fourth width nobody drags to: an ordinary window at the 200% a low-vision
      // reader works at, which is 640×410 of layout — between the mid shot and the floor,
      // and at type sizes none of the other three ever show. Not the floor zoomed: main
      // keeps the window's minimum at the floor whatever the zoom (`zoomedFloor`), so
      // that shot would only be the floor again, larger.
      console.log('world: 1280×820 at 200%')
      outcomes.push(...(await capture({ app, win }, narrow, { size: DESKTOP, suffix: '-zoom200', zoom: 2 })))
      await app.close()
    }
    if (live) {
      console.log('world: live turns (stub agents stream, then land)')
      const fresh = buildWorld(join(scratch, 'live'))
      const { app, win } = await launch(fresh, { UI_TOUR_STUB_DELAY_MS: '900' })
      outcomes.push(...(await capture({ app, win }, LIVE, { size: DESKTOP, suffix: '' })))
      await app.close()
    }
    console.log('world: first run')
    const empty = buildWorld(join(scratch, 'empty'), { populated: false })
    {
      const { app, win } = await launch(empty)
      outcomes.push(...(await capture({ app, win }, FIRST_RUN, { size: DESKTOP, suffix: '' })))
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
