import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execText } from '../src/main/env'

/**
 * scripts/install.sh — the `curl … | sh` installer — run for real against a local
 * stand-in for the GitHub API: a node:http server answers `releases/latest` with
 * release JSON shaped like GitHub's and serves the zip that JSON points at, built
 * from a fake Cockpit.app with ditto the way electron-builder builds one.
 *
 * The script is macOS-only by design (ditto, plutil, shasum), so the install cases
 * run on a Mac and skip on CI's Linux unit tier, where the one case that can run
 * there — the polite refusal off macOS — does instead.
 */
const onMac = process.platform === 'darwin'
const SCRIPT = resolve(__dirname, '..', 'scripts', 'install.sh')
const IDENTIFIER = 'dev.tashtit.cockpit'
const LATEST = '/repos/tashtit/cockpit/releases/latest'

const dirs: string[] = []
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'cockpit-install-'))
  dirs.push(d)
  return d
}

/** A bundle with just enough of an app in it for plutil and ditto to be real. */
function makeApp(parent: string, version: string, opts: { identifier?: string } = {}): string {
  const bundle = join(parent, 'Cockpit.app')
  mkdirSync(join(bundle, 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(
    join(bundle, 'Contents', 'Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>${opts.identifier ?? IDENTIFIER}</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleExecutable</key><string>Cockpit</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
</dict></plist>
`,
    'utf8'
  )
  const exe = join(bundle, 'Contents', 'MacOS', 'Cockpit')
  writeFileSync(exe, `#!/bin/sh\necho ${version}\n`, 'utf8')
  chmodSync(exe, 0o755)
  return bundle
}

async function ok(cmd: string, args: readonly string[]): Promise<string> {
  const out = await execText(cmd, args, { timeoutMs: 60_000 })
  if (!out.ok) throw new Error(`${cmd} ${args.join(' ')}: ${out.stderr || out.error}`)
  return out.stdout
}

/** The release asset: ditto, keeping the bundle as the archive's top entry. */
async function releaseZip(version: string, opts: { identifier?: string; quarantined?: boolean } = {}): Promise<Buffer> {
  const world = scratch()
  const bundle = makeApp(world, version, opts)
  // What a browser leaves on a download, and the installer must not carry into the
  // install. On a file inside the bundle: ditto archives no attributes for the
  // --keepParent top entry itself, but restores an inner file's on unpacking.
  const exe = join(bundle, 'Contents', 'MacOS', 'Cockpit')
  if (opts.quarantined) await ok('/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0081;00000000;Safari;', exe])
  const zip = join(world, 'release.zip')
  await ok('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, zip])
  return readFileSync(zip)
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** What the stand-in API publishes; each test sets its own. */
type Release = {
  readonly tag: string
  readonly zip: Buffer
  /** the asset's `digest` field; null is what GitHub returns for assets it never hashed */
  readonly digest: string | null
}

let release: Release
let served: string[] = []
let server: Server
let base = ''

function releaseJson(r: Release): string {
  const version = r.tag.replace(/^v/, '')
  const asset = (name: string, digest: string | null, size: number): object => ({
    name,
    size,
    digest,
    content_type: 'application/octet-stream',
    browser_download_url: `${base}/download/${r.tag}/${name}`
  })
  return JSON.stringify({
    tag_name: r.tag,
    name: r.tag,
    draft: false,
    prerelease: false,
    body: null,
    assets: [
      asset(`Cockpit-${version}-arm64.dmg`, `sha256:${'0'.repeat(64)}`, 1),
      asset(`Cockpit-${version}-arm64.zip`, r.digest, r.zip.length),
      asset(`Cockpit-${version}-x64.zip`, r.digest, r.zip.length),
      asset('latest-mac.yml', `sha256:${'1'.repeat(64)}`, 1)
    ]
  })
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const path = req.url ?? ''
    served.push(path)
    if (path === LATEST) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(releaseJson(release))
    } else if (path.startsWith('/download/') && path.endsWith('.zip')) {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': release.zip.length })
      res.end(release.zip)
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.close()
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

beforeEach(() => {
  served = []
})

type Run = { readonly code: number | null; readonly stdout: string; readonly stderr: string }

/**
 * The script as the one-liner runs it: its text on sh's stdin, options after `-s --`.
 * HOME is a scratch folder and COCKPIT_INSTALL_DIR is always set, so no case can reach
 * the real /Applications or ~/Applications.
 */
async function install(dest: string, args: readonly string[] = [], env: NodeJS.ProcessEnv = {}): Promise<Run> {
  const child = spawn('/bin/sh', ['-s', '--', ...args], {
    env: {
      ...process.env,
      HOME: scratch(),
      COCKPIT_INSTALL_API: base,
      COCKPIT_INSTALL_DIR: dest,
      COCKPIT_INSTALL_ARCH: '',
      // a developer's proxy must not stand between the script and the local server
      NO_PROXY: '127.0.0.1',
      no_proxy: '127.0.0.1',
      ...env
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
  child.stdin.end(readFileSync(SCRIPT))
  const [code] = (await once(child, 'close')) as [number | null]
  return { code, stdout, stderr }
}

async function plistValue(bundle: string, key: string): Promise<string> {
  return (await ok('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', join(bundle, 'Contents', 'Info.plist')])).trim()
}

async function publish(version: string, opts: { identifier?: string; quarantined?: boolean } = {}): Promise<void> {
  const zip = await releaseZip(version, opts)
  release = { tag: `v${version}`, zip, digest: `sha256:${sha256(zip)}` }
}

/** The destination with an older Cockpit in it, plus a file only that copy has. */
function installed(version: string): { dest: string; app: string; marker: string } {
  const dest = join(scratch(), 'Applications')
  mkdirSync(dest)
  const app = makeApp(dest, version)
  const marker = join(app, 'Contents', 'Resources-only-in-the-old-copy')
  writeFileSync(marker, 'old\n')
  return { dest, app, marker }
}

const downloads = (): string[] => served.filter((p) => p.startsWith('/download/'))

describe.skipIf(!onMac)('install.sh', () => {
  it('installs the latest release into an empty folder', async () => {
    await publish('0.12.0', { quarantined: true })
    const dest = join(scratch(), 'Applications') // not there yet: the script creates it

    const run = await install(dest)

    expect(run.stderr).toBe('')
    expect(run.code).toBe(0)
    const app = join(dest, 'Cockpit.app')
    expect(await plistValue(app, 'CFBundleShortVersionString')).toBe('0.12.0')
    expect(await plistValue(app, 'CFBundleIdentifier')).toBe(IDENTIFIER)
    // the executable bit survives the zip round trip — a bundle without it cannot launch
    const exe = join(app, 'Contents', 'MacOS', 'Cockpit')
    expect((await ok(exe, [])).trim()).toBe('0.12.0')
    // the flag a browser leaves is exactly what the installer exists to avoid
    const flag = await execText('/usr/bin/xattr', ['-p', 'com.apple.quarantine', exe])
    expect(flag.ok).toBe(false)
    // nothing left beside it
    expect(readdirSync(dest)).toEqual(['Cockpit.app'])
    expect(run.stdout).toContain('Installed Cockpit 0.12.0')
    expect(run.stdout).toContain(`open '${app}'`)
    expect(run.stdout).toContain('gh attestation verify Cockpit-0.12.0-')
    // one lookup, one download, and never the updater's manifest: its download count
    // stands for installed copies checking for updates
    expect(served).toHaveLength(2)
    expect(served[0]).toBe(LATEST)
    expect(served.some((p) => p.includes('latest-mac.yml'))).toBe(false)
  })

  it('replaces an installed copy on upgrade', async () => {
    await publish('0.12.0')
    const { dest, app, marker } = installed('0.11.0')

    const run = await install(dest)

    expect(run.code).toBe(0)
    expect(await plistValue(app, 'CFBundleShortVersionString')).toBe('0.12.0')
    // replaced, not merged: nothing of the old bundle survives inside the new one
    expect(existsSync(marker)).toBe(false)
    // and the old copy is gone rather than parked beside it
    expect(readdirSync(dest)).toEqual(['Cockpit.app'])
    expect(run.stdout).toContain('Updated Cockpit from 0.11.0 to 0.12.0')
  })

  it('refuses a download that does not match the digest and leaves the install alone', async () => {
    await publish('0.12.0')
    release = { ...release, digest: `sha256:${'a'.repeat(64)}` }
    const { dest, app, marker } = installed('0.11.0')

    const run = await install(dest)

    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain('does not match the SHA-256 digest')
    expect(run.stderr).toContain('Nothing was installed')
    expect(await plistValue(app, 'CFBundleShortVersionString')).toBe('0.11.0')
    expect(existsSync(marker)).toBe(true)
    expect(readdirSync(dest)).toEqual(['Cockpit.app'])
  })

  it('refuses a release that lists no digest, before downloading anything', async () => {
    await publish('0.12.0')
    release = { ...release, digest: null }
    const { dest, app } = installed('0.11.0')

    const run = await install(dest)

    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain('no SHA-256 digest')
    expect(downloads()).toEqual([])
    expect(await plistValue(app, 'CFBundleShortVersionString')).toBe('0.11.0')
  })

  it('refuses a bundle that is not Cockpit', async () => {
    await publish('0.12.0', { identifier: 'com.example.other' })
    const { dest, app, marker } = installed('0.11.0')

    const run = await install(dest)

    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain("bundle id 'com.example.other'")
    expect(await plistValue(app, 'CFBundleIdentifier')).toBe(IDENTIFIER)
    expect(await plistValue(app, 'CFBundleShortVersionString')).toBe('0.11.0')
    expect(existsSync(marker)).toBe(true)
    expect(readdirSync(dest)).toEqual(['Cockpit.app'])
  })

  it('refuses a bundle whose version is not the release', async () => {
    const zip = await releaseZip('0.11.9')
    release = { tag: 'v0.12.0', zip, digest: `sha256:${sha256(zip)}` }
    const dest = join(scratch(), 'Applications')

    const run = await install(dest)

    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain("version '0.11.9', not the 0.12.0")
    expect(existsSync(join(dest, 'Cockpit.app'))).toBe(false)
  })

  it('never replaces another app that happens to be called Cockpit.app', async () => {
    await publish('0.12.0')
    const dest = join(scratch(), 'Applications')
    mkdirSync(dest)
    const other = makeApp(dest, '3.0', { identifier: 'com.example.cockpit' })

    const run = await install(dest)

    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain('is not Cockpit')
    expect(await plistValue(other, 'CFBundleIdentifier')).toBe('com.example.cockpit')
    expect(downloads()).toEqual([])
  })

  it('stops while the installed copy is running', async () => {
    await publish('0.12.0')
    const { dest, app } = installed('0.11.0')
    // a real process that ps lists the way it lists Cockpit's: the installed bundle's
    // executable as its command. Only the command line is what the script reads, so
    // /bin/sleep runs from where it lives under that argv0. A copy of it inside the
    // bundle is killed on launch (Code Signature Invalid) and macOS answers that with
    // a crash report and a "Cockpit.app is damaged" alert on every test run.
    const exe = join(app, 'Contents', 'MacOS', 'Cockpit')
    const running: ChildProcess = spawn('/bin/sleep', ['30'], { argv0: exe, stdio: 'ignore' })
    try {
      await once(running, 'spawn')
      const run = await install(dest)

      expect(run.code).not.toBe(0)
      expect(run.stderr).toContain('Cockpit is running')
      expect(downloads()).toEqual([])
      expect(await plistValue(app, 'CFBundleShortVersionString')).toBe('0.11.0')
    } finally {
      running.kill()
    }
  })

  it('resolves everything on a dry run and downloads nothing', async () => {
    await publish('0.12.0')
    const dest = join(scratch(), 'Applications')

    const run = await install(dest, ['--dry-run'], { COCKPIT_INSTALL_ARCH: 'x64' })

    expect(run.code).toBe(0)
    expect(run.stdout).toContain('Cockpit 0.12.0 for Intel')
    expect(run.stdout).toContain('Cockpit-0.12.0-x64.zip')
    expect(run.stdout).toContain(`${base}/download/v0.12.0/Cockpit-0.12.0-x64.zip`)
    expect(run.stdout).toContain(sha256(release.zip))
    expect(run.stdout).toContain(`${join(dest, 'Cockpit.app')} (folder will be created)`)
    expect(served).toEqual([LATEST])
    expect(existsSync(dest)).toBe(false)
  })

  it('takes another architecture only for a dry run', async () => {
    await publish('0.12.0')
    const run = await install(join(scratch(), 'Applications'), [], { COCKPIT_INSTALL_ARCH: 'x64' })

    expect(run.code).not.toBe(0)
    expect(run.stderr).toContain('only applies with --dry-run')
    expect(served).toEqual([])
  })
})

describe.skipIf(onMac)('install.sh off macOS', () => {
  it('refuses politely without touching the network', async () => {
    release = { tag: 'v0.12.0', zip: Buffer.alloc(0), digest: null }
    const run = await install(join(scratch(), 'Applications'))

    expect(run.code).toBe(1)
    expect(run.stderr).toContain('Cockpit is a macOS app')
    expect(served).toEqual([])
  })
})
