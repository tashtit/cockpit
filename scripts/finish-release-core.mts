/**
 * IO-free half of scripts/finish-release.mts: what is left to do for a release that
 * semantic-release started but did not finish.
 *
 * @semantic-release/github pushes the tag, creates the release as a draft, uploads the
 * assets one by one and only then clears the draft flag. A GitHub 500 on one of the
 * ~130MB disk images (v0.11.0, run 35267043631) aborts it in the middle of that, and the
 * state it leaves cannot be recovered by re-running: the tag is already there, so the
 * next run decides no release is due and skips the job entirely. This decides what an
 * already-created release still needs — which assets to re-upload, whether to publish —
 * so CI can finish the job semantic-release began.
 *
 * It refuses anything that is not that situation, so a genuine failure still fails the
 * run. tests/finish-release-core.test.ts targets it.
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

export type FinishPlan =
  /** the release is published and every asset is on it — nothing left to do */
  | { readonly action: 'none' }
  /** upload these, then publish if `publish` */
  | { readonly action: 'finish'; readonly upload: readonly string[]; readonly publish: boolean }
  /** not a half-finished release; say why and let the run fail */
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
 * What `version`'s release still needs. `release` is null when none exists at all, which
 * means semantic-release failed before creating it — there is nothing to finish.
 */
export function planFinish(
  version: string,
  release: ReleaseState | null,
  local: readonly LocalAsset[]
): FinishPlan {
  if (!version) return { action: 'refuse', reason: 'no packaged version to finish' }
  if (!release) {
    return { action: 'refuse', reason: `no release v${version} exists — semantic-release never created it` }
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
export function describePlan(version: string, plan: FinishPlan): string {
  if (plan.action === 'refuse') return `cannot finish v${version}: ${plan.reason}`
  if (plan.action === 'none') return `v${version} is already published with every asset`
  const uploads = plan.upload.length ? `re-uploading ${plan.upload.join(', ')}` : 'every asset is already there'
  return `finishing v${version}: ${uploads}${plan.publish ? '; publishing the draft' : ''}`
}
