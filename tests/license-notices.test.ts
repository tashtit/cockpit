import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  declaredLicense,
  dedupe,
  homepageOf,
  packageDirOf,
  refusal,
  renderNotices,
  type Notice
} from '../scripts/licenses/notices-core'
import { productionPackages, readNotice, writeNotices } from '../scripts/licenses/notices'

const notice = (over: Partial<Notice> & { name: string }): Notice => ({
  version: '1.0.0',
  license: 'MIT',
  homepage: null,
  text: '',
  ...over
})

describe('packageDirOf', () => {
  it('maps a bundled module to the package that owns it', () => {
    expect(packageDirOf('/app/node_modules/react-dom/cjs/react-dom.production.js')).toBe(
      '/app/node_modules/react-dom'
    )
    expect(packageDirOf('/app/node_modules/@scope/pkg/lib/index.js')).toBe('/app/node_modules/@scope/pkg')
  })

  it('takes the innermost copy, and sees through rollup virtual ids and queries', () => {
    expect(packageDirOf('\0/app/node_modules/a/node_modules/b/index.js?commonjs-proxy')).toBe(
      '/app/node_modules/a/node_modules/b'
    )
  })

  it("leaves the app's own source out", () => {
    expect(packageDirOf('/app/src/renderer/src/App.tsx')).toBeNull()
    expect(packageDirOf('\0vite/preload-helper')).toBeNull()
  })
})

describe('declaredLicense and refusal', () => {
  it('reads the modern field and both legacy shapes', () => {
    expect(declaredLicense({ license: 'ISC' })).toBe('ISC')
    expect(declaredLicense({ license: { type: 'BSD-2-Clause' } })).toBe('BSD-2-Clause')
    expect(declaredLicense({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe('(MIT OR Apache-2.0)')
    expect(declaredLicense({})).toBe('UNKNOWN')
  })

  it('flags copyleft and anything unstated, unless a permissive branch is on offer', () => {
    expect(refusal(notice({ name: 'ok' }))).toBeNull()
    expect(refusal(notice({ name: 'gpl', license: 'GPL-3.0-only' }))).toBe('gpl@1.0.0 is GPL-3.0-only')
    expect(refusal(notice({ name: 'lgpl', license: 'LGPL-2.1' }))).not.toBeNull()
    expect(refusal(notice({ name: 'mpl', license: 'MPL-2.0' }))).toBeNull()
    expect(refusal(notice({ name: 'dual', license: '(MIT OR GPL-3.0)' }))).toBeNull()
    expect(refusal(notice({ name: 'both', license: '(MIT OR GPL-2.0) AND LGPL-2.1' }))).not.toBeNull()
    expect(refusal(notice({ name: 'mystery', license: 'UNKNOWN' }))).toBe('mystery@1.0.0 states no usable license (UNKNOWN)')
    expect(refusal(notice({ name: 'closed', license: 'UNLICENSED' }))).not.toBeNull()
    expect(refusal(notice({ name: 'elsewhere', license: 'SEE LICENSE IN LICENSE.md' }))).not.toBeNull()
  })
})

describe('homepageOf, dedupe and renderNotices', () => {
  it('turns a repository field into a link', () => {
    expect(homepageOf({ repository: { url: 'git+https://github.com/a/b.git' } })).toBe('https://github.com/a/b')
    expect(homepageOf({ repository: 'github:a/b' })).toBe('https://github.com/a/b')
    expect(homepageOf({ homepage: 'https://b.dev' })).toBe('https://b.dev')
  })

  it('keeps one notice per name@version, preferring the copy that carries a license text', () => {
    const out = dedupe([
      notice({ name: 'zeta' }),
      notice({ name: 'alpha' }),
      notice({ name: 'zeta', text: 'MIT License …' })
    ])
    expect(out.map((n) => n.name)).toEqual(['alpha', 'zeta'])
    expect(out[1]!.text).toBe('MIT License …')
  })

  it('lists every notice up front, then each with its license text', () => {
    const text = renderNotices([
      notice({ name: 'alpha', text: 'Copyright alpha' }),
      notice({ name: 'bare', license: 'ISC' })
    ])
    expect(text).toContain('  alpha 1.0.0 — MIT')
    expect(text).toContain('Copyright alpha')
    expect(text).toContain('(the package ships no license file; it declares ISC)')
  })
})

describe('writeNotices over a real node_modules tree', () => {
  let root: string

  const pkg = (dir: string, json: Record<string, unknown>, license?: string): void => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify(json))
    if (license) writeFileSync(join(dir, 'LICENSE'), license)
  }

  beforeAll(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), 'cockpit-license-fixtures-'))
    const nm = join(root, 'node_modules')
    pkg(root, { name: 'app', version: '0.0.0', dependencies: { updater: '1' }, devDependencies: { bundled: '1' } })
    // production tree: updater → yaml (hoisted) and → sax (nested, a different version)
    pkg(join(nm, 'updater'), { name: 'updater', version: '6.0.0', license: 'MIT', dependencies: { yaml: '1', sax: '1' } }, 'MIT updater')
    pkg(join(nm, 'yaml'), { name: 'yaml', version: '2.0.0', license: 'ISC' }, 'ISC yaml')
    pkg(join(nm, 'sax'), { name: 'sax', version: '9.9.9', license: 'ISC' })
    pkg(join(nm, 'updater', 'node_modules', 'sax'), { name: 'sax', version: '1.6.1', license: 'BlueOak-1.0.0' }, 'BlueOak sax')
    // only bundled into a target, never installed for production
    pkg(join(nm, 'bundled'), { name: 'bundled', version: '19.0.0', license: 'MIT' }, 'MIT bundled')
    pkg(join(nm, 'unused'), { name: 'unused', version: '1.0.0', license: 'GPL-3.0' })
    // what fixedNotices reads
    pkg(join(nm, 'electron'), { name: 'electron', version: '44.0.0' })
    writeFileSync(join(nm, 'electron', 'LICENSE'), 'Copyright (c) Electron contributors')
    mkdirSync(join(root, 'src/renderer/src/assets/fonts'), { recursive: true })
    writeFileSync(join(root, 'src/renderer/src/assets/fonts/LICENSE-IBM-Plex.txt'), 'SIL Open Font License')
  })

  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('walks the production tree the way node resolves it, nested copies included', () => {
    const dirs = productionPackages(root).map((d) => d.slice(root.length + 1)).sort()
    expect(dirs).toEqual([
      'node_modules/updater',
      'node_modules/updater/node_modules/sax',
      'node_modules/yaml'
    ])
    expect(readNotice(join(root, 'node_modules/updater/node_modules/sax'))).toMatchObject({
      version: '1.6.1',
      license: 'BlueOak-1.0.0',
      text: 'BlueOak sax'
    })
  })

  it('writes what the build bundles and what production installs, and nothing else', () => {
    const file = writeNotices(root, [join(root, 'node_modules/bundled')])
    expect(dirname(file)).toBe(join(root, 'out'))
    const text = readFileSync(file, 'utf8')
    for (const line of ['bundled 19.0.0 — MIT', 'updater 6.0.0 — MIT', 'sax 1.6.1 — BlueOak-1.0.0', 'Electron 44.0.0 — MIT', 'IBM Plex Sans and IBM Plex Mono (fonts) — OFL-1.1']) {
      expect(text).toContain(`  ${line}`)
    }
    expect(text).not.toContain('unused')
    expect(text).not.toContain('sax 9.9.9')
  })
})
