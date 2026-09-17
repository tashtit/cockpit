/**
 * IO-free half of scripts/next-version.mts: the version the next release would carry, so
 * CI can stamp it into the bundle before packaging — the same way on a pull request as on
 * main — and the release job only publishes what was built. The script runs git and
 * semantic-release's own commit analyzer; this decides. tests/next-version-core.test.ts
 * targets it.
 */

export type ReleaseType = 'major' | 'minor' | 'patch'

export type Commit = { readonly hash: string; readonly message: string }

const RECORD = ''
const FIELD = ''

/** the `git log` format `parseLog` reads: hash, unit separator, full message, record separator */
export const LOG_FORMAT = '%H%x1f%B%x1e'

export function parseLog(raw: string): readonly Commit[] {
  return raw
    .split(RECORD)
    .map((record) => record.replace(/^\n+/, ''))
    .filter((record) => record.includes(FIELD))
    .map((record) => {
      const [hash = '', message = ''] = record.split(FIELD)
      return { hash: hash.trim(), message: message.trim() }
    })
}

/** `v1.2.3` → `1.2.3`; anything that is not a plain release tag → null */
export function tagVersion(tag: string): string | null {
  const match = /^v(\d+\.\d+\.\d+)$/.exec(tag.trim())
  return match ? match[1]! : null
}

/**
 * The version after `last` for a release of `type`, as semantic-release computes it:
 * a breaking change bumps the major even below 1.0.0. No release type → null.
 */
export function nextVersion(last: string, type: ReleaseType | null): string | null {
  if (!type) return null
  const [major = 0, minor = 0, patch = 0] = last.split('.').map(Number)
  if (type === 'major') return `${major + 1}.0.0`
  if (type === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}
