import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs'
import { extname } from 'node:path'
import type { SessionFilePreview, SessionMessage, SessionMeta } from '../shared/types'
import { buildWork } from '../shared/work'

/**
 * The files an agent shared with the person (`SendUserFile`, a published page, Copilot's
 * `files/`), for the Work panel: a bounded preview, and opening one in its app or in
 * Finder.
 *
 * The path comes from the renderer, so it is untrusted: main acts only on a path the
 * session's own log says it shared — never one the renderer merely names — and opens
 * only documents and images, by the extension of the file the path really resolves to:
 * `shell.openPath` on a `.command` or an `.app` would run it.
 */

/** Images the panel draws, and the type a blob of each needs */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml'
}
/** What the OS may open for the person: documents, images and recordings — nothing that runs */
const OPENABLE = new Set([
  ...Object.keys(IMAGE_TYPES),
  '.heic',
  '.tif',
  '.tiff',
  '.pdf',
  '.md',
  '.markdown',
  '.txt',
  '.log',
  '.csv',
  '.tsv',
  '.json',
  '.yaml',
  '.yml',
  '.diff',
  '.patch',
  '.html',
  '.htm',
  '.mov',
  '.mp4',
  '.webm'
])
const MARKDOWN = new Set(['.md', '.markdown'])
/** Text that reads as its source here but is meant to be seen rendered: a page opens in the browser */
const RENDERED_ELSEWHERE = new Set(['.html', '.htm'])
/** An image crosses IPC whole; past this it is opened, not previewed */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
/** The head of a text file the preview shows */
export const MAX_TEXT_BYTES = 64 * 1024

type SessionReader = {
  readonly getSession: (id: string) => SessionMeta | null
  readonly getMessages: (id: string) => SessionMessage[]
}

/**
 * The path, when the session's own log shared it — the only paths main reads or opens
 * for a session. Throws for anything else, which the renderer shows as the reason.
 */
export function assertSharedFile(sessions: SessionReader, sessionId: unknown, path: unknown): string {
  const meta = sessions.getSession(String(sessionId))
  if (!meta) throw new Error('Unknown session — it may not be indexed yet.')
  const p = String(path)
  const shared = buildWork(sessions.getMessages(meta.id), meta.cwd ?? undefined).shared.files
  if (!shared.some((f) => f.path === p)) throw new Error('This session did not share that file.')
  return p
}

function openable(real: string): boolean {
  return OPENABLE.has(extname(real).toLowerCase())
}

/** The file a path really is: its target when it is a link, null when there is none. */
function resolved(path: string): { readonly real: string; readonly size: number } | null {
  try {
    const real = realpathSync(path)
    const st = statSync(real)
    return st.isFile() ? { real, size: st.size } : null
  } catch {
    return null
  }
}

function head(file: string, bytes: number): Buffer {
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const buf = Buffer.alloc(bytes)
    const n = readSync(fd, buf, 0, bytes, 0)
    return buf.subarray(0, n)
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/** A shared file, read for its preview: an image whole, the head of text, else what it is. */
export function readSharedFile(path: string): SessionFilePreview {
  const file = resolved(path)
  if (!file) return { kind: 'missing' }
  const { real, size } = file
  const ext = extname(real).toLowerCase()
  const canOpen = openable(real)
  const mime = IMAGE_TYPES[ext]
  try {
    if (mime) {
      if (size > MAX_IMAGE_BYTES) return { kind: 'other', size, reason: 'size', openable: canOpen }
      return { kind: 'image', mime, data: new Uint8Array(readFileSync(real)), size, openable: canOpen }
    }
    if (RENDERED_ELSEWHERE.has(ext)) return { kind: 'other', size, reason: 'kind', openable: canOpen }
    const bytes = head(real, MAX_TEXT_BYTES)
    // a NUL is binary: a preview of it would be noise
    if (bytes.includes(0)) return { kind: 'other', size, reason: 'kind', openable: canOpen }
    return {
      kind: 'text',
      text: bytes.toString('utf8'),
      truncated: size > bytes.length,
      markdown: MARKDOWN.has(ext),
      size,
      openable: canOpen
    }
  } catch {
    return { kind: 'missing' }
  }
}

/** The two things main does with a shared file for the person, injected so tests need no Electron */
export type FileShell = {
  readonly openPath: (path: string) => Promise<string>
  readonly showItemInFolder: (path: string) => void
}

/**
 * Open a shared file in its app, or show it in Finder. Resolves to what to tell the
 * person when it can't, else null. Only a document or an image opens — judged on the
 * file the path resolves to, so a link named `shot.png` to an app opens nothing.
 */
export async function openSharedFile(path: string, how: 'open' | 'reveal', shell: FileShell): Promise<string | null> {
  const file = resolved(path)
  if (!file) return 'The file is no longer on disk.'
  if (how === 'reveal') {
    shell.showItemInFolder(file.real)
    return null
  }
  if (!openable(file.real)) return 'Cockpit opens documents and images only — Show in Finder instead.'
  const failure = await shell.openPath(file.real)
  return failure || null
}
