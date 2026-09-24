import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseWorktreeList } from '../src/main/cleanup-core'
import { createWorkspace } from '../src/main/workspace'

/**
 * createWorkspace against real repositories in a tmpdir — the cleanup tests'
 * fixture style. Nothing is mocked, so what a failed `git worktree add` leaves
 * behind is git's own behaviour, not a model of it: `-b` creates the branch
 * before anything else can fail, and a failing post-checkout hook fails the
 * command only after the worktree is complete.
 */

// resolved: macOS tmpdir is a symlink (/var → /private/var) and git lists real paths
const root = mkdtempSync(join(realpathSync(tmpdir()), 'cockpit-workspace-fixtures-'))
const userData = join(root, 'userData')
const savedUserData = process.env['COCKPIT_USER_DATA']

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture',
      GIT_AUTHOR_EMAIL: 'fixture@example.com',
      GIT_COMMITTER_NAME: 'Fixture',
      GIT_COMMITTER_EMAIL: 'fixture@example.com'
    }
  })
}

// husky's post-checkout with no node on the GUI PATH: the shell can't find the
// command and exits 127, which git then reports as its own exit status
const HUSKY_WITHOUT_NODE = '#!/bin/sh\nnode-is-not-on-this-path lint-staged\n'

let repos = 0

/** A fresh repository with one commit, its hooks where husky puts them: core.hooksPath. */
function repo(hook?: string): string {
  const n = ++repos
  const dir = join(root, `repo-${n}`)
  const hooks = join(root, `hooks-${n}`)
  mkdirSync(dir, { recursive: true })
  mkdirSync(hooks, { recursive: true })
  git(dir, ['init', '-q', '-b', 'main'])
  writeFileSync(join(dir, 'README.md'), '# app\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-q', '-m', 'init'])
  // set locally, so a global core.hooksPath on the machine can't hide the hook
  git(dir, ['config', 'core.hooksPath', hooks])
  if (hook) writeFileSync(join(hooks, 'post-checkout'), hook, { mode: 0o755 })
  return dir
}

/** Where createWorkspace cuts a worktree for this repo. */
const home = (repoDir: string, slug: string): string =>
  join(userData, 'worktrees', repoDir.slice(root.length + 1), slug)

const cockpitBranches = (dir: string): string[] =>
  git(dir, ['branch', '--list', 'cockpit/*', '--format=%(refname:short)'])
    .split('\n')
    .filter(Boolean)
    .sort()

/** Every registered worktree but the repository's own checkout. */
const linked = (dir: string): string[] =>
  parseWorktreeList(git(dir, ['worktree', 'list', '--porcelain']))
    .slice(1)
    .map((e) => e.path)
    .sort()

beforeAll(() => {
  process.env['COCKPIT_USER_DATA'] = userData
})

afterAll(() => {
  if (savedUserData === undefined) delete process.env['COCKPIT_USER_DATA']
  else process.env['COCKPIT_USER_DATA'] = savedUserData
  rmSync(root, { recursive: true, force: true })
})

