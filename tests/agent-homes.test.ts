import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { detectAgentHomes, editorLabel, isAppleFolder, reconcileDetected } from '../src/main/agent-homes'
import type { SourceDir } from '../src/shared/types'

/** A fake HOME with agents installed the way they lay themselves out on disk. */
let home: string

const dir = (...parts: string[]): string => {
  const p = join(home, ...parts)
  mkdirSync(p, { recursive: true })
  return p
}

const storage = (root: string, editor: string, ext: string): string =>
  join(home, root, editor, 'User', 'globalStorage', ext)

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), 'cockpit-agent-homes-'))
  dir('.claude')
  dir('.codex')
  dir('.gemini', 'tmp')
  dir('.cursor', 'projects')
  dir('.cline', 'data', 'tasks')
  dir('Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks')
  dir('Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'rooveterinaryinc.roo-cline', 'tasks')
  // Linux's XDG home, and an editor this code has never heard of
  dir('.config', 'Brand New Editor', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks')
  // installed but never used: no tasks yet, so nothing to index
  dir('Library', 'Application Support', 'Windsurf', 'User', 'globalStorage', 'saoudrizwan.claude-dev')
  // Cursor's own chats live in its editor storage's database
  writeFileSync(join(dir('Library', 'Application Support', 'Cursor', 'User', 'globalStorage'), 'state.vscdb'), '')
  writeFileSync(join(dir('.local', 'share', 'opencode'), 'opencode.db'), '')
  // Antigravity: a conversation database counts; the first releases' encrypted .pb does not
  writeFileSync(join(dir('.gemini', 'antigravity-ide', 'conversations'), 'c1.db'), '')
  writeFileSync(join(dir('.gemini', 'antigravity', 'conversations'), 'c0.pb'), '')
})

afterAll(() => rmSync(home, { recursive: true, force: true }))

describe('detectAgentHomes', () => {
  it('finds every agent that has written sessions, in any editor, with a label per home', () => {
    const found = detectAgentHomes(home)
    const byLabel = Object.fromEntries(found.map((s) => [s.label, s]))
    expect(Object.keys(byLabel).sort()).toEqual([
      'antigravity-ide',
      'claude-default',
      'cline-brand-new-editor',
      'cline-cli',
      'cline-vscode',
      'codex-default',
      'cursor-default',
      'cursor-ide',
      'gemini-default',
      'opencode-default',
      'roo-cursor'
    ])
    expect(byLabel['cursor-ide']).toMatchObject({ provider: 'cursor', path: storage(join('Library', 'Application Support'), 'Cursor', '').replace(/\/$/, '') })
    expect(byLabel['opencode-default']).toMatchObject({ provider: 'opencode', path: join(home, '.local', 'share', 'opencode') })
    expect(byLabel['antigravity-ide']).toMatchObject({ provider: 'antigravity', path: join(home, '.gemini', 'antigravity-ide') })
    expect(byLabel['gemini-default']).toEqual({ path: join(home, '.gemini'), provider: 'gemini', label: 'gemini-default' })
    expect(byLabel['cline-vscode']!.path).toBe(storage(join('Library', 'Application Support'), 'Code', 'saoudrizwan.claude-dev'))
    expect(byLabel['roo-cursor']).toMatchObject({ provider: 'roo' })
  })

  it('counts a home only once the agent has used it — ~/.gemini alone is not Gemini CLI', () => {
    const bare = mkdtempSync(join(tmpdir(), 'cockpit-agent-homes-bare-'))
    try {
      mkdirSync(join(bare, '.gemini', 'antigravity'), { recursive: true })
      mkdirSync(join(bare, '.cursor', 'extensions'), { recursive: true })
      expect(detectAgentHomes(bare)).toEqual([])
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  })

  it('counts Cursor from the conversations its ACP server keeps, with no transcript yet', () => {
    const acpOnly = mkdtempSync(join(tmpdir(), 'cockpit-agent-homes-acp-'))
    try {
      mkdirSync(join(acpOnly, '.cursor', 'acp-sessions', 'conv-1'), { recursive: true })
      expect(detectAgentHomes(acpOnly)).toEqual([{ path: join(acpOnly, '.cursor'), provider: 'cursor', label: 'cursor-default' }])
    } finally {
      rmSync(acpOnly, { recursive: true, force: true })
    }
  })

  // macOS guards some of Apple's folders (AddressBook is Contacts, Music the media
  // library): a look inside can prompt, so the scan never takes one
  it("never looks inside Apple's own folders in Application Support", () => {
    const mac = mkdtempSync(join(tmpdir(), 'cockpit-agent-homes-apple-'))
    try {
      for (const folder of ['AddressBook', 'Music', 'com.apple.TCC', 'Code']) {
        mkdirSync(join(mac, 'Library', 'Application Support', folder, 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks'), {
          recursive: true
        })
      }
      expect(detectAgentHomes(mac).map((s) => s.label)).toEqual(['cline-vscode'])
    } finally {
      rmSync(mac, { recursive: true, force: true })
    }
  })

  it('tells Apple’s folders from an editor’s by name alone', () => {
    for (const name of ['AddressBook', 'Music', 'CallHistoryDB', 'com.apple.sharedfilelist', 'com.Apple.Foo']) {
      expect(isAppleFolder(name)).toBe(true)
    }
    for (const name of ['Code', 'Code - Insiders', 'Cursor', 'Antigravity IDE', 'music-app', 'com.applesauce.editor']) {
      expect(isAppleFolder(name)).toBe(false)
    }
  })

  it('names editors by their data folder', () => {
    expect(editorLabel('Code')).toBe('vscode')
    expect(editorLabel('Code - Insiders')).toBe('vscode-insiders')
    expect(editorLabel('Cursor')).toBe('cursor')
    expect(editorLabel('Antigravity IDE')).toBe('antigravity-ide')
  })
})

describe('reconcileDetected', () => {
  const src = (provider: SourceDir['provider'], path: string): SourceDir => ({ path, provider, label: `${provider}-x` })
  const claude = src('claude', '/h/.claude')
  const codex = src('codex', '/h/.codex')
  const gemini = src('gemini', '/h/.gemini')
  const cursor = src('cursor', '/h/.cursor')

  it('on a config from before removals were recorded, adds only the agents this build newly reads', () => {
    // the person removed ~/.codex long ago; its home is still on disk
    const next = reconcileDetected([claude], undefined, [claude, codex, gemini])
    expect(next.sources).toEqual([claude, gemini])
    expect(next.dismissed).toEqual([resolve(codex.path)])
    expect(next.changed).toBe(true)
  })

  it('adds a home that appeared since the last launch', () => {
    const next = reconcileDetected([claude, gemini], [], [claude, gemini, cursor])
    expect(next.sources).toEqual([claude, gemini, cursor])
    expect(next.changed).toBe(true)
  })

  it('never adds back a home the person removed', () => {
    const next = reconcileDetected([claude], [resolve(gemini.path)], [claude, gemini])
    expect(next.sources).toEqual([claude])
    expect(next.changed).toBe(false)
  })

  it('adds back a home an older build dropped — only a removal is final', () => {
    // an older build that cannot read Gemini rewrote the config without it
    const next = reconcileDetected([claude], [], [claude, gemini])
    expect(next.sources).toEqual([claude, gemini])
  })

  it('does not add a home twice under a different spelling of its path', () => {
    const next = reconcileDetected([src('gemini', '/h/./.gemini/')], [], [gemini])
    expect(next.sources).toHaveLength(1)
    expect(next.changed).toBe(false)
  })
})
