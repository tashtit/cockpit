import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execText } from '../src/main/env'
import { swapScript } from '../src/main/update-install-core'
import {
  armSwap,
  bundleFacts,
  readInstallResult,
  resumeStaged,
  stageUpdate,
  updatesDir,
  type UpdateFetch
} from '../src/main/update-install'

/**
 * The installer against real bundles: a fake `.app` is built on disk, archived the
 * way electron-builder archives one (`ditto -c -k --keepParent`), handed to
 * stageUpdate through an injected fetch, and the swap script is then run for real
 * against a real target.
 *
 * Nothing is stubbed, so the two halves that drive `ditto` / `plutil` / `codesign`
 * only run where those exist — the same platform the feature does. CI's unit tier
 * is Linux, so there they skip (like the sqlite3 cases in indexer.test.ts) and the
 * decisions stay covered by update-install-core.test.ts, which is pure.
 */
const onMac = process.platform === 'darwin'

const dirs: string[] = []
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'cockpit-update-'))
  dirs.push(d)
  return d
}

const IDENTIFIER = 'dev.tashtit.cockpit'

/** A bundle with just enough of an app in it for plutil and the swap to be real. */
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
</dict></plist>
`,
    'utf8'
  )
  const exe = join(bundle, 'Contents', 'MacOS', 'Cockpit')
  writeFileSync(exe, `#!/bin/sh\necho ${version}\n`, 'utf8')
  chmodSync(exe, 0o755)
  return bundle
}

/** The archive a release actually ships: ditto, keeping the bundle as the top entry. */
async function zipApp(bundle: string, to: string): Promise<{ sha512: string; size: number }> {
  const out = await execText('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', bundle, to], {
    timeoutMs: 60_000
  })
  if (!out.ok) throw new Error(out.stderr || String(out.error))
  const bytes = readFileSync(to)
  return { sha512: createHash('sha512').update(bytes).digest('base64'), size: bytes.length }
}

/** Serves the bytes of a file the way net.fetch would, in several chunks. */
function servesFile(file: string): UpdateFetch {
  return async () => ({
    ok: true,
    status: 200,
    body: (async function* () {
      const bytes = readFileSync(file)
      for (let at = 0; at < bytes.length; at += 64 * 1024) {
        yield new Uint8Array(bytes.subarray(at, at + 64 * 1024))
      }
    })()
  })
}

/** A pid that has certainly exited — what the swap script waits to stop seeing. */
async function deadPid(): Promise<number> {
  const child = spawn('/bin/sh', ['-c', 'exit 0'])
  await once(child, 'close')
  return child.pid ?? 1
}

function run(script: string): Promise<{ ok: boolean; stderr: string }> {
  return execText('/bin/sh', [script], { timeoutMs: 120_000 }).then((r) => ({ ok: r.ok, stderr: r.stderr }))
}

let home: string

beforeEach(() => {
  home = scratch()
  process.env['COCKPIT_USER_DATA'] = home
})

describe.skipIf(!onMac)('stageUpdate', () => {
  it('downloads, verifies and unpacks a build that may replace the running one', async () => {
    const world = scratch()
    const running = makeApp(mkdirAt(world, 'installed'), '0.11.0')
    const release = makeApp(mkdirAt(world, 'release'), '0.12.0')
    const zip = join(world, 'Cockpit-0.12.0-arm64.zip')
    const { sha512, size } = await zipApp(release, zip)

    const seen: number[] = []
    const staged = await stageUpdate(
      {
        version: '0.12.0',
        file: { url: 'Cockpit-0.12.0-arm64.zip', sha512, size },
        releasesUrl: 'https://github.com/tashtit/cockpit/releases',
        bundle: running,
        onProgress: (p) => seen.push(p)
      },
      servesFile(zip)
    )

    expect(staged.version).toBe('0.12.0')
    expect((await bundleFacts(staged.app)).version).toBe('0.12.0')
    // the executable bit survives the round trip — a bundle without it cannot launch
    expect((await bundleFacts(staged.app)).executable).toBe('Cockpit')
    expect(seen.at(-1)).toBe(100)
    // the zip is the larger half of the stage and nothing reads it twice
    expect(existsSync(join(updatesDir(), 'staged', 'Cockpit-0.12.0-arm64.zip'))).toBe(false)
    // and it survives a quit: the next launch picks the download back up
    expect(await resumeStaged('0.11.0')).toEqual(staged)
    // but only while it is still ahead of the app — once it is not, resuming is
    // also what sweeps it, or a few hundred MB of a version nobody will run sits
    // there until some later update happens to overwrite it
    expect(await resumeStaged('0.12.0')).toBeNull()
    expect(existsSync(join(updatesDir(), 'staged'))).toBe(false)
  })

  it('sweeps a download a quit interrupted, which has no manifest to resume from', async () => {
    const half = join(updatesDir(), 'staged')
    mkdirSync(half, { recursive: true })
    writeFileSync(join(half, 'Cockpit-0.12.0-arm64.zip'), 'half a download', 'utf8')

    expect(await resumeStaged('0.11.0')).toBeNull()
    expect(existsSync(half)).toBe(false)
  })

  it('refuses a download that does not match the checksum the release publishes', async () => {
    const world = scratch()
    const running = makeApp(mkdirAt(world, 'installed'), '0.11.0')
    const release = makeApp(mkdirAt(world, 'release'), '0.12.0')
    const zip = join(world, 'Cockpit-0.12.0-arm64.zip')
    const { size } = await zipApp(release, zip)

    await expect(
      stageUpdate(
        {
          version: '0.12.0',
          file: { url: 'Cockpit-0.12.0-arm64.zip', sha512: 'not-the-hash', size },
          releasesUrl: 'https://github.com/tashtit/cockpit/releases',
          bundle: running,
          onProgress: () => {}
        },
        servesFile(zip)
      )
    ).rejects.toThrow(/checksum/)
  })

  it('refuses an archive holding a different application', async () => {
    const world = scratch()
    const running = makeApp(mkdirAt(world, 'installed'), '0.11.0')
    const release = makeApp(mkdirAt(world, 'release'), '0.12.0', { identifier: 'com.example.other' })
    const zip = join(world, 'Cockpit-0.12.0-arm64.zip')
    const { sha512, size } = await zipApp(release, zip)

    await expect(
      stageUpdate(
        {
          version: '0.12.0',
          file: { url: 'Cockpit-0.12.0-arm64.zip', sha512, size },
          releasesUrl: 'https://github.com/tashtit/cockpit/releases',
          bundle: running,
          onProgress: () => {}
        },
        servesFile(zip)
      )
    ).rejects.toThrow(/com\.example\.other/)
  })

  it('refuses a feed that names a version it could not put in a path', async () => {
    await expect(
      stageUpdate(
        {
          version: '../../../etc',
          file: { url: 'Cockpit-0.12.0-arm64.zip', sha512: 'x' },
          releasesUrl: 'https://github.com/tashtit/cockpit/releases',
          bundle: '/Applications/Cockpit.app',
          onProgress: () => {}
        },
        servesFile('/dev/null')
      )
    ).rejects.toThrow(/unusable version/)
  })
})

