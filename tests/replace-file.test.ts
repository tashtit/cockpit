import { afterAll, describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { replaceFile, writeFileAtomic, writeFileAtomicAsync } from '../src/main/replace-file'

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

/*
 * Two Cockpits on one userData — `npm run dev` beside the installed app, the way every
 * session previews its work — save the same files. With one fixed temp name each
 * renamed the other's temp file away and the second rename failed with ENOENT.
 */
describe('writeFileAtomic', () => {
  const HELPER = pathToFileURL(join(__dirname, '..', 'src', 'main', 'replace-file.ts')).href
  /** A writer in a process of its own: says `ready`, then writes `rounds` times once told to go. */
  const WRITER = `
    const [helper, file, who, rounds] = process.argv.slice(1)
    const { writeFileAtomic } = await import(helper)
    process.stdout.write('ready\\n')
    process.stdin.once('data', () => {
      const pad = who.repeat(64 * 1024)
      for (let round = 0; round < Number(rounds); round++) writeFileAtomic(file, JSON.stringify({ who, round, pad }))
      process.exit(0)
    })
  `

  const tempsIn = (dir: string): string[] => readdirSync(dir).filter((f) => f.endsWith('.tmp'))

  it('lets two processes write one file at the same time, and the file is always whole', async () => {
    const dir = join(root, 'two-instances')
    const file = join(dir, 'attention.json')
    const writers = ['a', 'b'].map((who) =>
      spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', WRITER, HELPER, file, who, '300'])
    )
    const exits = writers.map(
      (child) =>
        new Promise<{ code: number | null; stderr: string }>((done) => {
          let stderr = ''
          child.stderr.on('data', (d) => (stderr += d))
          child.on('close', (code) => done({ code, stderr }))
        })
    )
    // both loaded and waiting before either writes: the writes overlap from the first
    await Promise.all(writers.map((child) => new Promise((ready) => child.stdout.once('data', ready))))
    for (const child of writers) child.stdin.write('go\n')

    expect(await Promise.all(exits)).toEqual([
      { code: 0, stderr: '' },
      { code: 0, stderr: '' }
    ])
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    expect(saved.round).toBe(299)
    expect(saved.pad).toBe(saved.who.repeat(64 * 1024))
    expect(tempsIn(dir)).toEqual([])
  })

  it('lets overlapping async saves in one process both land', async () => {
    const dir = join(root, 'overlapping')
    const file = join(dir, 'index-cache.json')
    const saves = ['a', 'b', 'c'].map((who) =>
      writeFileAtomicAsync(file, JSON.stringify({ who, pad: who.repeat(1 << 20) }))
    )
    await Promise.all(saves)
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    expect(saved.pad).toBe(saved.who.repeat(1 << 20))
    expect(tempsIn(dir)).toEqual([])
  })

  it('takes its temp file with it when the write fails', () => {
    const dir = join(root, 'failing')
    const target = join(dir, 'state.json')
    mkdirSync(target, { recursive: true }) // a directory where the file should go: the rename fails
    expect(() => writeFileAtomic(target, '{}')).toThrow()
    expect(tempsIn(dir)).toEqual([])
  })

  it('ends with the mode it is given, whatever the file it replaces had', () => {
    const p = join(root, 'endpoint-keys.json')
    writeFileSync(p, '{}')
    chmodSync(p, 0o644)
    writeFileAtomic(p, '{"k":"ciphertext"}', { mode: 0o600 })
    expect(mode(p)).toBe(0o600)
    expect(readFileSync(p, 'utf8')).toBe('{"k":"ciphertext"}')
  })
})
