/**
 * Checks every Cockpit.app under dist/ against the credentials this build ran with —
 * `npm run package` ends with it. Without Apple credentials the bundles must have stayed
 * ad-hoc (nothing in a keychain may have signed them); with them every bundle must carry
 * a Developer ID Application signature for APPLE_TEAM_ID, the hardened runtime, a stapled
 * notarization ticket, and pass Gatekeeper's own assessment. Any mismatch exits 1, so a
 * release whose credentials failed to sign stops here instead of shipping unsigned.
 * The decision logic is in verify-signing-core.mts; this file only runs the tools.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { bundleProblems, describeSignature, expectedSigning, type BundleEvidence } from './verify-signing-core.mts'

type Run = { readonly ok: boolean; readonly output: string }

function run(cmd: string, args: readonly string[]): Run {
  const r = spawnSync(cmd, [...args], { encoding: 'utf8' })
  return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

function gather(app: string, signed: boolean): BundleEvidence {
  const codesign = run('codesign', ['-dvv', app]).output
  if (!signed) return { codesign, verifyOk: null, assessment: null, staplerOk: null }
  return {
    codesign,
    verifyOk: run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]).ok,
    assessment: run('spctl', ['--assess', '--type', 'execute', '-vv', app]).output,
    staplerOk: run('xcrun', ['stapler', 'validate', app]).ok
  }
}

// electron-builder lays bundles out as dist/mac (x64), dist/mac-arm64, dist/mac-universal
const dist = resolve('dist')
const bundles = existsSync(dist)
  ? readdirSync(dist)
      .filter((d) => /^mac(-|$)/.test(d))
      .map((d) => join(dist, d, 'Cockpit.app'))
      .filter((app) => existsSync(app))
  : []
if (bundles.length === 0) {
  console.error('no Cockpit.app under dist/ — run `npm run package` first')
  process.exit(1)
}

const expectation = expectedSigning(process.env)
console.log(
  expectation.signed
    ? `verifying Developer ID signing and notarization for team ${expectation.teamId}`
    : 'no Apple credentials — verifying the bundles stayed ad-hoc'
)
let failed = false
for (const app of bundles) {
  const evidence = gather(app, expectation.signed)
  const problems = bundleProblems(evidence, expectation)
  const name = relative(process.cwd(), app)
  if (problems.length === 0) {
    const notarized = expectation.signed ? ', notarized and stapled' : ''
    console.log(`  ✓ ${name} — ${describeSignature(evidence.codesign)}${notarized}`)
  } else {
    failed = true
    console.error(`  ✗ ${name}`)
    for (const problem of problems) console.error(`      ${problem}`)
  }
}
process.exit(failed ? 1 : 0)
