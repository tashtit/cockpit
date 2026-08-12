import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'

/** A pasted clipboard buffer is unbounded — cap it before it hits the disk. */
export const MAX_CHAT_IMAGE_BYTES = 10 * 1024 * 1024
/** Most images a single turn may attach. */
export const MAX_CHAT_IMAGES = 8

/** The clipboard image formats browsers actually produce. */
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp'
}

/**
 * Persist one pasted image into `dir` under a name this module minted itself.
 * Returns the absolute file path — the only value the renderer may later hand
 * back in ChatRequest.images.
 */
export function saveChatImage(dir: string, data: unknown, mime: unknown): string {
  const ext = typeof mime === 'string' ? EXT_BY_MIME[mime] : undefined
  if (!ext) throw new Error(`Unsupported image type: ${String(mime)}`)
  if (!(data instanceof Uint8Array) || data.byteLength === 0) throw new Error('Invalid image data.')
  if (data.byteLength > MAX_CHAT_IMAGE_BYTES) {
    throw new Error(`Image too large — the limit is ${MAX_CHAT_IMAGE_BYTES / (1024 * 1024)}MB.`)
  }
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${randomUUID()}.${ext}`)
  writeFileSync(path, data)
  return path
}

/**
 * ChatRequest.images comes from the renderer — only accept paths that resolve
 * inside `dir`, i.e. files saveChatImage itself wrote. Returns the normalized
 * list, or undefined when there is nothing to attach.
 */
export function assertChatImages(dir: string, images: unknown): string[] | undefined {
  if (images === undefined || images === null) return undefined
  if (!Array.isArray(images)) throw new Error('invalid images')
  if (images.length > MAX_CHAT_IMAGES) throw new Error(`too many images (max ${MAX_CHAT_IMAGES})`)
  const root = resolve(dir) + sep
  const out = images.map((p) => {
    if (typeof p !== 'string') throw new Error('invalid image path')
    const r = resolve(p)
    if (!r.startsWith(root)) throw new Error(`unknown image path: ${r}`)
    return r
  })
  return out.length > 0 ? out : undefined
}
