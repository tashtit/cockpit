import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { commitShare, writeShareFiles } from '../src/main/instructions-share'
import { adoptableBlock, extractSharedBlock } from '../src/main/instructions-core'
import { END, LEGACY_END, LEGACY_START, START } from '../src/shared/instruction-markers'

/*
 * Sharing writes into a real git worktree, so the test uses a real repo: the
 * commit, the "nothing changed" case, and the symlinked CLAUDE.md this very
 * project ships. Pushing and `gh` are left out — those are the network.
 */

let root = ''
const roots: string[] = []

function git(args: readonly string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com'
    }
  })
}

function repo(): string {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'cockpit-share-'))
  roots.push(dir)
  git(['init', '-q', '-b', 'main'], dir)
  // commitShare commits through the app's own path, which uses whatever git
  // identity the machine has — and a CI runner has none, so set it on the repo
  git(['config', 'user.name', 'Test'], dir)
  git(['config', 'user.email', 'test@example.com'], dir)
  writeFileSync(join(dir, 'README.md'), '# demo\n')
  git(['add', '-A'], dir)
  git(['commit', '-qm', 'initial'], dir)
  return dir
}

beforeEach(() => {
  root = repo()
})

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

describe('writeShareFiles', () => {
  it('writes the baseline into both instruction files', () => {
    const changed = writeShareFiles(root, '# house rules')
    expect(changed.map((p) => p.replace(root + '/', '')).sort()).toEqual(['AGENTS.md', 'CLAUDE.md'])
    expect(extractSharedBlock(readFileSync(join(root, 'CLAUDE.md'), 'utf8'))).toBe('# house rules')
    expect(extractSharedBlock(readFileSync(join(root, 'AGENTS.md'), 'utf8'))).toBe('# house rules')
  })

  it('leaves the repo’s own content alone', () => {
    writeFileSync(join(root, 'AGENTS.md'), '# AGENTS\n\nBuild with npm.\n')
    writeShareFiles(root, '# house rules')
    const raw = readFileSync(join(root, 'AGENTS.md'), 'utf8')
    expect(raw).toContain('Build with npm.')
    expect(raw.indexOf('Build with npm.')).toBeLessThan(raw.indexOf(START))
  })

  it('writes a symlinked CLAUDE.md once, through its target', () => {
    writeFileSync(join(root, 'AGENTS.md'), '# AGENTS\n')
    symlinkSync('AGENTS.md', join(root, 'CLAUDE.md'))
    const changed = writeShareFiles(root, '# house rules')
    expect(changed).toEqual([join(root, 'AGENTS.md')])
    // one block, not two: the link and its target are the same file
    const raw = readFileSync(join(root, 'AGENTS.md'), 'utf8')
    expect(raw.split(START)).toHaveLength(2)
  })

  it('refuses a link that points outside the worktree', () => {
    const outside = join(root, '..', 'elsewhere.md')
    writeFileSync(outside, '# not ours\n')
    roots.push(outside)
    symlinkSync(outside, join(root, 'AGENTS.md'))
    expect(() => writeShareFiles(root, '# house rules')).toThrow(/points outside the worktree/)
    expect(readFileSync(outside, 'utf8')).toBe('# not ours\n')
  })

  it('works through a symlinked path to the worktree itself', () => {
    // macOS hands out /var/folders worktrees, and /var is a symlink to /private/var:
    // resolving a file but not its root read every write as an escape attempt
    writeShareFiles(root, '# house rules')
    const link = join(realpathSync(tmpdir()), `cockpit-link-${Date.now()}`)
    symlinkSync(root, link)
    roots.push(link)
    expect(() => writeShareFiles(link, '# house rules, revised')).not.toThrow()
    expect(extractSharedBlock(readFileSync(join(root, 'AGENTS.md'), 'utf8'))).toBe(
      '# house rules, revised'
    )
  })

  it('changes nothing when the files already carry the baseline', () => {
    writeShareFiles(root, '# house rules')
    expect(writeShareFiles(root, '# house rules')).toEqual([])
  })

  it('renames the older markers as it writes, leaving the repo’s own text alone', () => {
    writeFileSync(join(root, 'AGENTS.md'), `# AGENTS\n\n${LEGACY_START}\n# house rules\n${LEGACY_END}\n`)
    const changed = writeShareFiles(root, '# house rules, revised')
    expect(changed.map((p) => p.replace(root + '/', '')).sort()).toEqual(['AGENTS.md', 'CLAUDE.md'])
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(
      `# AGENTS\n\n${START}\n# house rules, revised\n${END}\n`
    )
  })
})

describe('commitShare', () => {
  it('commits what it wrote and leaves the worktree clean', async () => {
    expect(await commitShare(root, '# house rules')).toBe(true)
    expect(git(['status', '--porcelain'], root).trim()).toBe('')
    expect(git(['log', '-1', '--pretty=%s'], root).trim()).toBe(
      'docs: update shared agent instructions'
    )
    const files = git(['show', '--name-only', '--pretty=', 'HEAD'], root).trim().split('\n').sort()
    expect(files).toEqual(['AGENTS.md', 'CLAUDE.md'])
  })

  it('makes no commit when the repo already says this', async () => {
    await commitShare(root, '# house rules')
    const head = git(['rev-parse', 'HEAD'], root).trim()
    expect(await commitShare(root, '# house rules')).toBe(false)
    expect(git(['rev-parse', 'HEAD'], root).trim()).toBe(head)
  })

  it('surfaces a refusing pre-commit hook rather than bypassing it', async () => {
    const hooks = join(root, '.git', 'hooks')
    mkdirSync(hooks, { recursive: true })
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\necho "no shares today" >&2\nexit 1\n', {
      mode: 0o755
    })
    await expect(commitShare(root, '# house rules')).rejects.toThrow(/no shares today/)
  })
})

describe('adoptableBlock', () => {
  const block = (text: string): string => `${START}\n${text}\n${END}\n`

  it('takes the first file that has one', () => {
    expect(adoptableBlock([null, block('# from the repo'), block('# older')])).toBe('# from the repo')
  })

  it('ignores files with no block, or an empty one', () => {
    expect(adoptableBlock([null, '# just the repo’s own text', block('   ')])).toBeNull()
    expect(adoptableBlock([])).toBeNull()
  })
})

describe('the repo is the medium', () => {
  it('a clone carries the block a share committed', async () => {
    await commitShare(root, '# house rules')
    const clone = mkdtempSync(join(realpathSync(tmpdir()), 'cockpit-clone-'))
    roots.push(clone)
    git(['clone', '-q', root, clone], process.cwd())
    expect(existsSync(join(clone, 'CLAUDE.md'))).toBe(true)
    expect(
      adoptableBlock([
        readFileSync(join(clone, 'CLAUDE.md'), 'utf8'),
        readFileSync(join(clone, 'AGENTS.md'), 'utf8')
      ])
    ).toBe('# house rules')
  })
})
