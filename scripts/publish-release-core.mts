/**
 * IO-free half of scripts/publish-release.mts: what a release still needs before it can go
 * out — which assets to upload, whether to publish.
 *
 * Cockpit uploads its own assets. @semantic-release/github would do it, but it sends all
 * nine at once (`Promise.all` over the globbed assets) with each file read whole into
 * memory first, so ~540MB is in flight from one runner at a time. The largest file stays
 * in flight longest and absorbs any hiccup from GitHub's asset endpoint, which 500s now
 * and then; three retries later the plugin gives up, having already pushed the tag and
 * created the release as a draft. v0.11.0 and v0.13.0 died that way, both on the x64 disk
 * image, the biggest of the nine. So the plugin is left to write the tag, the notes and an
 * empty draft (`draftRelease` in .releaserc.json), and this decides what to send after it.
 *
 * It is also the repair: the plan is the same whether the release is a fresh empty draft or
 * one an earlier attempt left half-filled, which is what makes re-running it safe.
 * tests/publish-release-core.test.ts targets it.
 */

/** one asset as `gh release view --json assets` reports it */
export type ReleaseAsset = { readonly name: string; readonly size: number; readonly state: string }

/** the release `gh release view` found, as much of it as the plan needs */
export type ReleaseState = {
  readonly tagName: string
  readonly isDraft: boolean
  readonly assets: readonly ReleaseAsset[]
}

/** a file the package job built and the release job downloaded into dist/ */
export type LocalAsset = { readonly name: string; readonly size: number }

export type PublishPlan =
  /** the release is published and every asset is on it — nothing left to do */
  | { readonly action: 'none' }
  /** upload these, then publish if `publish` */
  | { readonly action: 'finish'; readonly upload: readonly string[]; readonly publish: boolean }
  /** nothing publishable; say why and let the run fail */
  | { readonly action: 'refuse'; readonly reason: string }

/** GitHub reports an asset that finished uploading as `uploaded`; anything else is in limbo. */
const UPLOADED = 'uploaded'

/**
 * An asset needs (re-)uploading when the release has no such name, when GitHub never
 * finished storing it, or when what it stored is not the size of the file we hold — a
 * truncated upload is worse than a missing one, because it looks like a download.
 */
function needsUpload(local: LocalAsset, assets: readonly ReleaseAsset[]): boolean {
  const remote = assets.find((asset) => asset.name === local.name)
  return !remote || remote.state !== UPLOADED || remote.size !== local.size
}

/**
 * What `version`'s release still needs before it can go out. `release` is null when none
 * exists at all, which means semantic-release failed before creating the draft — there is
 * nothing to publish.
 */
export function planPublish(
  version: string,
  release: ReleaseState | null,
  local: readonly LocalAsset[]
): PublishPlan {
  if (!version) return { action: 'refuse', reason: 'no packaged version to finish' }
  if (!release) {
    return { action: 'refuse', reason: `no release v${version} exists — semantic-release never created the draft` }
  }
  if (release.tagName !== `v${version}`) {
    return {
      action: 'refuse',
      reason: `release is tagged ${release.tagName}, but the package job built ${version}`
    }
  }
  if (local.length === 0) return { action: 'refuse', reason: 'dist/ holds no assets to upload' }

  const upload = local.filter((asset) => needsUpload(asset, release.assets)).map((asset) => asset.name)
  if (upload.length === 0 && !release.isDraft) return { action: 'none' }
  return { action: 'finish', upload, publish: release.isDraft }
}

/** One line for the log, so a run says what it repaired without reading the plan back. */
export function describePlan(version: string, plan: PublishPlan): string {
  if (plan.action === 'refuse') return `cannot publish v${version}: ${plan.reason}`
  if (plan.action === 'none') return `v${version} is already published with every asset`
  const uploads = plan.upload.length ? `uploading ${plan.upload.join(', ')}` : 'every asset is already there'
  return `v${version}: ${uploads}${plan.publish ? '; then publishing' : ''}`
}
