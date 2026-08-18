import { describe, expect, it } from 'vitest'
import {
  branchFromHead,
  centeredIn,
  parseGitdirPointer,
  readDevWindowPrefs
} from '../src/main/dev-window'

describe('readDevWindowPrefs', () => {
  it('defaults to a background window on the OS-chosen display', () => {
    expect(readDevWindowPrefs({})).toEqual({ background: true, displayIndex: null })
  })

  it('fronts the window only when COCKPIT_DEV_BACKGROUND opts out', () => {
    expect(readDevWindowPrefs({ COCKPIT_DEV_BACKGROUND: '1' }).background).toBe(true)
    expect(readDevWindowPrefs({ COCKPIT_DEV_BACKGROUND: '' }).background).toBe(true)
    expect(readDevWindowPrefs({ COCKPIT_DEV_BACKGROUND: '0' }).background).toBe(false)
    expect(readDevWindowPrefs({ COCKPIT_DEV_BACKGROUND: 'false' }).background).toBe(false)
  })

  it('parses COCKPIT_DEV_DISPLAY as a 0-based index', () => {
    expect(readDevWindowPrefs({ COCKPIT_DEV_DISPLAY: '0' }).displayIndex).toBe(0)
    expect(readDevWindowPrefs({ COCKPIT_DEV_DISPLAY: '2' }).displayIndex).toBe(2)
  })

  it('ignores a non-numeric or empty COCKPIT_DEV_DISPLAY', () => {
    expect(readDevWindowPrefs({ COCKPIT_DEV_DISPLAY: 'left' }).displayIndex).toBeNull()
    expect(readDevWindowPrefs({ COCKPIT_DEV_DISPLAY: '-1' }).displayIndex).toBeNull()
    expect(readDevWindowPrefs({ COCKPIT_DEV_DISPLAY: '' }).displayIndex).toBeNull()
  })
})

describe('parseGitdirPointer', () => {
  it('reads the gitdir path from a linked worktree .git file', () => {
    expect(parseGitdirPointer('gitdir: /repo/.git/worktrees/feature-x\n')).toBe(
      '/repo/.git/worktrees/feature-x'
    )
  })

  it('keeps relative pointers as written (caller resolves them)', () => {
    expect(parseGitdirPointer('gitdir: ../../.git/worktrees/wt')).toBe('../../.git/worktrees/wt')
  })

  it('rejects content that is not a gitdir pointer', () => {
    expect(parseGitdirPointer('ref: refs/heads/main')).toBeNull()
    expect(parseGitdirPointer('')).toBeNull()
  })
})

describe('branchFromHead', () => {
  it('extracts the branch from a symbolic HEAD', () => {
    expect(branchFromHead('ref: refs/heads/titan/fix-thing\n')).toBe('titan/fix-thing')
  })

  it('abbreviates a detached HEAD to a short hash', () => {
    expect(branchFromHead('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n')).toBe('a1b2c3d')
  })

  it('rejects refs outside refs/heads and junk content', () => {
    expect(branchFromHead('ref: refs/tags/v1.0.0')).toBeNull()
    expect(branchFromHead('not a head')).toBeNull()
  })
})

describe('centeredIn', () => {
  it('centers the window in the display work area', () => {
    const bounds = centeredIn({ x: 0, y: 25, width: 1920, height: 1055 }, 1100, 760)
    expect(bounds).toEqual({ x: 410, y: 173, width: 1100, height: 760 })
  })

  it('offsets by the display origin (secondary displays have non-zero origins)', () => {
    const bounds = centeredIn({ x: 1920, y: 0, width: 1920, height: 1080 }, 1100, 760)
    expect(bounds.x).toBe(1920 + 410)
    expect(bounds.y).toBe(160)
  })

  it('clamps the window to the work area when the display is smaller', () => {
    const bounds = centeredIn({ x: 0, y: 0, width: 1024, height: 640 }, 1100, 760)
    expect(bounds).toEqual({ x: 0, y: 0, width: 1024, height: 640 })
  })
})
