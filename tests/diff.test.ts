import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asDiffScope, getWorkspaceDiff } from '../src/main/diff'

/**
 * The review against a real repository: a bare "origin", a clone with a base
 * branch, and a feature worktree with committed, staged, unstaged and untracked
 * work. Nothing mocked — the scopes are asserted against what git itself says.
 */

const root = join(realpathSync(tmpdir()), 'cockpit-diff-fixtures')
const origin = join(root, 'origin.git')
const clone = join(root, 'clone')
const feature = join(root, 'feature')
const bare = join(root, 'no-git')

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.email=t@t.test', '-c', 'user.name=t', ...args], {
    cwd,
    encoding: 'utf8'
  })
}

beforeAll(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  git(root, ['init', '-q', '--bare', '--initial-branch=main', origin])
  git(root, ['clone', '-q', origin, clone])
  writeFileSync(join(clone, 'a.ts'), 'one\ntwo\nthree\n')
  writeFileSync(join(clone, 'gone.txt'), 'bye\n')
  git(clone, ['add', '.'])
  git(clone, ['commit', '-q', '-m', 'base'])
  git(clone, ['push', '-q', 'origin', 'main'])
  // a linked worktree on a feature branch, the way Cockpit cuts them
  git(clone, ['worktree', 'add', '-q', '-b', 'cockpit/feature', feature])
  // one commit on the branch…
  writeFileSync(join(feature, 'a.ts'), 'one\ntwo changed\nthree\n')
  git(feature, ['commit', '-q', '-am', 'change two'])
  // …then the base moves on (behind by one)
  writeFileSync(join(clone, 'base-only.txt'), 'x\n')
  git(clone, ['add', '.'])
  git(clone, ['commit', '-q', '-m', 'base moves'])
  git(clone, ['push', '-q', 'origin', 'main'])
  git(feature, ['fetch', '-q', 'origin'])
  // staged: a deletion; unstaged: an edit; untracked: a new file and a binary
  git(feature, ['rm', '-q', 'gone.txt'])
  writeFileSync(join(feature, 'a.ts'), 'one\ntwo changed\nthree\nfour\n')
  writeFileSync(join(feature, 'notes.md'), '# notes\n')
  writeFileSync(join(feature, 'blob.bin'), Buffer.from([0, 1, 2]))
  mkdirSync(bare, { recursive: true })
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('getWorkspaceDiff', () => {
  it('branch scope: everything since the base, with ahead/behind and untracked additions', async () => {
    const d = await getWorkspaceDiff(feature, 'branch')
    expect(d.branch).toBe('cockpit/feature')
    expect(d.base).toBe('origin/main')
    expect(d.ahead).toBe(1)
    expect(d.behind).toBe(1)
    expect(d.dirty).toBe(true)
    expect(d.files.map((f) => [f.path, f.status, f.untracked, f.binary])).toEqual([
      ['a.ts', 'modified', false, false],
      ['gone.txt', 'deleted', false, false],
      ['blob.bin', 'added', true, true],
      ['notes.md', 'added', true, false]
    ])
    const a = d.files[0]
    expect(a.added).toBe(2)
    expect(a.removed).toBe(1)
    expect(a.hunks[0].lines.map((l) => [l.op, l.text])).toEqual([
      ['same', 'one'],
      ['del', 'two'],
      ['add', 'two changed'],
      ['same', 'three'],
      ['add', 'four']
    ])
    expect(d.added).toBe(3)
    expect(d.removed).toBe(2)
    expect(d.droppedFiles).toBe(0)
  })

  it('staged scope: the index only, no untracked files', async () => {
    const d = await getWorkspaceDiff(feature, 'staged')
    expect(d.files.map((f) => [f.path, f.status])).toEqual([['gone.txt', 'deleted']])
    expect(d.base).toBeNull()
    expect(d.ahead).toBe(0)
  })

  it('unstaged scope: working-tree edits plus untracked files', async () => {
    const d = await getWorkspaceDiff(feature, 'unstaged')
    expect(d.files.map((f) => [f.path, f.status, f.untracked])).toEqual([
      ['a.ts', 'modified', false],
      ['blob.bin', 'added', true],
      ['notes.md', 'added', true]
    ])
    expect(d.files[0].hunks[0].lines.map((l) => l.op)).toEqual(['same', 'same', 'same', 'add'])
  })

  it('falls back to HEAD when no base branch exists', async () => {
    const lone = join(root, 'lone')
    git(root, ['init', '-q', '--initial-branch=trunk', lone])
    writeFileSync(join(lone, 'f.txt'), 'a\n')
    git(lone, ['add', '.'])
    git(lone, ['commit', '-q', '-m', 'first'])
    writeFileSync(join(lone, 'f.txt'), 'b\n')
    const d = await getWorkspaceDiff(lone, 'branch')
    expect(d.base).toBeNull()
    expect(d.branch).toBe('trunk')
    expect(d.files.map((f) => f.path)).toEqual(['f.txt'])
  })

  it('refuses a directory that is not a repository', async () => {
    await expect(getWorkspaceDiff(bare, 'branch')).rejects.toThrow(/not a git repository/i)
  })

  it('only accepts the three scopes from the renderer', () => {
    expect(asDiffScope('staged')).toBe('staged')
    expect(() => asDiffScope('all')).toThrow(/scope/)
    expect(() => asDiffScope(undefined)).toThrow(/scope/)
  })
})
