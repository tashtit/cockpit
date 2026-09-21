import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { closeApp } from './close-app'
import { launchEnv } from './launch-env'
import type { World } from '../../scripts/ui-tour/world.mts'

/**
 * Accessibility rules a machine can settle, over every view, against the ui-tour's
 * fixture world — the one place the app is populated enough to audit (three agents,
 * five repos, roundtables, PR badges, drifted agent config, a real diff to review).
 *
 * The checks are deliberately hand-written and few: each one is a rule this app has
 * already broken, and each reads the DOM directly rather than pulling in an audit
 * engine. That trade is the point — no dependency, no platform-dependent verdicts,
 * and nothing here fails for a reason a reader of this file cannot see. What it does
 * not cover is the long tail an engine would: contrast, focus order, and every rule
 * nobody has broken yet. Those stay with the reviews in design-system/cockpit.
 *
 * Tests assert behaviour and `npm run ui:tour` shows what renders; this asserts the
 * structure a screen reader walks.
 */

const mainEntry = resolve('out/main/index.js')
if (!existsSync(mainEntry)) {
  throw new Error('out/main/index.js missing — run `npm run build` before `npm run test:e2e`')
}

/**
 * The tour's world is an `.mts` module with `import.meta` in it; Playwright compiles
 * specs to CommonJS, so it has to come in at runtime as real ESM rather than be
 * transpiled with the spec. The type comes in at compile time, which erases.
 */
async function loadWorldBuilder(): Promise<(at: string) => World> {
  const mod = (await import(pathToFileURL(resolve('scripts/ui-tour/world.mts')).href)) as {
    buildWorld: (at: string, opts?: { populated?: boolean }) => World
  }
  return mod.buildWorld
}

let root: string
let world: World
let app: ElectronApplication
let win: Page

test.beforeAll(async () => {
  test.setTimeout(180_000)
  root = mkdtempSync(join(tmpdir(), 'cockpit-e2e-a11y-'))
  world = (await loadWorldBuilder())(join(root, 'world'))
  app = await electron.launch({
    args: [mainEntry],
    env: launchEnv({
      HOME: world.home,
      COCKPIT_USER_DATA: world.userData,
      PATH: `${world.bin}:${process.env.PATH ?? ''}`
    })
  })
  win = await app.firstWindow()
  await win.setViewportSize({ width: 1280, height: 860 })
  // links never leave the app (see pages.spec.ts — a real browser outlives teardown)
  await app.evaluate(({ shell }) => {
    shell.openExternal = async () => {}
  })
  // the first index of the world: accounts, usage, repos, PR badges
  await win.waitForTimeout(4000)
})

test.afterAll(async () => {
  await closeApp(app)
  rmSync(root, { recursive: true, force: true })
})

// ---------- the checks ----------

/**
 * Everything wrong with what is on screen right now, as sentences. One list so a
 * failure names every problem at once rather than one per run.
 */
