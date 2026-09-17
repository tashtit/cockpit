import { afterAll, describe, it, expect, beforeAll } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  branchForCwd,
  branchFromHead,
  clearRepoCache,
  fullNameFromUrl,
  parseGitdirPointer,
  resolveRepo
} from '../src/main/repos'

const root = mkdtempSync(join(tmpdir(), 'cockpit-repo-fixtures-'))
const mainRepo = join(root, 'myrepo')
const worktree = join(root, 'worktrees', 'fix-login')

beforeAll(() => {
  rmSync(root, { recursive: true, force: true })

  // main repo: .git directory with an origin remote
  mkdirSync(join(mainRepo, '.git'), { recursive: true })
  writeFileSync(
    join(mainRepo, '.git', 'config'),
    '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@github.com:acme/myrepo.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n'
  )
  writeFileSync(join(mainRepo, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  mkdirSync(join(mainRepo, '.git', 'worktrees', 'fix-login'), { recursive: true })
  // the worktree's own HEAD — a different branch from the main checkout's, which is
  // the whole reason a session's branch can't be read off the repo root
  writeFileSync(
    join(mainRepo, '.git', 'worktrees', 'fix-login', 'HEAD'),
    'ref: refs/heads/cockpit/fix-login\n'
  )

  // linked worktree: .git FILE pointing at main repo's worktree gitdir
  mkdirSync(worktree, { recursive: true })
  writeFileSync(join(worktree, '.git'), `gitdir: ${join(mainRepo, '.git', 'worktrees', 'fix-login')}\n`)

  // a checkout mid-rebase: detached HEAD, no branch to name
  mkdirSync(join(root, 'detached', '.git'), { recursive: true })
  writeFileSync(join(root, 'detached', '.git', 'config'), '[core]\n')
  writeFileSync(
    join(root, 'detached', '.git', 'HEAD'),
    'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678\n'
  )

  // plain dir, no git anywhere above (root itself has no .git)
  mkdirSync(join(root, 'plain'), { recursive: true })

  clearRepoCache()
})

describe('resolveRepo', () => {
  it('resolves a main checkout with GitHub remote', () => {
    const res = resolveRepo(mainRepo)
    expect(res?.repo.key).toBe(mainRepo)
    expect(res?.repo.name).toBe('myrepo')
    expect(res?.repo.fullName).toBe('acme/myrepo')
    expect(res?.isWorktree).toBe(false)
  })

  it('resolves a subdirectory to the same repo', () => {
    mkdirSync(join(mainRepo, 'src', 'deep'), { recursive: true })
    const res = resolveRepo(join(mainRepo, 'src', 'deep'))
    expect(res?.repo.key).toBe(mainRepo)
  })

  it('groups a linked worktree under the main repo', () => {
    const res = resolveRepo(worktree)
    expect(res?.repo.key).toBe(mainRepo)
    expect(res?.repo.fullName).toBe('acme/myrepo')
    expect(res?.isWorktree).toBe(true)
  })

  it('tolerates deleted cwds by walking existing ancestors', () => {
    const res = resolveRepo(join(mainRepo, 'gone', 'even-more-gone'))
    expect(res?.repo.key).toBe(mainRepo)
  })

  it('returns null outside any repo and for null cwd', () => {
    expect(resolveRepo(join(root, 'plain'))).toBeNull()
    expect(resolveRepo(null)).toBeNull()
  })
})

describe('fullNameFromUrl', () => {
  it('parses ssh, https and ssh:// GitHub remotes', () => {
    expect(fullNameFromUrl('git@github.com:acme/myrepo.git')).toBe('acme/myrepo')
    expect(fullNameFromUrl('https://github.com/acme/myrepo')).toBe('acme/myrepo')
    expect(fullNameFromUrl('ssh://git@github.com/acme/myrepo.git')).toBe('acme/myrepo')
    expect(fullNameFromUrl('https://github.com/acme/myrepo.git/')).toBe('acme/myrepo')
  })

  // a gh:owner/repo identity asserts "the same GitHub repo" — other hosts must not
  // claim it, or an unrelated gitlab team/proj merges into the GitHub group
  it('claims no GitHub identity for other hosts or local paths', () => {
    expect(fullNameFromUrl('git@gitlab.com:team/proj.git')).toBeNull()
    expect(fullNameFromUrl('https://bitbucket.org/team/proj.git')).toBeNull()
    expect(fullNameFromUrl('/Users/me/backups/myrepo.git')).toBeNull()
    expect(fullNameFromUrl('file:///Users/me/backups/myrepo.git')).toBeNull()
    // substring lookalikes must not pass for github.com either
    expect(fullNameFromUrl('https://mygithub.com/acme/myrepo')).toBeNull()
    expect(fullNameFromUrl('git@github.example.com:acme/myrepo.git')).toBeNull()
  })

  // per-account ssh aliases (Host github.com-work in ~/.ssh/config) resolve to
  // github.com, so those really are the same repos
  it('accepts ssh host aliases but not lookalike domains', () => {
    expect(fullNameFromUrl('git@github.com-work:acme/myrepo.git')).toBe('acme/myrepo')
    expect(fullNameFromUrl('git@github.com-personal:acme/myrepo.git')).toBe('acme/myrepo')
    // a hyphen suffix containing a dot is a registrable domain, not an alias
    expect(fullNameFromUrl('https://github.com-evil.com/acme/myrepo')).toBeNull()
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

// The providers whose logs record no branch (Copilot after CLI 1.0.80, most Codex
// rollouts) get theirs from here instead — see SessionMeta.logBranch.
describe('branchForCwd', () => {
  it('reads the branch of a main checkout', () => {
    expect(branchForCwd(mainRepo)).toBe('main')
  })

  it("reads a linked worktree's own HEAD, not the main checkout's", () => {
    expect(branchForCwd(worktree)).toBe('cockpit/fix-login')
  })

  it('answers for a subdirectory of the worktree (sessions run deeper than the root)', () => {
    const sub = join(worktree, 'src', 'main')
    mkdirSync(sub, { recursive: true })
    expect(branchForCwd(sub)).toBe('cockpit/fix-login')
  })

  it('abbreviates a detached HEAD rather than claiming a branch', () => {
    expect(branchForCwd(join(root, 'detached'))).toBe('a1b2c3d')
  })

  it('is null outside a repo, for a deleted cwd, and for no cwd at all', () => {
    expect(branchForCwd(join(root, 'plain'))).toBeNull()
    expect(branchForCwd(join(root, 'was-a-worktree'))).toBeNull()
    expect(branchForCwd(null)).toBeNull()
  })

  // the gitdir a cwd resolves to is cached; the ref inside it is deliberately not,
  // so a worktree that switches branches is reported on the next scan, not the next launch
  it('follows the checkout when it switches branch', () => {
    const head = join(mainRepo, '.git', 'worktrees', 'fix-login', 'HEAD')
    try {
      writeFileSync(head, 'ref: refs/heads/cockpit/other\n')
      expect(branchForCwd(worktree)).toBe('cockpit/other')
    } finally {
      writeFileSync(head, 'ref: refs/heads/cockpit/fix-login\n')
    }
  })
})

afterAll(() => rmSync(root, { recursive: true, force: true }))
