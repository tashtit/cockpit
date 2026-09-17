/**
 * Prints the version the next release would carry — empty when the commits since the last
 * tag call for none — and writes it as `version` to $GITHUB_OUTPUT when CI runs it. It
 * reads the commit-analyzer rules from .releaserc.json, so it decides exactly as
 * semantic-release does; the release job still fails if the two ever disagree. Needs the
 * full history and tags (`fetch-depth: 0`). The decision logic is in next-version-core.mts.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, readFileSync } from 'node:fs'
import { analyzeCommits } from '@semantic-release/commit-analyzer'
import { LOG_FORMAT, nextVersion, parseLog, tagVersion, type ReleaseType } from './next-version-core.mts'

function git(args: readonly string[]): string {
  const r = spawnSync('git', [...args], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout
}

type PluginEntry = string | readonly [string, Record<string, unknown>]
const releaserc = JSON.parse(readFileSync('.releaserc.json', 'utf8')) as { readonly plugins: readonly PluginEntry[] }
const analyzer = releaserc.plugins.find(
  (p): p is readonly [string, Record<string, unknown>] => Array.isArray(p) && p[0] === '@semantic-release/commit-analyzer'
)
if (!analyzer) throw new Error('.releaserc.json has no configured @semantic-release/commit-analyzer')

const lastTag = git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*.[0-9]*.[0-9]*', 'HEAD']).trim()
const last = tagVersion(lastTag)
if (!last) throw new Error(`last tag ${lastTag} is not a release tag`)

const commits = parseLog(git(['log', `--format=${LOG_FORMAT}`, `${lastTag}..HEAD`]))
const quiet = { log: () => {}, error: console.error, warn: console.warn, success: () => {} }
const type: ReleaseType | null = await analyzeCommits(analyzer[1], { commits, logger: quiet, cwd: process.cwd() })
const version = nextVersion(last, type) ?? ''

console.log(version ? `next release: ${version} (${type} since ${lastTag})` : `no release due since ${lastTag}`)
const output = process.env['GITHUB_OUTPUT']
if (output) appendFileSync(output, `version=${version}\n`)
