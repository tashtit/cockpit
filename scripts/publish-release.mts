/**
 * Uploads a release's assets and publishes it — the normal path, not a rescue. See
 * publish-release-core.mts for why Cockpit sends its own assets instead of letting
 * @semantic-release/github do it.
 *
 * Sequential and streamed: one `gh release upload` at a time, each reading the file off
 * disk rather than holding it in memory, so one runner is never pushing ~540MB at once and
 * a retry costs one file rather than the release. Re-running is safe — it uploads only what
 * is missing or was stored short, and publishing an already-published release is a no-op —
 * which is what lets it double as the repair when an earlier attempt died partway.
 *
 * Writes `version` to $GITHUB_OUTPUT so the job's own check still compares what was
 * released against what was packaged. Exits non-zero when there is no release to publish,
 * so a semantic-release that failed before creating one still fails the run.
 *
 * Needs `gh` authenticated ($GH_TOKEN) and the packaged files in dist/.
 */
import { spawnSync } from 'node:child_process'
import { appendFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describePlan, planPublish, type LocalAsset, type ReleaseState } from './publish-release-core.mts'

const DIST = 'dist'
/** what the package job builds, and the whole of what a release carries */
const ASSET = /\.(dmg|zip|blockmap)$|^latest-mac\.yml$/
/** GitHub's asset endpoint 500s now and then; it cost us v0.11.0 and v0.13.0 */
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

const plan = planPublish(version, readRelease(), readLocal())
console.log(describePlan(version, plan))
if (plan.action === 'refuse') fail(`${plan.reason} — the release step's own log is above`)

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
    // semantic-release sets make_latest itself when it publishes; with draftRelease it
    // never gets there, so we do it. Safe because this runs inside the run that cut the tag
    // and packaging is serialized, so no newer release exists yet — publishing an older tag
    // as latest out of band would demote the newer one.
    const r = gh(['release', 'edit', tag, '--draft=false', '--latest'])
    if (!r.ok) fail(`could not publish ${tag}: ${r.stderr.trim()}`)
    console.log(`published ${tag}`)
  }
}

const output = process.env['GITHUB_OUTPUT']
if (output) appendFileSync(output, `version=${version}\n`)
