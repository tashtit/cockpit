// @ts-check
/**
 * electron-builder packaging — macOS only (Linux stays a dev/CI host, nothing ships there).
 *
 * The version is never set here: semantic-release stamps package.json with `npm version`
 * right before packaging (see .releaserc.json), so a release build carries the tag's
 * version and every other build (`npm run package`, the PR job) packages as 0.0.0.
 *
 * Signing and notarization switch on by the presence of Apple credentials and off
 * otherwise, so the same config yields an ad-hoc build on a laptop or a fork and a
 * notarized one in the release job once the secrets exist (CONTRIBUTING.md, "Releases"):
 *   CSC_LINK + CSC_KEY_PASSWORD                             Developer ID Application certificate (.p12)
 *   APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID  notarization
 * All five or none: Gatekeeper refuses a signed-but-unnotarized bundle exactly like an
 * unsigned one, so a partial set is a misconfiguration and fails the build up front. With
 * the set present, signing is mandatory (forceCodeSigning) and scripts/verify-signing.mts
 * checks the result at the end of `npm run package` — a release never ships unsigned by
 * accident. Without the set nothing fails: the build is ad-hoc and must stay so.
 */
const APPLE_ENV = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID']

// GitHub Actions hands an unset secret over as an empty string, and electron-builder takes
// an empty CSC_LINK for a certificate to import (it only skips on null) — so absence has to
// be made absence before it looks.
for (const k of APPLE_ENV) if (!process.env[k]) delete process.env[k]

const provided = APPLE_ENV.filter((k) => k in process.env)
if (provided.length > 0 && provided.length < APPLE_ENV.length) {
  const missing = APPLE_ENV.filter((k) => !(k in process.env))
  throw new Error(
    `Apple signing is all-or-nothing: ${provided.join(', ')} set, ${missing.join(', ')} missing. ` +
      'Supply all five (CONTRIBUTING.md, "Signing and notarization") or none for an ad-hoc build.'
  )
}
const signing = provided.length === APPLE_ENV.length

// electron-builder looks for a signing identity only while discovery is on (findIdentity
// in app-builder-lib's macCodeSign): off, it ignores even the temporary keychain it just
// imported CSC_LINK into and "skips" signing with a warning — the build ships unsigned.
// On, that temporary keychain is the only one it searches when CSC_LINK is set, so the
// supplied certificate is the one identity that can sign; and without a certificate
// discovery stays off, so nothing sitting in a login keychain ever signs a build.
process.env.CSC_IDENTITY_AUTO_DISCOVERY = signing ? 'true' : 'false'

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'dev.tashtit.cockpit',
  productName: 'Cockpit',
  copyright: 'Copyright © 2026 tashtit',
  directories: { output: 'dist', buildResources: 'build' },
  // out/ is electron-vite's bundle. The renderer is static and self-contained, but
  // electron-vite leaves package.json `dependencies` external for main — the bundle does
  // `require('electron-updater')` at load — so production node_modules ship too (the
  // default; electron-builder walks the dependency tree itself). fsevents is the one
  // exception: an optional native module nothing here loads (watching uses fs.watch).
  // package.json rides along because Electron reads the app name and version from it.
  files: ['out/**', 'package.json', '!node_modules/fsevents/**'],
  // nothing native ships (fsevents is excluded above) — nothing to rebuild against Electron's ABI
  npmRebuild: false,
  asar: true,
  // with a certificate supplied, failing to sign fails the build — never a quiet unsigned release
  forceCodeSigning: signing,
  mac: {
    category: 'public.app-category.developer-tools',
    // a 1254px PNG; electron-builder renders the .icns set from it
    icon: 'resources/icon.png',
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      // the zip is what electron-updater actually downloads; the dmg is for people
      { target: 'zip', arch: ['arm64', 'x64'] }
    ],
    artifactName: '${productName}-${version}-${arch}.${ext}',
    darkModeSupport: true,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    // electron-builder notarizes and staples the .app right after signing it, before the
    // dmg and zip are built from it, with APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID
    notarize: signing
  },
  dmg: {
    // the notarized .app inside is what Gatekeeper checks; signing the image adds nothing
    sign: false
  },
  // Electron fuses — build-time switches that remove capabilities an installed app
  // never needs. Node CLI inspect arguments stay ON: Playwright attaches to the packaged
  // bundle through `--inspect` in the smoke test (tests/e2e/packaged.spec.ts).
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: true,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    // an unsigned arm64 build needs its ad-hoc signature restored after the fuses
    // are flipped; a real signature (when the cert is present) replaces it anyway
    resetAdHocDarwinSignature: true
  },
  // Not an upload target here (every build runs with --publish never; semantic-release
  // attaches the assets): this tells electron-builder to write app-update.yml into the
  // bundle and latest-mac.yml next to the artifacts — the two files electron-updater reads.
  publish: [{ provider: 'github', owner: 'tashtit', repo: 'cockpit' }]
}
