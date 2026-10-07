import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spelledOnDisk } from '../src/main/paths'

// a temp dir's own path runs through a link on macOS (/var → /private/var), which is
// part of what spelledOnDisk follows — so the root is resolved once, the native way
let root: string
/** The volume under the temp dir ignores case: `Data` is reachable as `DATA` too */
let foldsCase: boolean

beforeAll(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'cockpit-paths-')))
  mkdirSync(join(root, 'Data', 'worktrees', 'rocket'), { recursive: true })
  symlinkSync(join(root, 'Data'), join(root, 'link'))
  foldsCase = existsSync(join(root, 'DATA'))
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('spelledOnDisk', () => {
  it('follows a link, and keeps a tail that is gone under the nearest folder that is not', () => {
    expect(spelledOnDisk(join(root, 'link', 'worktrees', 'rocket'))).toBe(join(root, 'Data', 'worktrees', 'rocket'))
    // a worktree removed after its PR merged is still placed by the folder it was in
    expect(spelledOnDisk(join(root, 'link', 'worktrees', 'rocket', 'merged-task'))).toBe(
      join(root, 'Data', 'worktrees', 'rocket', 'merged-task')
    )
  })

  it('spells each part the way it was made where the volume ignores case, and leaves it where it does not', () => {
    const asWritten = join(root, 'data', 'Worktrees', 'rocket', 'task')
    expect(spelledOnDisk(asWritten)).toBe(
      // on a case-sensitive volume `data` is another folder, which doesn't exist
      foldsCase ? join(root, 'Data', 'worktrees', 'rocket', 'task') : asWritten
    )
  })

  it('keeps a path as written when none of its folders exist', () => {
    expect(spelledOnDisk('/nowhere/at/all')).toBe('/nowhere/at/all')
  })
})
