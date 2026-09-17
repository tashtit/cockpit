/**
 * Installing an update, minus the IO: which asset this Mac wants, where it comes
 * from, whether a staged bundle may replace the running one, and the script that
 * does the swap. `update-install.ts` carries these out.
 *
 * Cockpit installs its own updates rather than handing the zip to Squirrel.Mac
 * (what electron-updater does on macOS). Squirrel validates that the new bundle
 * carries the same Developer ID signature as the running one, and Cockpit's
 * releases are ad-hoc signed on purpose while it is pre-1.0 (CONTRIBUTING.md,
 * "Releases") — so every install ended in an error and the app could only ever
 * announce a version it could not fetch for you. Swapping the bundle ourselves
 * works signed or not, and it is the one place that can clear the quarantine flag
 * before the new app lands rather than leaving Gatekeeper to block it afterwards.
 *
 * What is given up is Squirrel's signature check, so the checks it stood for are
 * made here instead: the zip must hash to what the feed says, and the bundle
 * inside it must be the same app, at the version that was offered, signed by the
 * same team as the one it replaces.
 */

/** One macOS asset as `latest-mac.yml` lists it — remote input, so every field is optional. */
export type FeedFile = {
  readonly url: string
  readonly sha512?: string
  readonly size?: number
}

/** Architectures released for macOS; `process.arch` for anything else means no update. */
const ARCHES = ['arm64', 'x64'] as const

/**
 * The zip for this Mac. The feed lists every mac artifact — both architectures,
 * dmg and zip — and only the zip is an app bundle we can expand. A Mac running
 * the x64 build under Rosetta keeps getting x64 builds: swapping it for arm64
 * would be a different binary than the one whose signature was just compared.
 */
export function pickZip(files: readonly FeedFile[], arch: string): FeedFile | null {
  if (!ARCHES.some((a) => a === arch)) return null
  return files.find((f) => typeof f?.url === 'string' && f.url.endsWith(`-${arch}.zip`)) ?? null
}

/** Release assets live under the tag semantic-release cuts: `v<version>` (.releaserc.json). */
export function assetUrl(releasesUrl: string, version: string, file: string): string {
  return `${releasesUrl}/download/v${version}/${encodeURIComponent(file)}`
}

/**
 * The feed is fetched over TLS but it is still remote input, and its version and
 * file name both become path segments here. Anything outside these shapes is
 * refused rather than sanitized — a release never needs it.
 */
export function isSafeVersion(version: string): boolean {
  return /^\d[\w.+-]{0,63}$/.test(version)
}

export function isSafeAssetName(name: string): boolean {
  return /^[\w.-]{1,128}\.zip$/.test(name) && !name.startsWith('.')
}

/** `/Applications/Cockpit.app/Contents/MacOS/Cockpit` → `/Applications/Cockpit.app` */
export function bundleOf(execPath: string): string | null {
  const at = execPath.indexOf('/Contents/MacOS/')
  if (at < 0) return null
  const bundle = execPath.slice(0, at)
  return bundle.endsWith('.app') ? bundle : null
}

/**
 * The signing team `codesign -dv` reports, or '' when there is none. An ad-hoc
 * build prints `TeamIdentifier=not set`, which is the same as unsigned here:
 * nothing to hold the replacement to.
 */
export function teamIdentifier(codesignOutput: string): string {
  const id = /^TeamIdentifier=(.*)$/m.exec(codesignOutput)?.[1]?.trim() ?? ''
  return id === 'not set' ? '' : id
}

/** What an app bundle says about itself: its Info.plist, plus who signed it. */
export type BundleFacts = {
  readonly identifier: string
  readonly version: string
  readonly team: string
  /** Name from CFBundleExecutable; '' when Contents/MacOS holds no such file */
  readonly executable: string
}

/**
 * Why a downloaded bundle must not replace the running one — null when it may.
 * This is what stands in for Squirrel's own validation, so it refuses on doubt.
 */
export function swapRefusal(
  staged: BundleFacts,
  running: BundleFacts,
  offered: string
): string | null {
  if (!staged.executable) {
    return 'the download has no application inside it'
  }
  if (staged.identifier !== running.identifier) {
    return `the download identifies itself as ${staged.identifier || 'nothing'}, not ${running.identifier}`
  }
  if (staged.version !== offered) {
    return `the download is version ${staged.version || 'unknown'}, not the ${offered} that was offered`
  }
  if (running.team && staged.team !== running.team) {
    return `the download is signed by ${staged.team || 'nobody'}, not by ${running.team}`
  }
  return null
}

/**
 * Newer in the ordinary `1.2.3` sense. Only the release numbers are compared: a
 * prerelease is never offered (allowPrerelease stays off), so a suffix here means
 * a hand-built version and never wins a tie.
 */
export function isNewer(candidate: string, current: string): boolean {
  const parts = (v: string): number[] =>
    (v.split('-')[0] ?? '').split('.').map((s) => Number.parseInt(s, 10) || 0)
  const a = parts(candidate)
  const b = parts(current)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

export type SwapPlan = {
  /** Cockpit's own pid — the script waits for it to go before touching the bundle */
  readonly pid: number
  /** The bundle being replaced: where the app is running from now */
  readonly target: string
  /** The verified bundle that replaces it */
  readonly staged: string
  /** Removed once the swap lands */
  readonly stageDir: string
  /** One line for the next launch to read: `ok`, or why it failed */
  readonly resultFile: string
  /** Reopen the app afterwards (Restart now), rather than leave it quit */
  readonly relaunch: boolean
}

/** Single-quote for /bin/sh — the only way a path stays one word whatever is in it. */
function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The swap, as a detached script: a running bundle cannot replace itself, so this
 * outlives the app and does the work once the process is gone. Every step is
 * reversible until the last one — the old bundle is renamed aside within the same
 * folder (a rename, so it is instant and cannot half-finish) and put back if the
 * copy fails, which is why a failed update leaves a working app rather than none.
 */
export function swapScript(plan: SwapPlan): string {
  return `#!/bin/sh
# Written by Cockpit to install an update it already downloaded and verified.
# Safe to delete: it does nothing once the app it names has been replaced.
PID=${plan.pid}
TARGET=${q(plan.target)}
NEW=${q(plan.staged)}
STAGE=${q(plan.stageDir)}
RESULT=${q(plan.resultFile)}
RELAUNCH=${plan.relaunch ? 1 : 0}
BACKUP="$TARGET.cockpit-previous"

fail() {
  printf '%s\\n' "$1" > "$RESULT"
  exit 1
}

# the bundle cannot be replaced while its executable is still mapped
waited=0
while kill -0 "$PID" 2>/dev/null; do
  waited=$((waited + 1))
  [ "$waited" -le 600 ] || fail "Cockpit was still running a minute after it was asked to quit."
  sleep 0.1
done

rm -rf "$BACKUP"
mv "$TARGET" "$BACKUP" 2>/dev/null || fail "Could not move $TARGET aside — check that you can write to the folder holding it."
if ditto "$NEW" "$TARGET"; then
  # nothing downloaded here carries a quarantine flag — Cockpit fetched it, not a
  # browser — but clearing it costs nothing and is what would otherwise make
  # Gatekeeper block a build you already allowed
  xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null
  rm -rf "$BACKUP"
  printf 'ok\\n' > "$RESULT"
else
  rm -rf "$TARGET"
  mv "$BACKUP" "$TARGET" 2>/dev/null
  fail "Copying the new version into $TARGET failed; the one you had is back in place."
fi

rm -rf "$STAGE"
if [ "$RELAUNCH" = 1 ]; then
  open "$TARGET"
fi
`
}
