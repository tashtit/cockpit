/**
 * Finishes a release that semantic-release created but could not publish — see
 * finish-release-core.mts for why that state exists and why a re-run cannot clear it.
 *
 * Reads the release for $COCKPIT_PACKAGED_VERSION, re-uploads whatever is missing or was
 * stored short, publishes the draft, and writes `version` to $GITHUB_OUTPUT so the job's
 * own check still compares what was released against what was packaged. Exits non-zero
 * when the release is not a half-finished one, so a genuine failure stays a failure.
 *
 * Needs `gh` authenticated ($GH_TOKEN) and the packaged files in dist/.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describePlan, planFinish, type LocalAsset, type ReleaseState } from './finish-release-core.mts'

const DIST = 'dist'
/** the same set .releaserc.json hands @semantic-release/github */
const ASSET = /\.(dmg|zip|blockmap)$|^latest-mac\.yml$/
/** a 500 from the asset endpoint is transient; it cost us v0.11.0, so try well past it */
const UPLOAD_ATTEMPTS = 5
const RETRY_MS = 15_000

function gh(args: readonly string[]): { readonly ok: boolean; readonly stdout: string; readonly stderr: string } {
  const r = spawnSync('gh', [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  return { ok: r.status === 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function fail(message: string): never {
  console.error(`::error::${message}`)
  process.exit(1)
}

function sleep(ms: number): void {
  // a blocking wait keeps this a plain top-to-bottom script; it runs once, in CI
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

const version = (process.env['COCKPIT_PACKAGED_VERSION'] ?? '').trim()
const tag = `v${version}`

/** null when there is no such release — `gh` also says that with a non-zero exit */
function readRelease(): ReleaseState | null {
  const r = gh(['release', 'view', tag, '--json', 'tagName,isDraft,assets'])
  if (!r.ok) return null
  return JSON.parse(r.stdout) as ReleaseState
}

function readLocal(): readonly LocalAsset[] {
  return readdirSync(DIST)
    .filter((name) => ASSET.test(name))
    .map((name) => ({ name, size: statSync(join(DIST, name)).size }))
}

const plan = planFinish(version, readRelease(), readLocal())
console.log(describePlan(version, plan))
if (plan.action === 'refuse') fail(`${plan.reason} — the release step's own error is above`)

if (plan.action === 'finish') {
  for (const name of plan.upload) {
    let uploaded = false
    for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS && !uploaded; attempt++) {
      const r = gh(['release', 'upload', tag, join(DIST, name), '--clobber'])
      uploaded = r.ok
      if (!uploaded) {
        console.log(`upload of ${name} failed (attempt ${attempt}/${UPLOAD_ATTEMPTS}): ${r.stderr.trim()}`)
        if (attempt < UPLOAD_ATTEMPTS) sleep(RETRY_MS)
      }
    }
    if (!uploaded) fail(`could not upload ${name} to ${tag} after ${UPLOAD_ATTEMPTS} attempts`)
    console.log(`uploaded ${name}`)
  }

  if (plan.publish) {
    // `--latest` is what semantic-release would have left behind, and it is safe here only
    // because this runs inside the run that cut the tag: pushes to main queue rather than
    // cancel, so no newer release exists yet. Publishing an older tag as latest out of band
    // would demote the newer one.
    const r = gh(['release', 'edit', tag, '--draft=false', '--latest'])
    if (!r.ok) fail(`could not publish ${tag}: ${r.stderr.trim()}`)
    console.log(`published ${tag}`)
  }
}

const output = process.env['GITHUB_OUTPUT']
if (output) appendFileSync(output, `version=${version}\n`)
