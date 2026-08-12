import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertChatImages,
  MAX_CHAT_IMAGE_BYTES,
  MAX_CHAT_IMAGES,
  saveChatImage
} from '../src/main/chat-images'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cockpit-img-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('saveChatImage', () => {
  it('writes the bytes and returns a path inside the dir with the mime extension', () => {
    const data = new Uint8Array([137, 80, 78, 71])
    const path = saveChatImage(dir, data, 'image/png')
    expect(path.startsWith(dir + '/')).toBe(true)
    expect(path.endsWith('.png')).toBe(true)
    expect([...readFileSync(path)]).toEqual([...data])
  })

  it('maps jpeg/webp/gif to their extensions', () => {
    expect(saveChatImage(dir, new Uint8Array([1]), 'image/jpeg').endsWith('.jpg')).toBe(true)
    expect(saveChatImage(dir, new Uint8Array([1]), 'image/webp').endsWith('.webp')).toBe(true)
    expect(saveChatImage(dir, new Uint8Array([1]), 'image/gif').endsWith('.gif')).toBe(true)
  })

  it('rejects unknown mime types (never trusts them as extensions)', () => {
    expect(() => saveChatImage(dir, new Uint8Array([1]), 'image/svg+xml')).toThrow(/Unsupported/)
    expect(() => saveChatImage(dir, new Uint8Array([1]), '../../evil')).toThrow(/Unsupported/)
  })

  it('rejects empty and non-binary payloads', () => {
    expect(() => saveChatImage(dir, new Uint8Array(0), 'image/png')).toThrow(/Invalid/)
    expect(() => saveChatImage(dir, 'not bytes', 'image/png')).toThrow(/Invalid/)
  })

  it('rejects oversized payloads', () => {
    const big = new Uint8Array(MAX_CHAT_IMAGE_BYTES + 1)
    expect(() => saveChatImage(dir, big, 'image/png')).toThrow(/too large/)
  })
})

describe('assertChatImages', () => {
  it('passes undefined/empty through as undefined', () => {
    expect(assertChatImages(dir, undefined)).toBeUndefined()
    expect(assertChatImages(dir, null)).toBeUndefined()
    expect(assertChatImages(dir, [])).toBeUndefined()
  })

  it('accepts paths saveChatImage returned', () => {
    const p = saveChatImage(dir, new Uint8Array([1]), 'image/png')
    expect(assertChatImages(dir, [p])).toEqual([p])
  })

  it('rejects paths outside the image dir, including traversal', () => {
    writeFileSync(join(dir, 'ok.png'), 'x')
    expect(() => assertChatImages(dir, ['/etc/passwd'])).toThrow(/unknown image path/)
    expect(() => assertChatImages(dir, [join(dir, '..', 'escape.png')])).toThrow(
      /unknown image path/
    )
    // a sibling dir sharing the prefix must not slip past the startsWith check
    expect(() => assertChatImages(dir, [dir + '-evil/x.png'])).toThrow(/unknown image path/)
  })

  it('rejects non-arrays, non-strings, and too many images', () => {
    expect(() => assertChatImages(dir, 'x')).toThrow(/invalid images/)
    expect(() => assertChatImages(dir, [42])).toThrow(/invalid image path/)
    const many = Array.from({ length: MAX_CHAT_IMAGES + 1 }, (_, i) => join(dir, `${i}.png`))
    expect(() => assertChatImages(dir, many)).toThrow(/too many/)
  })
})
