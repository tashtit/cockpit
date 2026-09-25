import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultBranch } from '../src/main/github'
import { createPr } from '../src/main/workspace'

/**
 * Real repositories in a tmpdir — what a PR would target is a question only git can
 * answer, and the answer decides whether the chat header offers "Create PR" at all.
 */
let root: string

function repo(name: string): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  const git = (...args: string[]): void => {
    execFileSync('git', args, {
      cwd: dir,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'dev',
        GIT_AUTHOR_EMAIL: 'dev@example.com',
        GIT_COMMITTER_NAME: 'dev',
        GIT_COMMITTER_EMAIL: 'dev@example.com'
      }
    })
  }
  git('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), '# x\n')
  git('add', '-A')
  git('commit', '-qm', 'init')
  return dir
}

/** What a clone has: remote-tracking refs, and sometimes origin/HEAD beside them. */
function remoteRef(dir: string, branch: string): void {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim()
  execFileSync('git', ['update-ref', `refs/remotes/origin/${branch}`, sha], { cwd: dir })
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'cockpit-default-branch-'))
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('getDefaultBranch', () => {
  it('reads origin/HEAD when the clone recorded one', async () => {
    const dir = repo('recorded')
    remoteRef(dir, 'trunk')
    execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk'], {
      cwd: dir
    })
    await expect(getDefaultBranch(dir)).resolves.toBe('trunk')
  })

  it('falls back to the conventional name that actually exists on the remote', async () => {
    const dir = repo('no-head')
    remoteRef(dir, 'master')
    await expect(getDefaultBranch(dir)).resolves.toBe('master')
  })

  it('answers null rather than guessing when git knows no remote branch', async () => {
    const dir = repo('local-only')
    await expect(getDefaultBranch(dir)).resolves.toBeNull()
  })

  it('fails soft outside a repository', async () => {
    const dir = join(root, 'not-a-repo')
    mkdirSync(dir, { recursive: true })
    await expect(getDefaultBranch(dir)).resolves.toBeNull()
  })
})

/*
 * The push happens before `gh pr create` could refuse anything, so Create PR has to
 * refuse the default branch itself — a session in the main checkout is otherwise one
 * click from pushing its local commits straight onto the remote's default branch.
 */
describe('createPr', () => {
  it('refuses to push the default branch, before anything reaches the remote', async () => {
    const dir = repo('on-default')
    const bare = join(root, 'on-default-remote.git')
    execFileSync('git', ['init', '-q', '--bare', bare])
    execFileSync('git', ['remote', 'add', 'origin', bare], { cwd: dir })
    remoteRef(dir, 'main')
    execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], { cwd: dir })

    await expect(createPr(dir)).rejects.toThrow(/main is the default branch/)
    expect(execFileSync('git', ['for-each-ref'], { cwd: bare }).toString()).toBe('')
  })
})
