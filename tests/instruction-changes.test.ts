import { describe, it, expect } from 'vitest'
import { fileChange } from '../src/shared/instruction-changes'
import { END, START } from '../src/shared/instruction-markers'
import type { InstructionFile } from '../src/shared/types'

const BASE = '# Rules\n\nUse worktrees.\nNever push.'

const file = (over: Partial<InstructionFile>): InstructionFile => ({
  agents: ['claude'],
  path: '/h/.claude/CLAUDE.md',
  exists: true,
  content: '',
  block: BASE,
  own: { above: 0, below: 0 },
  duplicates: 0,
  readBy: [],
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

  // a file holding the block twice (one copy per marker spelling) is written even
  // when the first copy already says the text: the apply folds them into one
  it('a second copy of the block is a write with no lines to show', () => {
    const c = fileChange(file({ duplicates: 1 }), BASE)
    expect(c.status).toBe('drifted')
    expect(c.added + c.removed).toBe(0)
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

  // the writer drops the markers of a pasted whole file; the review compares what
  // would actually be written, so it must not show them as two new lines per file
  it('a pasted block with its markers reviews as nothing to write', () => {
    const c = fileChange(file({}), `${START}\n${BASE}\n${END}\n`)
    expect(c.status).toBe('synced')
    expect(c.added + c.removed).toBe(0)
    const d = fileChange(file({ block: null }), `${START}\n${BASE}\n${END}\n`)
    expect(d.status).toBe('unmanaged')
    expect(d).toMatchObject({ added: 4, removed: 0 })
  })
})
