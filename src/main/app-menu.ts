import type { MenuItemConstructorOptions } from 'electron'
import { COCKPIT_GUIDE_URL, RELEASES_URL } from '../shared/feedback'

/*
 * The menu bar: Electron's default menus, rebuilt from the same roles, plus a Help menu
 * that opens the user guide and the release notes. Setting any application menu
 * replaces the default one whole, so every menu it had is listed here again — Edit is
 * what copy and paste ride on, View holds ⌘+/⌘-/⌘0 (which the zoom chip follows) and
 * ⌃⌘F, File holds ⌘W. Roles keep their items, labels and shortcuts exactly Electron's;
 * only Help is Cockpit's.
 *
 * Pure: the caller builds and sets it (`index.ts`, on ready, before the window), and
 * hands in how a link opens.
 */

export type AppMenuDeps = {
  /** macOS, where the first menu is the app's own (About, Hide, Quit) */
  readonly mac: boolean
  /** Opens a page in the browser */
  readonly open: (url: string) => void
}

export function appMenuTemplate({ mac, open }: AppMenuDeps): MenuItemConstructorOptions[] {
  return [
    ...(mac ? [{ role: 'appMenu' } as const] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: 'Cockpit User Guide', click: () => open(COCKPIT_GUIDE_URL) },
        { label: 'Release Notes', click: () => open(RELEASES_URL) }
      ]
    }
  ]
}