async function faults(): Promise<string[]> {
  return win.evaluate(() => {
    const out: string[] = []
    const where = (el: Element): string =>
      `${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0] || '(no class)'}`

    // 1. A role=tree owns treeitems and groups, nothing else. A live region or a
    //    plain button among the rows is content a screen reader cannot place.
    for (const tree of document.querySelectorAll('[role="tree"]')) {
      const walk = (parent: Element): void => {
        for (const el of parent.children) {
          const role = el.getAttribute('role')
          if (role === 'treeitem' || role === 'group') continue
          // a presentational wrapper is transparent: look through it
          if (role === 'presentation' || role === 'none' || (!role && !el.hasAttribute('aria-live') && el.matches('div:not([tabindex]):not([aria-label])') && !el.matches('button, a, input'))) {
            walk(el)
            continue
          }
          out.push(`${where(el)} is inside a role=tree, which may only own treeitem and group`)
        }
      }
      walk(tree)
    }

    // 2. A name on an element whose role cannot carry one is dropped by the browser:
    //    it reads as labelled in the source and is absent in the tree.
    for (const el of document.querySelectorAll('[aria-label], [aria-labelledby]')) {
      if (el.getAttribute('role')) continue
      if (
        el.matches(
          'a[href], button, input, select, textarea, summary, img, area, iframe, ' +
            'dialog, form, nav, main, aside, header, footer, section, table, ' +
            'th, td, fieldset, details, menu, ol, ul, li, h1, h2, h3, h4, h5, h6, ' +
            'svg, output, meter, progress, time'
        )
      ) {
        continue
      }
      out.push(`${where(el)} carries a name its role cannot expose`)
    }

    // 3. Every view sits under a level-one heading, and page content sits inside a
    //    landmark — the two things that make heading and landmark navigation work.
    const h1s = document.querySelectorAll('h1')
    if (h1s.length === 0) out.push('the page has no level-one heading')
    const landmarks = 'main, nav, aside, header, footer, form, section[aria-label], [role="main"], [role="navigation"], [role="complementary"], [role="banner"], [role="contentinfo"], [role="dialog"], [role="region"]'
    for (const el of document.body.children) {
      if (el.matches('script, style') || el.getAttribute('aria-hidden') === 'true') continue
      for (const child of el.children) {
        if (child.matches(landmarks) || child.getAttribute('aria-hidden') === 'true') continue
        if (child.matches('script, style')) continue
        if (child.querySelector(landmarks) || child.closest(landmarks)) continue
        if (!(child.textContent ?? '').trim()) continue
        out.push(`${where(child)} holds content outside every landmark`)
      }
    }

    // 4. A control with no text needs a name from somewhere.
    for (const el of document.querySelectorAll('button, a[href], [role="button"], [role="switch"], [role="tab"]')) {
      const text = (el.textContent ?? '').replace(/\s+/g, '')
      if (text) continue
      if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title')) continue
      if (el.getAttribute('aria-hidden') === 'true') continue
      out.push(`${where(el)} is a control with no text and no name`)
    }

    // 5. A region that scrolls must be reachable without a pointer (WCAG 2.1.1).
    for (const el of document.querySelectorAll('pre, .messages, .idiff-body, .tree, .board-list, .home-stack')) {
      const style = getComputedStyle(el)
      const scrolls =
        (el.scrollWidth > el.clientWidth + 1 && /auto|scroll/.test(style.overflowX)) ||
        (el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(style.overflowY))
      if (!scrolls) continue
      if ((el as HTMLElement).tabIndex >= 0) continue
      // summary and contenteditable are focusable without a tabindex of their own
      if (el.querySelector('a[href], button, input, select, textarea, summary, [contenteditable], [tabindex]:not([tabindex="-1"])')) continue
      out.push(`${where(el)} scrolls but nothing in it takes focus`)
    }

    // 6. An element that claims a relationship must actually have one.
    for (const el of document.querySelectorAll('[aria-labelledby], [aria-describedby], [aria-controls], [aria-activedescendant]')) {
      for (const attr of ['aria-labelledby', 'aria-describedby', 'aria-controls', 'aria-activedescendant']) {
        const value = el.getAttribute(attr)
        if (!value) continue
        for (const id of value.split(/\s+/).filter(Boolean)) {
          if (!document.getElementById(id)) out.push(`${where(el)} points ${attr} at "${id}", which is not on the page`)
        }
      }
    }

    return [...new Set(out)]
  })
}

async function audit(): Promise<void> {
  const found = await faults()
  expect(found, `accessibility faults on screen:\n    ${found.join('\n    ')}`).toEqual([])
}

// ---------- the same paths a person takes ----------

async function home(): Promise<void> {
  await win.keyboard.press('Escape')
  await win.keyboard.press('ControlOrMeta+n')
  const search = win.getByLabel('Search sessions')
  if ((await search.inputValue()) !== '') await search.fill('')
  // the hero heading sheds at the window floor; the composer is home at every width
  await expect(win.locator('.composer-card')).toBeVisible()
}

async function nav(label: string): Promise<void> {
  await home()
  await win.getByRole('button', { name: label, exact: true }).click()
  await expect(win.getByRole('heading', { name: label })).toBeVisible()
}

/**
 * Reach a session by name. Which repo group the tree opens on depends on the
 * fixtures' activity order, so the search box is the reliable door — and it is the
 * one a person uses to find a session by name anyway.
 */