describe.skipIf(!onMac)('the swap script', () => {
  it('replaces the bundle once the app is gone, and clears its quarantine flag', async () => {
    const world = scratch()
    const target = makeApp(mkdirAt(world, 'Applications'), '0.11.0')
    const staged = makeApp(mkdirAt(world, 'stage'), '0.12.0')
    // the flag a browser download would have put there, to prove it does not survive
    await execText('/usr/bin/xattr', ['-w', 'com.apple.quarantine', '0081;0;Safari;', staged])

    const result = join(world, 'last-install')
    const script = join(world, 'install.sh')
    writeFileSync(
      script,
      swapScript({
        pid: await deadPid(),
        target,
        staged,
        stageDir: join(world, 'stage'),
        resultFile: result,
        relaunch: false
      }),
      'utf8'
    )
    expect((await run(script)).ok).toBe(true)

    expect((await bundleFacts(target)).version).toBe('0.12.0')
    expect(readFileSync(result, 'utf8').trim()).toBe('ok')
    // nothing left behind: neither the way back nor the download
    expect(existsSync(`${target}.cockpit-previous`)).toBe(false)
    expect(existsSync(`${target}.cockpit-next`)).toBe(false)
    expect(existsSync(join(world, 'stage'))).toBe(false)
    const attrs = await execText('/usr/bin/xattr', [target])
    expect(attrs.stdout).not.toContain('com.apple.quarantine')
  })

  it('puts the version you had back when the copy fails', async () => {
    const world = scratch()
    const target = makeApp(mkdirAt(world, 'Applications'), '0.11.0')
    const result = join(world, 'last-install')
    const script = join(world, 'install.sh')
    writeFileSync(
      script,
      swapScript({
        pid: await deadPid(),
        target,
        staged: join(world, 'nothing-here.app'),
        stageDir: join(world, 'stage'),
        resultFile: result,
        relaunch: false
      }),
      'utf8'
    )
    expect((await run(script)).ok).toBe(false)

    // the app still runs, and the next launch is told why it is still the old one
    expect((await bundleFacts(target)).version).toBe('0.11.0')
    expect(readFileSync(result, 'utf8')).toMatch(/still in place/)
    // and nothing is left beside it: no half copy, no second bundle
    expect(existsSync(`${target}.cockpit-next`)).toBe(false)
    expect(existsSync(`${target}.cockpit-previous`)).toBe(false)
  })
})

describe('armSwap', () => {
  it('leaves a runnable script behind and reports what the last one did', async () => {
    const world = scratch()
    mkdirSync(updatesDir(), { recursive: true })
    const pid = armSwap({ version: '0.12.0', app: join(world, 'Cockpit.app') }, join(world, 'Target.app'), true)
    // it is waiting on this very process, which is not going to quit — let it go
    if (pid) process.kill(pid)

    const script = readFileSync(join(updatesDir(), 'install.sh'), 'utf8')
    expect(script).toContain(`PID=${process.pid}`)
    expect(script).toContain('RELAUNCH=1')

    // an `ok` is not news; anything else is, and stays readable until it is cleared
    expect(await readInstallResult()).toBeNull()
    writeFileSync(join(updatesDir(), 'last-install'), 'ok\n', 'utf8')
    expect(await readInstallResult()).toBeNull()
    writeFileSync(join(updatesDir(), 'last-install'), 'Could not move it aside.\n', 'utf8')
    expect(await readInstallResult()).toBe('Could not move it aside.')
  })
})

function mkdirAt(parent: string, name: string): string {
  const dir = join(parent, name)
  mkdirSync(dir, { recursive: true })
  return dir
}
