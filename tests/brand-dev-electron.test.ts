import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const SCRIPT = join(__dirname, '..', 'scripts', 'brand-dev-electron.mjs')

/** The keys Electron's own dist Info.plist carries, in its order and formatting. */
function plist(displayName: string, name: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDisplayName</key>
	<string>${displayName}</string>
	<key>CFBundleExecutable</key>
	<string>Electron</string>
	<key>CFBundleIconFile</key>
	<string>electron.icns</string>
	<key>CFBundleIdentifier</key>
	<string>com.github.Electron</string>
	<key>CFBundleName</key>
	<string>${name}</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
</dict>
</plist>
`
}

function run(bundle: string): string {
  return execFileSync(process.execPath, [SCRIPT, bundle], { encoding: 'utf8' })
}

describe('brand-dev-electron', () => {
  let dir: string
  let bundle: string
  let infoPlist: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cockpit-brand-'))
    bundle = join(dir, 'Electron.app')
    infoPlist = join(bundle, 'Contents', 'Info.plist')
    mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
    writeFileSync(infoPlist, plist('Electron', 'Electron'))
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('renames the bundle to Cockpit and leaves every other key alone', () => {
    expect(run(bundle)).toContain('branded Electron.app as Cockpit')
    // CFBundleExecutable names a file on disk, not a label — it keeps its stock value
    expect(readFileSync(infoPlist, 'utf8')).toBe(plist('Cockpit', 'Cockpit'))
  })

  it('is idempotent: a branded bundle is left untouched and reported nothing', () => {
    run(bundle)
    expect(run(bundle)).toBe('')
    expect(readFileSync(infoPlist, 'utf8')).toBe(plist('Cockpit', 'Cockpit'))
  })

  it('is a no-op when there is no bundle to brand', () => {
    const missing = join(dir, 'Missing.app')
    expect(run(missing)).toContain('nothing to brand')
    expect(run(missing)).not.toContain('branded')
  })
})
