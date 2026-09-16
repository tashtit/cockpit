import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  END,
  START,
  extractSharedBlock,
  fileStatus,
  instructionTargets,
  lineCount,
  normalizeBaseline,
  splitSharedBlock,
  upsertSharedBlock
} from '../src/main/instructions-core'
import {
  adoptInstructionsFrom,
  applyInstructions,
  getInstructions,
  saveBaseline
} from '../src/main/instructions'

const BASE = 'Always use worktrees.\nNever commit unless asked.'

/** The baseline as it arrives when a whole agent file is pasted into the editor. */
const PASTED = `${START}\n${BASE}\n${END}\n`

const count = (text: string, marker: string): number => text.split(marker).length - 1

describe('upsertSharedBlock', () => {
  it('creates a block in an empty file', () => {
    const out = upsertSharedBlock('', BASE)
    expect(out).toBe(`${START}\n${BASE}\n${END}\n`)
  })

  it('appends after existing content, preserving it byte-for-byte', () => {
    const own = '# Session Instructions\n\n## Hard boundaries\n\n* `ciqol`\n'
    const out = upsertSharedBlock(own, BASE)
    expect(out.startsWith(own.trimEnd())).toBe(true)
    expect(out).toContain(`\n\n${START}\n`)
    expect(extractSharedBlock(out)).toBe(BASE)
  })

  it('replaces an existing block in place, keeping text before and after', () => {
    const raw = `before\n\n${START}\nold stuff\n${END}\n\nafter\n`
    const out = upsertSharedBlock(raw, BASE)
    expect(out).toBe(`before\n\n${START}\n${BASE}\n${END}\n\nafter\n`)
  })

  it('is idempotent', () => {
    const once = upsertSharedBlock('# mine\n', BASE)
    expect(upsertSharedBlock(once, BASE)).toBe(once)
  })

  it('trims the baseline so re-applying the same text never drifts', () => {
    const out = upsertSharedBlock('', `\n${BASE}\n\n`)
    expect(extractSharedBlock(out)).toBe(BASE)
  })

  it('repairs an orphaned START in place instead of appending a second block', () => {
    // a hand-edited file that lost its END marker: applying twice must not eat
    // the user's own notes between the orphan and the block
    const raw = `${START}\nmy own notes\n`
    const once = upsertSharedBlock(raw, BASE)
    expect(once).toContain('my own notes')
    expect(extractSharedBlock(once)).toBe(BASE)
    expect(upsertSharedBlock(once, BASE)).toBe(once)
  })
})

describe('normalizeBaseline', () => {
  it('drops a leading START and a trailing END line, and trims', () => {
    expect(normalizeBaseline(PASTED)).toBe(BASE)
    expect(normalizeBaseline(`\n\n${START}\n\n${BASE}\n\n${END}\n\n`)).toBe(BASE)
  })

  it('tolerates blanks around a marker and CRLF line endings', () => {
    expect(normalizeBaseline(`  ${START}  \r\n${BASE}\r\n\t${END}\r\n`)).toBe(BASE)
  })

  it('drops a marker line wherever it sits, keeping every other line', () => {
    // a whole file pasted with the user's own lines around the block: the markers
    // would nest on apply, the lines are theirs and stay
    const whole = `# mine\n\n${START}\n${BASE}\n${END}\n\nafter\n`
    expect(normalizeBaseline(whole)).toBe(`# mine\n\n${BASE}\n\nafter`)
  })

  it('leaves a marker quoted inside a line alone', () => {
    const prose = `Cockpit writes between \`${START}\` and \`${END}\`.`
    expect(normalizeBaseline(prose)).toBe(prose)
  })

  it('leaves clean text as it is, and markers alone become nothing', () => {
    expect(normalizeBaseline(BASE)).toBe(BASE)
    expect(normalizeBaseline(`${START}\n${END}`)).toBe('')
  })
})

describe('upsertSharedBlock with a pasted baseline', () => {
  it('writes a single pair of markers, not a nested one', () => {
    const out = upsertSharedBlock('# mine\n', PASTED)
    expect(count(out, START)).toBe(1)
    expect(count(out, END)).toBe(1)
    expect(out).toBe(upsertSharedBlock('# mine\n', BASE))
    expect(extractSharedBlock(out)).toBe(BASE)
  })

  it('re-applying a pasted baseline over its own block changes nothing', () => {
    const once = upsertSharedBlock('before\n', PASTED)
    expect(upsertSharedBlock(once, PASTED)).toBe(once)
  })
})

describe('extractSharedBlock', () => {
  it('returns null when there is no block or a half block', () => {
    expect(extractSharedBlock('just text')).toBeNull()
    expect(extractSharedBlock(`${START}\nunclosed`)).toBeNull()
  })
})

