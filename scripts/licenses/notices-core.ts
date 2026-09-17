/**
 * Third-party notices, the IO-free half: which package a bundled module belongs to,
 * what a package.json says its license is, which licenses the app refuses to ship,
 * and the text file those notices become. `notices.ts` does the reading and writing.
 */

/**
 * The generated file's name: written to out/, copied to Contents/Resources by
 * electron-builder.config.js, and opened from there by Settings › About.
 */
export const NOTICES_FILE = 'THIRD_PARTY_NOTICES.txt'

export type Notice = {
  readonly name: string
  readonly version: string
  /** SPDX expression as the package states it; 'UNKNOWN' when it states none */
  readonly license: string
  readonly homepage: string | null
  /** The package's own license (and NOTICE) files, verbatim; empty when it ships none */
  readonly text: string
}

/** Licenses whose terms reach the app that ships them — none of these may enter the build. */
const REFUSED = /\b(A?GPL|LGPL|SSPL|EUPL|OSL|CPAL|CC-BY-NC|CC-BY-SA|MPL)\b/i

/**
 * The package directory a bundled module id lives in, or null for the app's own source.
 * Rollup ids carry a `\0` prefix for virtual modules and a `?query` for proxies; nested
 * `node_modules` resolve to the innermost package, which is the copy actually bundled.
 */
export function packageDirOf(moduleId: string): string | null {
  const id = moduleId.replace(/^\0/, '').split('?', 1)[0]!.replace(/\\/g, '/')
  const at = id.lastIndexOf('/node_modules/')
  if (at < 0) return null
  const rest = id.slice(at + '/node_modules/'.length).split('/')
  const name = rest[0]?.startsWith('@') ? rest.slice(0, 2).join('/') : rest[0]
  if (!name || (name.startsWith('@') && !name.includes('/'))) return null
  return `${id.slice(0, at)}/node_modules/${name}`
}

/** The license a package.json declares, in its modern or either legacy shape. */
export function declaredLicense(pkg: Readonly<Record<string, unknown>>): string {
  const one = (v: unknown): string | null =>
    typeof v === 'string' ? v : v && typeof v === 'object' && 'type' in v ? String(v.type) : null
  const direct = one(pkg['license'])
  if (direct) return direct
  const list = Array.isArray(pkg['licenses']) ? pkg['licenses'].map(one).filter(Boolean) : []
  return list.length > 0 ? `(${list.join(' OR ')})` : 'UNKNOWN'
}

/**
 * Why a notice cannot ship, or null. An `OR` expression passes when any branch is
 * permissive (the app takes that branch); anything unstated has to be looked at by a
 * person rather than assumed fine.
 */
export function refusal(n: Pick<Notice, 'name' | 'version' | 'license'>): string | null {
  const id = `${n.name}@${n.version}`
  if (n.license === 'UNKNOWN') return `${id} states no license`
  const branches = n.license.replace(/[()]/g, '').split(/\s+OR\s+/i)
  if (branches.every((b) => REFUSED.test(b))) return `${id} is ${n.license}`
  return null
}

export function homepageOf(pkg: Readonly<Record<string, unknown>>): string | null {
  if (typeof pkg['homepage'] === 'string') return pkg['homepage']
  const repo = pkg['repository']
  const url = typeof repo === 'string' ? repo : repo && typeof repo === 'object' && 'url' in repo ? String(repo.url) : null
  if (!url) return null
  return url.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^github:/, 'https://github.com/')
}

/** One entry per name@version, sorted by name — the same package reached twice is one notice. */
export function dedupe(notices: readonly Notice[]): Notice[] {
  const byId = new Map<string, Notice>()
  for (const n of notices) {
    const id = `${n.name}@${n.version}`
    const seen = byId.get(id)
    if (!seen || (!seen.text && n.text)) byId.set(id, n)
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
}

const RULE = '-'.repeat(78)

export function renderNotices(notices: readonly Notice[]): string {
  const head = [
    'Cockpit — third-party notices',
    '',
    'Cockpit ships the software and artwork listed below. Each is used under the license',
    'shown with it, and each license text is reproduced as its authors distribute it.',
    'This file is generated at build time from what the build actually contains.',
    '',
    ...notices.map((n) => `  ${n.name} ${n.version} — ${n.license}`),
    ''
  ]
  const body = notices.map((n) =>
    [
      RULE,
      `${n.name} ${n.version}`,
      `License: ${n.license}`,
      ...(n.homepage ? [n.homepage] : []),
      '',
      n.text.trim() || `(the package ships no license file; it declares ${n.license})`,
      ''
    ].join('\n')
  )
  return `${head.join('\n')}\n${body.join('\n')}`
}
