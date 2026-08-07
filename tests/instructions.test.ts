import { describe, it, expect } from 'vitest'
import {
  END,
  START,
  extractSharedBlock,
  fileStatus,
  instructionTargets,
  upsertSharedBlock
} from '../src/main/instructions-core'

const BASE = 'Always use worktrees.\nNever commit unless asked.'

describe('upsertSharedBlock', () => {
  it('creates a block in an empty file', () => {
    const out = upsertSharedBlock('', BASE)
    expect(out).toBe(`${START}\n${BASE}\n${END}\n`)
  })

  it('appends after existing content, preserving it byte-for-byte', () => {
    const own = '# Session Instructions\n\n## Hard boundaries\n\n* `ciqol`\n'
    const out = upsertSharedBlock(own, BASE)
    expect(out.startsWith(own.trimEnd())).toBe(true)
    expect(out).toContain(`\n\n${START}\n`)
    expect(extractSharedBlock(out)).toBe(BASE)
  })

  it('replaces an existing block in place, keeping text before and after', () => {
    const raw = `before\n\n${START}\nold stuff\n${END}\n\nafter\n`
    const out = upsertSharedBlock(raw, BASE)
    expect(out).toBe(`before\n\n${START}\n${BASE}\n${END}\n\nafter\n`)
  })

  it('is idempotent', () => {
    const once = upsertSharedBlock('# mine\n', BASE)
    expect(upsertSharedBlock(once, BASE)).toBe(once)
  })

  it('trims the baseline so re-applying the same text never drifts', () => {
    const out = upsertSharedBlock('', `\n${BASE}\n\n`)
    expect(extractSharedBlock(out)).toBe(BASE)
  })
})

describe('extractSharedBlock', () => {
  it('returns null when there is no block or a half block', () => {
    expect(extractSharedBlock('just text')).toBeNull()
    expect(extractSharedBlock(`${START}\nunclosed`)).toBeNull()
  })
})

describe('fileStatus', () => {
  const applied = upsertSharedBlock('# codex own rules\n', BASE)
  it('missing / unmanaged / synced / drifted', () => {
    expect(fileStatus(null, BASE)).toBe('missing')
    expect(fileStatus('# only own content\n', BASE)).toBe('unmanaged')
    expect(fileStatus(applied, BASE)).toBe('synced')
    expect(fileStatus(applied, BASE + '\nNew rule.')).toBe('drifted')
    expect(fileStatus(applied.replace('worktrees', 'branches'), BASE)).toBe('drifted')
  })
})

describe('instructionTargets', () => {
  it('global scope: one native file per agent', () => {
    const t = instructionTargets(null, '/Users/x')
    expect(t.map((x) => x.path)).toEqual([
      '/Users/x/.claude/CLAUDE.md',
      '/Users/x/.codex/AGENTS.md',
      '/Users/x/.copilot/copilot-instructions.md'
    ])
    expect(t.map((x) => x.agents)).toEqual([['claude'], ['codex'], ['copilot']])
  })

  it('repo scope: AGENTS.md covers codex and copilot', () => {
    const t = instructionTargets('/repo')
    expect(t).toEqual([
      { agents: ['claude'], path: '/repo/CLAUDE.md' },
      { agents: ['codex', 'copilot'], path: '/repo/AGENTS.md' }
    ])
  })
})
