import { afterAll, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { replaceFile } from '../src/main/replace-file'

/*
 * What passes through replaceFile is mostly an agent's own config — `~/.claude.json`,
 * `~/.codex/config.toml` — and those carry MCP servers' env values, tokens included.
 * A file it creates is the user's alone; a file it replaces keeps whatever mode the
 * user gave it.
 */

const root = mkdtempSync(join(tmpdir(), 'cockpit-replace-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const mode = (p: string): number => statSync(p).mode & 0o777

describe('replaceFile', () => {
  it('creates a new file owner-only', () => {
    const p = join(root, 'config.toml')
    replaceFile(p, '[mcp_servers.x]\nenv = { TOKEN = "secret" }\n')
    expect(mode(p)).toBe(0o600)
  })

  it('creates a file meant to be shared with the mode it asks for', () => {
    const p = join(root, 'CLAUDE.md')
    replaceFile(p, '# repo\n', { newFileMode: 0o644 })
    expect(mode(p)).toBe(0o644)
  })

  it('keeps the mode of a file it replaces', () => {
    const p = join(root, 'kept.json')
    writeFileSync(p, '{}')
    chmodSync(p, 0o640)
    replaceFile(p, '{"a":1}')
    expect(mode(p)).toBe(0o640)
    expect(readFileSync(p, 'utf8')).toBe('{"a":1}')
  })

  it('writes through a link, which stays a link', () => {
    const real = join(root, 'dotfiles-claude.json')
    writeFileSync(real, '{}')
    const link = join(root, 'linked.json')
    symlinkSync(real, link)
    replaceFile(link, '{"b":2}')
    expect(readFileSync(real, 'utf8')).toBe('{"b":2}')
  })
})
