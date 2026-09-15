/**
 * Runs the packaged smoke spec (tests/e2e/packaged.spec.ts) against the .app that
 * `npm run package` just produced for this machine's architecture — electron-builder
 * puts arm64 under dist/mac-arm64 and x64 under dist/mac — or against whatever
 * COCKPIT_PACKAGED_APP already points at.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const bundleDir = process.arch === 'arm64' ? 'mac-arm64' : 'mac'
const exe =
  process.env['COCKPIT_PACKAGED_APP'] ??
  resolve('dist', bundleDir, 'Cockpit.app', 'Contents', 'MacOS', 'Cockpit')

if (!existsSync(exe)) {
  console.error(`packaged app missing at ${exe} — run \`npm run package\` first`)
  process.exit(1)
}

const run = spawnSync(
  resolve('node_modules', '.bin', 'playwright'),
  ['test', 'tests/e2e/packaged.spec.ts'],
  { stdio: 'inherit', env: { ...process.env, COCKPIT_PACKAGED_APP: exe } }
)
process.exit(run.status ?? 1)
