/**
 * Brand the dev Electron bundle as Cockpit (macOS).
 *
 * `npm run dev` runs the stock Electron.app out of node_modules, and macOS
 * names a running app after its bundle's Info.plist, never after the window
 * title: the app menu, the Dock and Mission Control's full-screen spaces all
 * read "Electron". No runtime API changes that (`app.setName` only sets
 * `app.name`), so this rewrites CFBundleName / CFBundleDisplayName in place
 * before each dev launch. Electron's dist bundle is ad-hoc, linker-signed with
 * the Info.plist unbound (`codesign -dv`: "Info.plist=not bound"), so the edit
 * leaves the signature valid.
 *
 * Idempotent, and never blocks the launch: a failure is a warning and the app
 * simply keeps its stock name. Off macOS there is no bundle to brand. Pass a
 * bundle path (`node scripts/brand-dev-electron.mjs path/to/X.app`) to skip the
 * platform check and the electron lookup — that is what the unit test does.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, join, resolve } from 'node:path'

const APP_NAME = 'Cockpit'
const NAME_KEYS = /(<key>(?:CFBundleName|CFBundleDisplayName)<\/key>\s*<string>)[^<]*(<\/string>)/g

/** The bundle's user-facing names, rewritten; everything else in the plist is untouched. */
function brandPlist(xml, name) {
  return xml.replace(NAME_KEYS, (_, open, close) => `${open}${name}${close}`)
}

/** The Electron.app electron-vite will launch — downloads the binary on first use, like electron-vite does. */
function devBundle() {
  if (process.platform !== 'darwin') return null
  const executable = createRequire(import.meta.url)('electron')
  // <bundle>.app/Contents/MacOS/Electron → <bundle>.app
  return resolve(executable, '..', '..', '..')
}

function main(arg) {
  const bundle = arg ? resolve(arg) : devBundle()
  if (!bundle) return
  const plist = join(bundle, 'Contents', 'Info.plist')
  if (!existsSync(plist)) {
    console.log(`[dev] no Info.plist under ${bundle}; nothing to brand`)
    return
  }
  const before = readFileSync(plist, 'utf8')
  const after = brandPlist(before, APP_NAME)
  if (after === before) return
  writeFileSync(plist, after)
  console.log(`[dev] branded ${basename(bundle)} as ${APP_NAME} (Info.plist)`)
}

try {
  main(process.argv[2])
} catch (err) {
  console.warn(`[dev] could not brand the Electron bundle: ${err instanceof Error ? err.message : String(err)}`)
}