async function openSession(title: string): Promise<void> {
  await home()
  const search = win.getByLabel('Search sessions')
  await search.fill(title)
  const row = win.getByRole('treeitem', { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') })
  await row.first().click()
  // the audit should see the ordinary tree, not a filtered one
  await search.fill('')
}

// ---------- the views ----------

test('home, with the board and the composer', async () => {
  await home()
  await audit()
})

test('the sidebar searching, and its project chooser', async () => {
  await home()
  await win.getByLabel('Search sessions').fill('fix')
  await audit()
  await win.getByLabel('Search sessions').fill('')
  await win.getByRole('button', { name: 'Choose projects to display' }).click()
  await expect(win.getByRole('dialog', { name: 'Projects to display' })).toBeVisible()
  await audit()
  await win.keyboard.press('Escape')
})

test('the ⌘K palette, empty and querying', async () => {
  await home()
  await win.keyboard.press('ControlOrMeta+k')
  await expect(win.getByRole('dialog', { name: 'Jump to' })).toBeVisible()
  await audit()
  await win.getByRole('combobox').fill('rocket')
  await audit()
  await win.keyboard.press('Escape')
})

test('settings, every section', async () => {
  await nav('Settings')
  await audit()
})

test('agents, every section', async () => {
  await nav('Agents')
  await audit()
  for (const section of ['Instructions', 'MCP servers', 'Skills', 'Plugins', 'Marketplaces']) {
    await win.getByRole('tab', { name: new RegExp(`^${section}`) }).click()
    await expect(win.getByRole('tab', { name: new RegExp(`^${section}`) })).toHaveAttribute('aria-selected', 'true')
    await audit()
  }
})

test('profile', async () => {
  await nav('Profile')
  await audit()
})

test('cleanup, once its scan lands', async () => {
  await nav('Cleanup')
  // the scan asks git about every worktree it knows: slower than the default wait
  // allows on a loaded machine, and auditing the loading state proves nothing
  await expect(win.getByText(/of \d+ sessions/)).toBeVisible({ timeout: 30_000 })
  await audit()
})

test('the new-session form', async () => {
  await home()
  await win.getByRole('treeitem', { name: /acme\/\s*rocket/ }).focus()
  await win.getByRole('button', { name: 'New session in rocket' }).click()
  await expect(win.getByRole('heading', { name: 'New session' })).toBeVisible()
  await audit()
  await win.keyboard.press('Escape')
})

test('the new-roundtable form', async () => {
  await home()
  await win.getByRole('button', { name: /Start a roundtable/ }).click()
  await expect(win.getByRole('heading', { name: 'New roundtable' })).toBeVisible()
  await audit()
  await win.keyboard.press('Escape')
})

test('a chat, with its transcript and work log', async () => {
  await openSession('Fix the login flake')
  await expect(win.locator('.messages .markdown').first()).toBeVisible()
  await audit()
  await win.locator('.tool-run summary').first().click()
  await audit()
})

test('the handoff form', async () => {
  await openSession('Tidy the usage panel spacing')
  await win.getByRole('button', { name: /Continue in another agent/ }).click()
  await expect(win.getByRole('heading', { name: 'Continue in another agent' })).toBeVisible()
  await audit()
  await win.keyboard.press('Escape')
})

test('a roundtable, open and at consensus', async () => {
  // a table in a repo lives under that repo's group; the consensus one has no repo
  await home()
  const rocket = win.getByRole('treeitem', { name: /acme\/\s*rocket/ }).first()
  if ((await rocket.getAttribute('aria-expanded')) === 'false') await rocket.click()
  await win.getByRole('treeitem', { name: /Monorepo or polyrepo/ }).first().click()
  await expect(win.locator('.chat-title')).toHaveText(/Monorepo or polyrepo/)
  await audit()
  await home()
  await win.getByRole('treeitem', { name: /Should usage polling move/ }).first().click()
  await expect(win.locator('.chat-title')).toHaveText(/Should usage polling move/)
  await audit()
})

test('the review panel over a real diff', async () => {
  await openSession('Add pagination to the sessions list')
  await win.getByRole('button', { name: 'Changes', exact: true }).click()
  await expect(win.getByRole('region', { name: 'Changes to review' })).toBeVisible()
  await audit()
})

test('the window floor — 560×420, where everything sheds', async () => {
  await win.setViewportSize({ width: 560, height: 420 })
  await home()
  await audit()
  await nav('Settings')
  await audit()
  await openSession('Fix the login flake')
  await audit()
  await win.setViewportSize({ width: 1280, height: 860 })
})
