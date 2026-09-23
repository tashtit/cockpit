import { app, net } from 'electron'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { userDataDir } from './config'
import { execText } from './env'
import {
  assetUrl,
  bundleOf,
  isNewer,
  isSafeAssetName,
  isSafeVersion,
  swapRefusal,
  swapScript,
  teamIdentifier,
  type BundleFacts,
  type FeedFile
} from './update-install-core'

/**
 * Installing an update, the IO half: fetch the release zip, prove it is the build
 * the feed describes and the app it claims to be, and leave a script behind that
 * swaps it in once Cockpit is gone. `update-install-core.ts` holds the decisions
 * and the script's text — and why Cockpit installs its own updates at all.
 *
 * Everything lives under `<userData>/updates`, never beside the app: a partial
 * download must never end up somewhere Finder would open it.
 */

/** Cockpit's own scratch space for an update in flight. */
export function updatesDir(): string {
  return join(userDataDir(), 'updates')
}

function stageDir(): string {
  return join(updatesDir(), 'staged')
}

/** One line the swap script leaves for the next launch: `ok`, or why it failed. */
function resultFile(): string {
  return join(updatesDir(), 'last-install')
}

function scriptFile(): string {
  // outside the stage dir on purpose — the script removes that dir as its last act
  return join(updatesDir(), 'install.sh')
}

function manifestFile(): string {
  return join(stageDir(), 'staged.json')
}

/** A verified bundle waiting for the app to quit. */
export type Staged = {
  readonly version: string
  /** The `.app` that replaces the running one */
  readonly app: string
}

/**
 * How the zip is fetched. Chromium's network stack by default — system proxies,
 * the OS trust store, redirects followed (GitHub sends every asset to a CDN) —
 * and a plain async iterable so tests can hand over bytes without a server.
 */
export type UpdateFetch = (url: string) => Promise<{
  readonly ok: boolean
  readonly status: number
  readonly body: AsyncIterable<Uint8Array> | null
}>

const electronFetch: UpdateFetch = async (url) => {
  const res = await net.fetch(url)
  return {
    ok: res.ok,
    status: res.status,
    body: res.body ? Readable.fromWeb(res.body as WebReadableStream<Uint8Array>) : null
  }
}

/** What a bundle says about itself, read from its Info.plist and its signature. */
export async function bundleFacts(bundle: string): Promise<BundleFacts> {
  const plist = await execText('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(bundle, 'Contents', 'Info.plist')])
  let info: Record<string, unknown> = {}
  if (plist.ok) {
    try {
      info = JSON.parse(plist.stdout) as Record<string, unknown>
    } catch {
      /* an unreadable Info.plist leaves every fact empty, which swapRefusal refuses */
    }
  }
  const str = (key: string): string => (typeof info[key] === 'string' ? (info[key] as string) : '')
  const exe = str('CFBundleExecutable')
  // `codesign -dv` writes to stderr, and an unsigned bundle is not an error here —
  // it is the state most Cockpit releases are in
  const sig = await execText('/usr/bin/codesign', ['-dv', '--verbose=2', bundle])
  return {
    identifier: str('CFBundleIdentifier'),
    version: str('CFBundleShortVersionString'),
    team: teamIdentifier(sig.stderr + sig.stdout),
    executable: exe && existsSync(join(bundle, 'Contents', 'MacOS', exe)) ? exe : ''
  }
}

/** The bundle Cockpit is running from; null when this is not an installed app. */
export function runningBundle(): string | null {
  return bundleOf(app.getPath('exe'))
}

export type StageRequest = {
  readonly version: string
  readonly file: FeedFile
  readonly releasesUrl: string
  /** The bundle this build has to be able to replace — `runningBundle()` in the app */
  readonly bundle: string
  /** Whole percent, only when it changes */
  readonly onProgress: (percent: number) => void
}

/**
 * Fetch the offered build and leave it verified and ready to swap in. Throws with
 * a sentence the About row can show — every failure here is one the user may have
 * to act on (no space, no write access, a download that does not match the feed).
 */
export async function stageUpdate(req: StageRequest, fetch: UpdateFetch = electronFetch): Promise<Staged> {
  const { bundle, version, file } = req
  if (!isSafeVersion(version)) throw new Error(`the release feed offered an unusable version (${version})`)
  if (!isSafeAssetName(file.url)) throw new Error(`the release feed offered an unusable file name (${file.url})`)
  if (!file.sha512) throw new Error('the release feed carries no checksum for this build')

  const dir = stageDir()
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })

  const zip = join(dir, file.url)
  await downloadTo(assetUrl(req.releasesUrl, version, file.url), zip, {
    sha512: file.sha512,
    size: file.size,
    onProgress: req.onProgress,
    fetch
  })

  const expanded = join(dir, 'app')
  // ditto, not unzip: it is what electron-builder wrote the archive with, and the
  // only expander that restores a bundle's symlinks and permissions intact
  const out = await execText('/usr/bin/ditto', ['-x', '-k', zip, expanded], { timeoutMs: 5 * 60_000 })
  if (!out.ok) throw new Error(`could not expand the download (${out.stderr.trim() || out.error})`)
  // the zip is the larger half of a ~130MB stage — nothing reads it again
  await rm(zip, { force: true })

  const name = readdirSync(expanded).find((e) => e.endsWith('.app'))
  if (!name) throw new Error('the download holds no application')
  const staged = join(expanded, name)

  // Cockpit fetched this itself, so macOS never flagged it; clearing the flag anyway
  // is what keeps the installed copy from being the one Gatekeeper blocks
  await execText('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', staged], { timeoutMs: 60_000 })

  const refusal = swapRefusal(await bundleFacts(staged), await bundleFacts(bundle), version)
  if (refusal) throw new Error(`refusing to install ${version}: ${refusal}`)

  await writeFile(manifestFile(), JSON.stringify({ version, app: staged }), 'utf8')
  return { version, app: staged }
}

