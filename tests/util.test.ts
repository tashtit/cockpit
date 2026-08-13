import { describe, it, expect, beforeAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  capText,
  parseJsonc,
  readHead,
  readJsonlTail,
  truncate,
  TRANSCRIPT_TAIL_BYTES
} from '../src/main/parsers/util'
import { isValidNativeId } from '../src/main/chat'

const root = join(tmpdir(), 'cockpit-util-fixtures')

beforeAll(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
})

describe('readJsonlTail', () => {
  it('returns whole small files untruncated', () => {
    const f = join(root, 'small.jsonl')
    writeFileSync(f, '{"a":1}\n{"a":2}\n')
    const { lines, truncated } = readJsonlTail(f)
    expect(truncated).toBe(false)
    expect(lines).toEqual([{ a: 1 }, { a: 2 }])
  })

  it('caps huge files to the tail and drops the partial first line', () => {
    const f = join(root, 'big.jsonl')
    const row = JSON.stringify({ pad: 'x'.repeat(1000), n: 0 }) + '\n'
    const rows = Math.ceil((TRANSCRIPT_TAIL_BYTES * 1.5) / row.length)
    writeFileSync(f, Array.from({ length: rows }, (_, i) => row.replace('"n":0', `"n":${i}`)).join(''))
    const { lines, truncated } = readJsonlTail(f)
    expect(truncated).toBe(true)
    // last line preserved exactly; nothing malformed slipped in
    expect(lines[lines.length - 1].n).toBe(rows - 1)
    expect(lines.every((l) => typeof l.n === 'number')).toBe(true)
    expect(lines.length).toBeLessThan(rows)
  })
})

describe('readHead', () => {
  it('reports truncation and size for large files', () => {
    const f = join(root, 'head.jsonl')
    writeFileSync(f, 'a'.repeat(10_000))
    const r = readHead(f, 1000)
    expect(r.truncated).toBe(true)
    expect(r.text.length).toBe(1000)
    expect(r.size).toBe(10_000)
  })
})

describe('capText', () => {
  it('passes short text through and caps long text with a marker', () => {
    expect(capText('hi')).toBe('hi')
    const capped = capText('x'.repeat(30_000))
    expect(capped.length).toBeLessThan(21_000)
    expect(capped).toContain('more chars')
  })
  it('never cuts an emoji in half', () => {
    // '🎉' is two UTF-16 units — a naive slice at max would leave a lone surrogate
    const capped = capText('x'.repeat(19_999) + '🎉' + 'y'.repeat(100), 20_000)
    expect(capped).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(capped.startsWith('x'.repeat(19_999))).toBe(true)
  })
})

describe('parseJsonc', () => {
  // agent configs are hand-editable and copilot's ships with a // banner — a strict
  // parse here reads as "no config", which silently empties an inventory
  it('parses JSON with leading // comment lines', () => {
    expect(parseJsonc('// banner\n// more\n{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonc('  // indented\n{"a":1}')).toEqual({ a: 1 })
  })
  it('returns null for genuinely broken input', () => {
    expect(parseJsonc('{ nope')).toBeNull()
  })
  it('leaves // inside string values alone', () => {
    expect(parseJsonc('{"url":"https://example.com"}')).toEqual({ url: 'https://example.com' })
  })
})

describe('truncate', () => {
  it('collapses whitespace and adds an ellipsis past the limit', () => {
    expect(truncate('a   b\nc')).toBe('a b c')
    expect(truncate('x'.repeat(100))).toBe('x'.repeat(79) + '…')
  })
  it('never cuts an emoji in half', () => {
    const out = truncate('x'.repeat(78) + '🎉tail', 80)
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(out.endsWith('…')).toBe(true)
  })
})

describe('isValidNativeId (argv injection guard)', () => {
  it('accepts uuid-ish ids', () => {
    expect(isValidNativeId('0195c7a2-1b2c-7def-8a90-1234abcd5678')).toBe(true)
    expect(isValidNativeId('rollout-2026-08-01-bbbb')).toBe(true)
  })
  it('rejects flag-shaped and hostile values', () => {
    expect(isValidNativeId('--dangerously-bypass-approvals-and-sandbox')).toBe(false)
    expect(isValidNativeId('-x')).toBe(false)
    expect(isValidNativeId('a b')).toBe(false)
    expect(isValidNativeId('a;rm -rf /')).toBe(false)
    expect(isValidNativeId('')).toBe(false)
    expect(isValidNativeId('x'.repeat(200))).toBe(false)
  })
})