describe('createWorkspace — a failing post-checkout hook', () => {
  it('keeps the finished worktree and passes on what the hook printed', async () => {
    const dir = repo(HUSKY_WITHOUT_NODE)
    const ws = await createWorkspace(dir, 'Fix login')

    expect(ws).toMatchObject({ cwd: home(dir, 'fix-login'), branch: 'cockpit/fix-login' })
    expect(ws.warning).toMatch(/post-checkout hook failed/)
    expect(ws.warning).toContain('node-is-not-on-this-path')
    // the checkout finished before the hook ran
    expect(readFileSync(join(ws.cwd, 'README.md'), 'utf8')).toBe('# app\n')
    expect(git(ws.cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('cockpit/fix-login')
    expect(linked(dir)).toEqual([ws.cwd])
  })

  it('starts the same name again on a fresh branch, leaving nothing half-made behind', async () => {
    const dir = repo(HUSKY_WITHOUT_NODE)
    const first = await createWorkspace(dir, 'fix login')
    const second = await createWorkspace(dir, 'fix login')

    expect(second.branch).toMatch(/^cockpit\/fix-login-[a-z0-9]{4}$/)
    expect(second.warning).toContain('node-is-not-on-this-path')
    expect(cockpitBranches(dir)).toEqual([first.branch, second.branch].sort())
    expect(linked(dir)).toEqual([first.cwd, second.cwd].sort())
  })

  it('carries no warning when the hook succeeds', async () => {
    const dir = repo('#!/bin/sh\nexit 0\n')
    const ws = await createWorkspace(dir, 'quiet')
    expect(ws).toEqual({ cwd: home(dir, 'quiet'), branch: 'cockpit/quiet' })
  })
})

describe('createWorkspace — what a failed add leaves behind', () => {
  it('removes the branch a failed checkout made, and the worktree with it', async () => {
    // a required smudge filter that fails: git-lfs missing from the GUI PATH is the real one
    const dir = repo()
    writeFileSync(join(dir, '.gitattributes'), '*.bin filter=boom\n')
    writeFileSync(join(dir, 'asset.bin'), 'data\n')
    git(dir, ['add', '.'])
    git(dir, ['commit', '-q', '-m', 'assets'])
    git(dir, ['config', 'filter.boom.smudge', 'false'])
    git(dir, ['config', 'filter.boom.required', 'true'])

    await expect(createWorkspace(dir, 'lfs')).rejects.toThrow(/smudge filter boom failed/)
    expect(cockpitBranches(dir)).toEqual([])
    expect(linked(dir)).toEqual([])
    expect(existsSync(home(dir, 'lfs'))).toBe(false)
  })

  it('never adds onto a directory that is already there, so no branch is orphaned', async () => {
    const dir = repo()
    const taken = home(dir, 'taken')
    mkdirSync(taken, { recursive: true })
    writeFileSync(join(taken, 'notes.txt'), 'not a worktree\n')

    const ws = await createWorkspace(dir, 'taken')
    expect(ws.branch).toMatch(/^cockpit\/taken-[a-z0-9]{4}$/)
    expect(cockpitBranches(dir)).toEqual([ws.branch])
    expect(readFileSync(join(taken, 'notes.txt'), 'utf8')).toBe('not a worktree\n')
  })

  it('leaves a branch it did not create alone, even one at the base commit', async () => {
    const dir = repo()
    git(dir, ['branch', 'cockpit/mine'])

    const ws = await createWorkspace(dir, 'mine')
    expect(ws.branch).toMatch(/^cockpit\/mine-[a-z0-9]{4}$/)
    expect(cockpitBranches(dir)).toEqual(['cockpit/mine', ws.branch].sort())
  })

  it('gives two sessions started together under one name a worktree each', async () => {
    const dir = repo(HUSKY_WITHOUT_NODE)
    const [a, b] = await Promise.all([createWorkspace(dir, 'twin'), createWorkspace(dir, 'twin')])

    expect(a.cwd).not.toBe(b.cwd)
    expect(cockpitBranches(dir)).toEqual([a.branch, b.branch].sort())
    expect(linked(dir)).toEqual([a.cwd, b.cwd].sort())
  })
})

describe('createWorkspace — stale registrations', () => {
  it('drops only the dead registration at its own path, never the rest', async () => {
    const dir = repo()
    // a worktree at the path this session will want, deleted by hand
    const reused = home(dir, 'reuse')
    git(dir, ['worktree', 'add', '-q', '--detach', reused])
    rmSync(reused, { recursive: true, force: true })
    // and one on a drive that is only unmounted: its directory is missing too
    const drive = join(root, `usb-drive-${repos}`)
    const onDrive = join(drive, 'work')
    git(dir, ['worktree', 'add', '-q', '-b', 'usb-work', onDrive])
    rmSync(drive, { recursive: true, force: true })

    const ws = await createWorkspace(dir, 'reuse')
    expect(ws).toEqual({ cwd: reused, branch: 'cockpit/reuse' })
    expect(linked(dir)).toEqual([onDrive, reused].sort())
    expect(git(dir, ['branch', '--list', 'usb-work', '--format=%(refname:short)']).trim()).toBe(
      'usb-work'
    )
  })
})
