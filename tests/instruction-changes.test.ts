import { describe, it, expect } from 'vitest'
import { fileChange } from '../src/shared/instruction-changes'
import type { InstructionFile } from '../src/shared/types'

const BASE = '# Rules\n\nUse worktrees.\nNever push.'

const file = (over: Partial<InstructionFile>): InstructionFile => ({
  agents: ['claude'],
  path: '/h/.claude/CLAUDE.md',
  exists: true,
  content: '',
  block: BASE,
  own: { above: 0, below: 0 },
  status: 'synced',
  ...over
})

describe('fileChange', () => {
  it('a file holding the incoming text has nothing to write', () => {
    const c = fileChange(file({}), `\n${BASE}\n`)
    expect(c.status).toBe('synced')
    expect(c.added + c.removed).toBe(0)
  })

  it('a drifted block is rewritten, line by line', () => {
    const c = fileChange(file({ block: BASE.replace('worktrees', 'branches') }), BASE)
    expect(c.status).toBe('drifted')
    expect(c).toMatchObject({ added: 1, removed: 1 })
    expect(c.lines.filter((l) => l.op !== 'same').map((l) => `${l.op} ${l.text}`)).toEqual([
      'del Use branches.',
      'add Use worktrees.'
    ])
  })

  it('a file with no block gets one appended: every line is new', () => {
    const c = fileChange(file({ block: null, own: { above: 40, below: 0 } }), BASE)
    expect(c.status).toBe('unmanaged')
    expect(c).toMatchObject({ added: 4, removed: 0 })
  })

  it('a missing file is created', () => {
    const c = fileChange(file({ exists: false, block: null, content: '' }), BASE)
    expect(c.status).toBe('missing')
    expect(c.lines.every((l) => l.op === 'add')).toBe(true)
  })

  // the status the indexer stored is against the *saved* baseline; the review
  // compares against whatever is about to be written, which may be an edited draft
  it('judges against the incoming text, not the stored status', () => {
    const c = fileChange(file({ status: 'drifted' }), BASE)
    expect(c.status).toBe('synced')
    const d = fileChange(file({ status: 'synced' }), `${BASE}\nOne more rule.`)
    expect(d.status).toBe('drifted')
    expect(d).toMatchObject({ added: 1, removed: 0 })
  })
})
