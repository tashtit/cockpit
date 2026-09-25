import { afterAll, describe, it, expect, beforeAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { makeFifo } from './fifo'
import {
  capText,
  isRegularFile,
  parseJsonc,
  readHead,
  readJson,
  readSmallFile,
  readTail,
  patchPreview,
  readJsonlTail,
  shellPreview,
  toolPreview,
  truncate,
  TRANSCRIPT_TAIL_BYTES
} from '../src/main/parsers/util'
import { isValidNativeId } from '../src/main/chat'

const root = mkdtempSync(join(tmpdir(), 'cockpit-util-fixtures-'))

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

describe('reading only regular files', () => {
  const stops: Array<() => void> = []
  afterAll(() => stops.forEach((stop) => stop()))

  // a FIFO reports size 0, which used to route it to a whole-file read that never returned
  it('skips a FIFO at once, whichever reader meets it', () => {
    const pipe = join(root, 'events.jsonl')
    stops.push(makeFifo(pipe))
    const started = Date.now()
    expect(readHead(pipe, 1000)).toEqual({ text: '', truncated: false, size: 0 })
    expect(readTail(pipe, 1000)).toEqual({ text: '', truncated: false, size: 0 })
    expect(readJsonlTail(pipe)).toEqual({ lines: [], truncated: false, bytes: 0 })
    expect(readSmallFile(pipe, 1000)).toBeNull()
    expect(readJson(pipe, 1000)).toBeNull()
    expect(isRegularFile(pipe)).toBe(false)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('reads a small file whole, and refuses one past its bound rather than cutting it', () => {
    const f = join(root, 'doc.json')
    writeFileSync(f, '{"a":1}')
    expect(readSmallFile(f, 100)).toBe('{"a":1}')
    expect(readJson(f, 100)).toEqual({ a: 1 })
    expect(readSmallFile(f, 3)).toBeNull()
    expect(readJson(f, 3)).toBeNull()
    expect(readSmallFile(join(root, 'missing.json'), 100)).toBeNull()
    writeFileSync(join(root, 'empty'), '')
    expect(readSmallFile(join(root, 'empty'), 100)).toBe('')
  })

  it('judges a link by what it is, not by what it points at', () => {
    const target = join(root, 'target.jsonl')
    writeFileSync(target, '{}\n')
    const link = join(root, 'link.jsonl')
    symlinkSync(target, link)
    expect(isRegularFile(target)).toBe(true)
    expect(isRegularFile(link)).toBe(false)
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

describe('toolPreview', () => {
  it('headlines Claude tools by their command or path', () => {
    expect(toolPreview('Bash', { command: 'npm test' })).toBe('npm test')
    expect(toolPreview('Edit', { file_path: '/r/src/a.ts', old_string: 'x' })).toBe('/r/src/a.ts')
  })

  it('headlines Copilot CLI tools, which are lowercase and take `path`', () => {
    expect(toolPreview('bash', { command: 'npm run lint' })).toBe('npm run lint')
    expect(toolPreview('edit', { path: '/r/src/usage.tsx', old_str: 'a', new_str: 'b' })).toBe(
      '/r/src/usage.tsx'
    )
    expect(toolPreview('create', { path: '/r/src/new.css', file_text: '' })).toBe('/r/src/new.css')
  })

  it('has no headline for unknown tools, so the raw input shows instead', () => {
    expect(toolPreview('mcp__linear__search', { q: 'bug' })).toBeNull()
  })
})

describe('Codex shell and patch previews', () => {
  it('unwraps the shell Codex puts around every command, array or string', () => {
    expect(shellPreview(['bash', '-lc', 'rg -n premium_request src'])).toBe('rg -n premium_request src')
    expect(shellPreview(['/bin/zsh', '-c', 'npm test'])).toBe('npm test')
    expect(shellPreview('bash -lc "npm run lint"')).toBe('npm run lint')
    // not wrapped: shown as it ran
    expect(shellPreview(['git', 'status'])).toBe('git status')
  })

  it('names an apply_patch by the files it touches instead of printing the heredoc', () => {
    const script = "apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: src/main/usage.ts\n@@\n-a\n+b\n*** Add File: tests/usage.test.ts\n+x\n*** End Patch\nEOF"
    expect(shellPreview(['bash', '-lc', script])).toBe('apply_patch src/main/usage.ts, tests/usage.test.ts')
    expect(patchPreview('no patch here')).toBeNull()
  })

  it('reads the tool names Codex logs use', () => {
    expect(toolPreview('shell', { command: ['bash', '-lc', 'cargo test'] })).toBe('cargo test')
    expect(toolPreview('exec_command', { cmd: 'ls -la' })).toBe('ls -la')
    expect(toolPreview('apply_patch', { input: '*** Begin Patch\n*** Delete File: old.ts\n*** End Patch' })).toBe(
      'apply_patch old.ts'
    )
  })

  it('has no headline for a command it cannot read', () => {
    expect(shellPreview(undefined)).toBeNull()
    expect(shellPreview(['bash', '-lc', '   '])).toBeNull()
  })
})

afterAll(() => rmSync(root, { recursive: true, force: true }))
