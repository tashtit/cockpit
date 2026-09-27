import { describe, it, expect } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { appMenuTemplate } from '../src/main/app-menu'
import { COCKPIT_GUIDE_URL, RELEASES_URL } from '../src/shared/feedback'

const noop = (): void => {}

describe('appMenuTemplate', () => {
  it("keeps every menu Electron's default had, so no shortcut moves, and adds Help", () => {
    // copy/paste ride on Edit, ⌘+/⌘-/⌘0 and ⌃⌘F on View, ⌘W on File
    expect(appMenuTemplate({ mac: true, open: noop }).map((m) => m.role)).toEqual([
      'appMenu',
      'fileMenu',
      'editMenu',
      'viewMenu',
      'windowMenu',
      'help'
    ])
    // the app menu (About, Hide, Quit) is a macOS menu
    expect(appMenuTemplate({ mac: false, open: noop }).map((m) => m.role)).toEqual([
      'fileMenu',
      'editMenu',
      'viewMenu',
      'windowMenu',
      'help'
    ])
  })

  it('opens the user guide and the release notes from Help', () => {
    const opened: string[] = []
    const help = appMenuTemplate({ mac: true, open: (url) => opened.push(url) }).find((m) => m.role === 'help')
    const items = (help?.submenu ?? []) as MenuItemConstructorOptions[]
    expect(items.map((i) => i.label)).toEqual(['Cockpit User Guide', 'Release Notes'])

    for (const item of items) (item.click as () => void)()
    expect(opened).toEqual([COCKPIT_GUIDE_URL, RELEASES_URL])
  })
})