describe('splitSharedBlock', () => {
  it('reads the file as own lines, block, own lines', () => {
    const raw = `# mine\n\n${START}\n${BASE}\n${END}\n\nafter\n`
    expect(splitSharedBlock(raw)).toEqual({ above: '# mine\n\n', block: BASE, below: '\n\nafter\n' })
  })

  it('a file with no block is all own content — the block would go after it', () => {
    expect(splitSharedBlock('# only mine\n')).toEqual({ above: '# only mine\n', block: null, below: '' })
    // an orphaned START is no block either: nothing between it and a missing END is managed
    expect(splitSharedBlock(`${START}\nunclosed`)).toEqual({ above: `${START}\nunclosed`, block: null, below: '' })
  })
})

describe('lineCount', () => {
  it('counts lines without the blank padding around them', () => {
    expect(lineCount('')).toBe(0)
    expect(lineCount('\n\n')).toBe(0)
    expect(lineCount('# mine\n\n')).toBe(1)
    expect(lineCount('a\n\nb\n')).toBe(3)
  })
})

describe('fileStatus', () => {
  const applied = upsertSharedBlock('# codex own rules\n', BASE)
  it('missing / unmanaged / synced / drifted', () => {
    expect(fileStatus(null, BASE)).toBe('missing')
    expect(fileStatus('# only own content\n', BASE)).toBe('unmanaged')
    expect(fileStatus(applied, BASE)).toBe('synced')
    expect(fileStatus(applied, BASE + '\nNew rule.')).toBe('drifted')
    expect(fileStatus(applied.replace('worktrees', 'branches'), BASE)).toBe('drifted')
  })

  it('a baseline stored with its markers still reads a matching block as synced', () => {
    expect(fileStatus(applied, PASTED)).toBe('synced')
    expect(fileStatus(applied.replace('worktrees', 'branches'), PASTED)).toBe('drifted')
  })
})

/*
 * The IO half against real files: config.ts resolves its dir from COCKPIT_USER_DATA
 * when no electron runtime is present, and the repo scope keeps every target under
 * a tmpdir of its own.
 */
describe('saveBaseline / applyInstructions (real files)', () => {
  let userData = ''
  let repo = ''
  const realUserData = process.env['COCKPIT_USER_DATA']

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-inst-'))
    userData = join(root, 'user-data')
    repo = join(root, 'repo')
    mkdirSync(userData, { recursive: true })
    mkdirSync(repo, { recursive: true })
    process.env['COCKPIT_USER_DATA'] = userData
    writeFileSync(join(userData, 'cockpit-config.json'), JSON.stringify({ sources: [] }))
  })

  afterEach(() => {
    if (realUserData === undefined) delete process.env['COCKPIT_USER_DATA']
    else process.env['COCKPIT_USER_DATA'] = realUserData
    rmSync(join(userData, '..'), { recursive: true, force: true })
  })

  const claudeMd = (): string => join(repo, 'CLAUDE.md')
  const agentsMd = (): string => join(repo, 'AGENTS.md')
  const storedBaseline = (): unknown =>
    JSON.parse(readFileSync(join(userData, 'cockpit-config.json'), 'utf8')).sharedInstructions.repos[repo]

  it('a pasted whole file is stored without its markers and reads as synced', () => {
    // a file that is the managed block and nothing else, as a first apply leaves it
    writeFileSync(claudeMd(), upsertSharedBlock('', BASE))
    const before = readFileSync(claudeMd(), 'utf8')
    expect(before.startsWith(START)).toBe(true)

    // the user pastes the file they are looking at into the Write tab
    const state = saveBaseline(repo, before)
    expect(state.baseline).toBe(BASE)
    expect(storedBaseline()).toBe(BASE)
    const byPath = Object.fromEntries(state.files.map((f) => [f.path, f.status]))
    expect(byPath).toEqual({ [claudeMd()]: 'synced', [agentsMd()]: 'missing' })
  })

  it('apply never writes nested markers, and leaves the text outside the block alone', () => {
    const own = '# Repo rules\n\nRun the tests first.\n'
    const trailer = '\n\n## Below the block\n\nStill mine.\n'
    writeFileSync(claudeMd(), upsertSharedBlock(own, 'old shared text').trimEnd() + trailer)
    writeFileSync(agentsMd(), '# codex + copilot\n\nTheir own notes.\n')

    const state = applyAfterSaving(PASTED)
    for (const path of [claudeMd(), agentsMd()]) {
      const text = readFileSync(path, 'utf8')
      expect(count(text, START)).toBe(1)
      expect(count(text, END)).toBe(1)
      expect(extractSharedBlock(text)).toBe(BASE)
    }
    expect(readFileSync(claudeMd(), 'utf8')).toBe(`${own}\n${START}\n${BASE}\n${END}${trailer}`)
    expect(readFileSync(agentsMd(), 'utf8').startsWith('# codex + copilot\n\nTheir own notes.\n')).toBe(true)
    expect(state.files.map((f) => f.status)).toEqual(['synced', 'synced'])

    // and again: a second apply of the same pasted text is a no-op on disk
    const snapshot = readFileSync(claudeMd(), 'utf8')
    applyAfterSaving(PASTED)
    expect(readFileSync(claudeMd(), 'utf8')).toBe(snapshot)
  })

  it('a baseline stored with its markers before this fix reads and applies cleanly', () => {
    writeFileSync(
      join(userData, 'cockpit-config.json'),
      JSON.stringify({ sources: [], sharedInstructions: { repos: { [repo]: PASTED } } })
    )
    writeFileSync(claudeMd(), upsertSharedBlock('# mine\n', BASE))

    const state = getInstructions(repo)
    expect(state.baseline).toBe(BASE)
    expect(state.files.find((f) => f.path === claudeMd())?.status).toBe('synced')

    const applied = applyInstructions(repo)
    expect(applied.files.map((f) => f.status)).toEqual(['synced', 'synced'])
    const agents = readFileSync(agentsMd(), 'utf8')
    expect(count(agents, START)).toBe(1)
    expect(count(agents, END)).toBe(1)
    expect(extractSharedBlock(agents)).toBe(BASE)
  })

  it('a paste of nothing but the markers is an empty baseline: nothing to apply', () => {
    expect(() => applyAfterSaving(`${START}\n${END}\n`)).toThrow(/empty/)
  })

  function applyAfterSaving(text: string): ReturnType<typeof applyInstructions> {
    saveBaseline(repo, text)
    return applyInstructions(repo)
  }
})

