import { describe, it, expect, beforeAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { clearRepoCache, fullNameFromUrl, resolveRepo } from '../src/main/repos'

const root = join(tmpdir(), 'cockpit-repo-fixtures')
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
  mkdirSync(join(mainRepo, '.git', 'worktrees', 'fix-login'), { recursive: true })

  // linked worktree: .git FILE pointing at main repo's worktree gitdir
  mkdirSync(worktree, { recursive: true })
  writeFileSync(join(worktree, '.git'), `gitdir: ${join(mainRepo, '.git', 'worktrees', 'fix-login')}\n`)

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