type DownloadOptions = {
  readonly sha512: string
  readonly size?: number
  readonly onProgress: (percent: number) => void
  readonly fetch: UpdateFetch
}

/** Stream the asset to disk, hashing as it goes — a mismatch never reaches the expander. */
async function downloadTo(url: string, file: string, opts: DownloadOptions): Promise<void> {
  const res = await opts.fetch(url)
  if (!res.ok || !res.body) throw new Error(`the download failed (HTTP ${res.status})`)

  const hash = createHash('sha512')
  let done = 0
  let shown = -1
  // pipeline, not a hand-rolled write loop: a full disk or a dropped connection
  // has to reject here, not surface as an unhandled 'error' on the write stream
  await pipeline(
    res.body,
    async function* (chunks: AsyncIterable<Uint8Array>) {
      for await (const chunk of chunks) {
        hash.update(chunk)
        done += chunk.length
        if (opts.size) {
          const percent = Math.min(99, Math.floor((done / opts.size) * 100))
          if (percent !== shown) {
            shown = percent
            opts.onProgress(percent)
          }
        }
        yield chunk
      }
    },
    createWriteStream(file)
  )

  const got = hash.digest('base64')
  if (got !== opts.sha512) {
    await rm(file, { force: true })
    throw new Error('the download does not match the checksum the release publishes')
  }
  opts.onProgress(100)
}

/**
 * Hand the swap to a detached script and let it wait for this process to end. It
 * is spawned before the app quits rather than after, because after there is
 * nothing left to spawn it. Returns the pid now doing the waiting.
 */
export function armSwap(staged: Staged, target: string, relaunch: boolean): number {
  const script = scriptFile()
  // synchronous throughout: `before-quit` does not wait on a promise
  mkdirSync(updatesDir(), { recursive: true })
  writeFileSync(
    script,
    swapScript({
      pid: process.pid,
      target,
      staged: staged.app,
      stageDir: stageDir(),
      resultFile: resultFile(),
      relaunch
    }),
    'utf8'
  )
  chmodSync(script, 0o755)
  const child = spawn('/bin/sh', [script], { detached: true, stdio: 'ignore' })
  // a spawn that fails reports through 'error' — unheard, that is main's error
  // dialog in the middle of quitting; a missing pid (0) already says it didn't run
  child.on('error', (err) => console.error('[updates] could not start the install script:', err))
  child.unref()
  return child.pid ?? 0
}

/**
 * What the last swap reported, or null when none has run since it was cleared.
 * Read without clearing: a failed install must keep saying so, or the next check
 * would offer the same build and fail the same way with nobody the wiser.
 */
export async function readInstallResult(): Promise<string | null> {
  try {
    const line = (await readFile(resultFile(), 'utf8')).trim()
    return line === 'ok' || line === '' ? null : line
  } catch {
    return null
  }
}

export async function clearInstallResult(): Promise<void> {
  await rm(resultFile(), { force: true })
}

/**
 * The build staged before the app last quit — and nothing else left behind.
 *
 * Cockpit downloads on its own now, so quitting mid-cycle is ordinary: without
 * this, every such quit would throw away a finished download. The other half is
 * that the stage dir is hundreds of megabytes and only worth that while the build
 * in it is still going to be installed. A download a quit interrupted leaves no
 * manifest to resume from, and one this app has since passed — installed by hand,
 * or superseded by a newer release — will never be run. Launch is the only pass
 * that reaches either, so it is where they go.
 */
export async function resumeStaged(currentVersion: string): Promise<Staged | null> {
  const staged = await readStaged(currentVersion)
  if (!staged) await discardStaged()
  return staged
}

async function readStaged(currentVersion: string): Promise<Staged | null> {
  try {
    const saved = JSON.parse(await readFile(manifestFile(), 'utf8')) as Partial<Staged>
    if (typeof saved.version !== 'string' || typeof saved.app !== 'string') return null
    if (!isNewer(saved.version, currentVersion)) return null
    if (!existsSync(saved.app)) return null
    return { version: saved.version, app: saved.app }
  } catch {
    return null
  }
}

/** Forget a staged build and everything downloaded for it. */
export async function discardStaged(): Promise<void> {
  await rm(stageDir(), { recursive: true, force: true })
}