/*
 * A repo's instructions live in the repo, so they can arrive before Cockpit has
 * any baseline of its own: a fresh clone, or a teammate's merged share.
 */
describe('adopting what the repo already carries', () => {
  let userData = ''
  let repo = ''
  const realUserData = process.env['COCKPIT_USER_DATA']

  beforeEach(() => {
    const root = mkdtempSync(join(tmpdir(), 'cockpit-adopt-'))
    userData = join(root, 'user-data')
    repo = join(root, 'repo')
    mkdirSync(userData, { recursive: true })
    mkdirSync(repo, { recursive: true })
    process.env['COCKPIT_USER_DATA'] = userData
    writeFileSync(join(userData, 'cockpit-config.json'), JSON.stringify({ sources: [] }))
  })

  afterEach(() => {
    if (realUserData === undefined) delete process.env['COCKPIT_USER_DATA']
    else process.env['COCKPIT_USER_DATA'] = realUserData
    rmSync(join(userData, '..'), { recursive: true, force: true })
  })

  it('takes the committed block as the baseline on first read', () => {
    writeFileSync(join(repo, 'CLAUDE.md'), upsertSharedBlock('# Repo rules\n', BASE))
    const state = getInstructions(repo)
    expect(state.baseline).toBe(BASE)
    expect(state.files.find((f) => f.path.endsWith('CLAUDE.md'))?.status).toBe('synced')
  })

  it('never re-adopts over a baseline the user cleared', () => {
    writeFileSync(join(repo, 'CLAUDE.md'), upsertSharedBlock('', BASE))
    saveBaseline(repo, '')
    expect(getInstructions(repo).baseline).toBe('')
  })

  it('leaves the global scope alone — a stale home file is nobody\u2019s share', () => {
    const home = join(userData, '..', 'home')
    mkdirSync(join(home, '.claude'), { recursive: true })
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), upsertSharedBlock('', BASE))
    const realHome = process.env.HOME
    process.env.HOME = home
    try {
      expect(getInstructions(null).baseline).toBe('')
    } finally {
      process.env.HOME = realHome
    }
  })

  it('takes one file\u2019s version on demand when the two disagree', () => {
    saveBaseline(repo, BASE)
    const theirs = 'Always open a PR.'
    writeFileSync(join(repo, 'AGENTS.md'), upsertSharedBlock('', theirs))
    expect(getInstructions(repo).files.find((f) => f.path.endsWith('AGENTS.md'))?.status).toBe(
      'drifted'
    )

    const state = adoptInstructionsFrom(repo, join(repo, 'AGENTS.md'))
    expect(state.baseline).toBe(theirs)
    expect(state.files.find((f) => f.path.endsWith('AGENTS.md'))?.status).toBe('synced')
  })

  it('refuses a path that is not a target, or a file with no block', () => {
    saveBaseline(repo, BASE)
    expect(() => adoptInstructionsFrom(repo, join(repo, 'NOTES.md'))).toThrow(/not an instruction file/)
    writeFileSync(join(repo, 'AGENTS.md'), '# just prose\n')
    expect(() => adoptInstructionsFrom(repo, join(repo, 'AGENTS.md'))).toThrow(/no shared block/)
  })
})


describe('instructionTargets', () => {
  it('global scope: one native file per agent', () => {
    const t = instructionTargets(null, '/Users/x')
    expect(t.map((x) => x.path)).toEqual([
      '/Users/x/.claude/CLAUDE.md',
      '/Users/x/.codex/AGENTS.md',
      '/Users/x/.copilot/copilot-instructions.md'
    ])
    expect(t.map((x) => x.agents)).toEqual([['claude'], ['codex'], ['copilot']])
  })

  it('repo scope: AGENTS.md covers codex and copilot', () => {
    const t = instructionTargets('/repo')
    expect(t).toEqual([
      { agents: ['claude'], path: '/repo/CLAUDE.md' },
      { agents: ['codex', 'copilot'], path: '/repo/AGENTS.md' }
    ])
  })
})
