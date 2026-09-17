import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Plugin } from 'vite'
import {
  declaredLicense,
  dedupe,
  homepageOf,
  packageDirOf,
  refusal,
  NOTICES_FILE,
  renderNotices,
  type Notice
} from './notices-core'

/** electron-builder leaves this optional native module out of the app (electron-builder.config.js). */
const NOT_SHIPPED = new Set(['fsevents'])

const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-].*)?$/i

export function readNotice(dir: string): Notice | null {
  let pkg: Record<string, unknown>
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
  if (typeof pkg['name'] !== 'string' || typeof pkg['version'] !== 'string') return null
  const files = readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f))
    .sort()
  return {
    name: pkg['name'],
    version: pkg['version'],
    license: declaredLicense(pkg),
    homepage: homepageOf(pkg),
    text: files.map((f) => readFileSync(join(dir, f), 'utf8').trim()).join('\n\n')
  }
}

/** Node's lookup: the nearest node_modules/<name> from `from` upward, stopping at root. */
function resolvePackage(name: string, from: string, root: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (dir === root || dir === dirname(dir)) return null
  }
}

/**
 * Every package directory the production dependency tree reaches — what electron-builder
 * copies into the app's node_modules. Optional dependencies that were never installed
 * are skipped, as the packager skips them.
 */
export function productionPackages(root: string): string[] {
  const seen = new Set<string>()
  const visit = (dir: string, deps: Readonly<Record<string, string>>): void => {
    for (const name of Object.keys(deps)) {
      if (NOT_SHIPPED.has(name)) continue
      const found = resolvePackage(name, dir, root)
      if (!found || seen.has(found)) continue
      seen.add(found)
      const pkg = JSON.parse(readFileSync(join(found, 'package.json'), 'utf8'))
      visit(found, { ...pkg.dependencies, ...pkg.optionalDependencies })
    }
  }
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  visit(root, { ...pkg.dependencies, ...pkg.optionalDependencies })
  return [...seen]
}

/** Shipped by the app but not packages: the artwork and fonts, and Electron itself. */
export function fixedNotices(root: string): Notice[] {
  const electron = JSON.parse(readFileSync(join(root, 'node_modules/electron/package.json'), 'utf8'))
  return [
    {
      name: 'Electron',
      version: electron.version,
      license: 'MIT',
      homepage: 'https://www.electronjs.org',
      text:
        // the npm package's own copy: dist/ only exists once something has required electron
        readFileSync(join(root, 'node_modules/electron/LICENSE'), 'utf8').trim() +
        '\n\nChromium and the other components Electron is built from carry their own notices,' +
        ' shipped beside this file as LICENSES.chromium.html (Cockpit.app/Contents/Resources).'
    },
    {
      name: 'IBM Plex Sans and IBM Plex Mono',
      version: '(fonts)',
      license: 'OFL-1.1',
      homepage: 'https://github.com/IBM/plex',
      text: readFileSync(join(root, 'src/renderer/src/assets/fonts/LICENSE-IBM-Plex.txt'), 'utf8')
    },
    {
      name: 'GitHub Octicons',
      version: '(icon path data)',
      license: 'MIT',
      homepage: 'https://github.com/primer/octicons',
      text: OCTICONS_MIT
    },
    {
      name: 'Simple Icons',
      version: '(icon path data)',
      license: 'CC0-1.0',
      homepage: 'https://simpleicons.org',
      text:
        'Simple Icons path data is released under CC0 1.0 Universal (public domain dedication):\n' +
        'https://creativecommons.org/publicdomain/zero/1.0/\n\n' +
        'The brand marks it depicts remain trademarks of their owners.'
    }
  ]
}

const OCTICONS_MIT = `MIT License

Copyright (c) 2023 GitHub Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`

/**
 * Compose and write the notices. A license that needs a person's look is a warning, never
 * a failed build: the build also runs on dependency-update pull requests.
 */
export function writeNotices(root: string, bundledDirs: Iterable<string>): string {
  const packages = [...new Set([...bundledDirs, ...productionPackages(root)])]
    .map(readNotice)
    .filter((n): n is Notice => n !== null)
  const notices = [...dedupe(packages), ...fixedNotices(root)]
  const refused = notices.map(refusal).filter(Boolean)
  if (refused.length > 0) {
    console.warn(
      `Third-party notices: review before release — ${refused.join('; ')} (scripts/licenses/notices-core.ts)`
    )
  }
  const file = join(root, 'out', NOTICES_FILE)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, renderNotices(notices))
  return file
}

/**
 * Collects the packages each electron-vite target bundles, and rewrites the notices with
 * everything seen so far when each target finishes — whichever target builds last, the
 * file ends up covering all of them. Production builds only: `electron-vite dev` still
 * builds main and preload, but the renderer comes from the dev server, so notices written
 * then would leave the renderer's packages out of a file `npm run build` already wrote.
 */
export function licenseNotices(): Plugin {
  return {
    name: 'cockpit-license-notices',
    apply: () => process.env['NODE_ENV_ELECTRON_VITE'] !== 'development',
    generateBundle() {
      const root = resolve(__dirname, '../..')
      for (const id of this.getModuleIds()) {
        const dir = packageDirOf(id)
        if (dir && dir.startsWith(`${root}/`)) BUNDLED.add(dir)
      }
    },
    closeBundle() {
      writeNotices(resolve(__dirname, '../..'), BUNDLED)
    }
  }
}

/** Shared across the three targets — electron-vite builds them in one process */
const BUNDLED = new Set<string>()
