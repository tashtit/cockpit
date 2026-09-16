import { afterEach, beforeEach, describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  END,
  LEGACY_END,
  LEGACY_START,
  START,
  adoptableBlock,
  claudeImports,
  extractSharedBlock,
  fileStatus,
  foldTargets,
  instructionTargets,
  lineCount,
  normalizeBaseline,
  removeSharedBlock,
  splitSharedBlock,
  upsertSharedBlock,
  type TargetRead
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
    expect(splitSharedBlock(raw)).toEqual({ above: '# mine\n\n', block: BASE, below: '\n\nafter\n', duplicates: 0 })
  })

  it('a file with no block is all own content — the block would go after it', () => {
    expect(splitSharedBlock('# only mine\n')).toEqual({ above: '# only mine\n', block: null, below: '', duplicates: 0 })
    // an orphaned START is no block either: nothing between it and a missing END is managed
    expect(splitSharedBlock(`${START}\nunclosed`)).toEqual({ above: `${START}\nunclosed`, block: null, below: '', duplicates: 0 })
  })
})

/*
 * Two spellings of the markers: the `agent-parity` pair (canonical — what the plugin
 * of that name writes) and the `cockpit` pair Cockpit wrote before adopting it. Both
 * are read; only the canonical pair is ever written.
 */
describe('marker families', () => {
  const OWN_ABOVE = '# Mine\n\nKeep this.\n\n'
  const OWN_BELOW = '\n\n## Also mine\n\nAnd this.\n'
  const legacy = (text: string): string => `${LEGACY_START}\n${text}\n${LEGACY_END}`
  const canonical = (text: string): string => `${START}\n${text}\n${END}`

  it('the canonical pair is the plugin’s; the legacy pair is what Cockpit used to write', () => {
    expect(START).toBe('<!-- agent-parity:shared:start -->')
    expect(END).toBe('<!-- agent-parity:shared:end -->')
    expect(LEGACY_START).toBe('<!-- cockpit:shared:start -->')
    expect(LEGACY_END).toBe('<!-- cockpit:shared:end -->')
  })

  describe('a file on the legacy markers', () => {
    const raw = OWN_ABOVE + legacy(BASE) + OWN_BELOW

    it('reads as the same block, with the same verdicts', () => {
      expect(splitSharedBlock(raw)).toEqual({ above: OWN_ABOVE, block: BASE, below: OWN_BELOW, duplicates: 0 })
      expect(fileStatus(raw, BASE)).toBe('synced')
      expect(fileStatus(raw, BASE + '\nNew rule.')).toBe('drifted')
      expect(fileStatus(raw.replace('worktrees', 'branches'), BASE)).toBe('drifted')
      expect(adoptableBlock([raw])).toBe(BASE)
    })

    it('is renamed to the canonical pair where it stands on apply — every other byte kept', () => {
      const out = upsertSharedBlock(raw, BASE)
      expect(out).toBe(OWN_ABOVE + canonical(BASE) + OWN_BELOW)
      expect(out).not.toContain(LEGACY_START)
      expect(out).not.toContain(LEGACY_END)
      expect(upsertSharedBlock(out, BASE)).toBe(out)
    })

    it('comes out whole when the agent is switched off', () => {
      expect(removeSharedBlock(raw)).toBe('# Mine\n\nKeep this.\n\n## Also mine\n\nAnd this.\n')
    })

    it('a pasted whole file loses its legacy marker lines too', () => {
      expect(normalizeBaseline(`${LEGACY_START}\n${BASE}\n${LEGACY_END}\n`)).toBe(BASE)
    })

    it('an orphaned legacy START is repaired in place, in the canonical spelling', () => {
      const once = upsertSharedBlock(`${LEGACY_START}\nmy own notes\n`, BASE)
      expect(once).toContain('my own notes')
      expect(once).not.toContain(LEGACY_START)
      expect(extractSharedBlock(once)).toBe(BASE)
      expect(upsertSharedBlock(once, BASE)).toBe(once)
    })
  })

  describe('a file on the canonical markers', () => {
    const raw = OWN_ABOVE + canonical(BASE) + OWN_BELOW

    it('is what apply writes, and applies over itself unchanged', () => {
      expect(upsertSharedBlock('', BASE)).toBe(canonical(BASE) + '\n')
      expect(splitSharedBlock(raw)).toEqual({ above: OWN_ABOVE, block: BASE, below: OWN_BELOW, duplicates: 0 })
      expect(fileStatus(raw, BASE)).toBe('synced')
      expect(fileStatus(raw, 'something else')).toBe('drifted')
      expect(upsertSharedBlock(raw, BASE)).toBe(raw)
    })
  })

  describe('a file with no block', () => {
    it('is unmanaged, gets the canonical pair appended, and has nothing to remove', () => {
      const own = '# Only mine\n'
      expect(fileStatus(own, BASE)).toBe('unmanaged')
      expect(upsertSharedBlock(own, BASE)).toBe(`${own}\n${canonical(BASE)}\n`)
      expect(removeSharedBlock(own)).toBe(own)
    })
  })

  describe('a file carrying the block under both spellings', () => {
    // each tool appended its own copy before it could read the other's
    const both = OWN_ABOVE + canonical(BASE) + '\n\n' + legacy(BASE) + '\n'
    const between = '\n\n## Between\n\nStill mine.\n\n'
    const withOwn = OWN_ABOVE + legacy('old text') + between + canonical(BASE) + OWN_BELOW

    it('reads as the first block, with the second already gone from what is below it', () => {
      expect(splitSharedBlock(both)).toEqual({ above: OWN_ABOVE, block: BASE, below: '\n', duplicates: 1 })
      expect(splitSharedBlock(withOwn)).toEqual({
        above: OWN_ABOVE,
        block: 'old text',
        below: '\n\n## Between\n\nStill mine.\n\n## Also mine\n\nAnd this.\n',
        duplicates: 1
      })
    })

    it('is never in sync, whatever the two copies say', () => {
      expect(fileStatus(both, BASE)).toBe('drifted')
      expect(fileStatus(withOwn, BASE)).toBe('drifted')
    })

    it('folds into one canonical block on apply, keeping every line the agent wrote', () => {
      expect(upsertSharedBlock(both, BASE)).toBe(OWN_ABOVE + canonical(BASE) + '\n')
      const out = upsertSharedBlock(withOwn, BASE)
      expect(out).toBe(
        OWN_ABOVE + canonical(BASE) + '\n\n## Between\n\nStill mine.\n\n## Also mine\n\nAnd this.\n'
      )
      expect(count(out, START)).toBe(1)
      expect(count(out, LEGACY_START)).toBe(0)
      expect(fileStatus(out, BASE)).toBe('synced')
      expect(upsertSharedBlock(out, BASE)).toBe(out)
    })

    it('keeps the block where the first copy was, whichever spelling that had', () => {
      const legacyFirst = 'top\n\n' + legacy(BASE) + '\n\nmiddle\n\n' + canonical(BASE) + '\n\nbottom\n'
      expect(upsertSharedBlock(legacyFirst, BASE)).toBe('top\n\n' + canonical(BASE) + '\n\nmiddle\n\nbottom\n')
    })

    it('folds three copies the same way', () => {
      const three = canonical(BASE) + '\n\n' + legacy(BASE) + '\n\n' + canonical('older') + '\n'
      expect(splitSharedBlock(three).duplicates).toBe(2)
      expect(upsertSharedBlock(three, BASE)).toBe(canonical(BASE) + '\n')
    })

    it('switching the agent off takes every copy out', () => {
      expect(removeSharedBlock(withOwn)).toBe(
        '# Mine\n\nKeep this.\n\n## Between\n\nStill mine.\n\n## Also mine\n\nAnd this.\n'
      )
    })
  })

  it('a START of one spelling closes with an END of the other', () => {
    const mixed = `${START}\n${BASE}\n${LEGACY_END}\n`
    expect(extractSharedBlock(mixed)).toBe(BASE)
    expect(fileStatus(mixed, BASE)).toBe('synced')
    expect(upsertSharedBlock(mixed, BASE)).toBe(canonical(BASE) + '\n')
  })
})

/*
 * A marker is a line of its own, outside fenced code — the plugin's rule too. Prose
 * that quotes a marker, or a document that shows the pair in a code block, is not
 * managed by it.
 */
describe('a marker is a whole line outside fenced code', () => {
  it('a marker quoted mid-line is prose, and the block goes after it', () => {
    const raw = `Cockpit writes between ${START} and ${END} markers.\n`
    expect(extractSharedBlock(raw)).toBeNull()
    expect(fileStatus(raw, BASE)).toBe('unmanaged')
    expect(upsertSharedBlock(raw, BASE)).toBe(`${raw}\n${START}\n${BASE}\n${END}\n`)
  })

  it('a pair shown inside a fenced code block is not a block', () => {
    for (const fence of ['```', '~~~']) {
      const doc = `# How it works\n\n${fence}markdown\n${START}\nthe shared text\n${END}\n${fence}\n`
      expect(extractSharedBlock(doc)).toBeNull()
      const out = upsertSharedBlock(doc, BASE)
      expect(out).toBe(`${doc}\n${START}\n${BASE}\n${END}\n`)
      // the real block below the example is the one that reads back, and stays put
      expect(extractSharedBlock(out)).toBe(BASE)
      expect(upsertSharedBlock(out, BASE)).toBe(out)
      expect(removeSharedBlock(out)).toBe(doc)
    }
  })

  it('an unclosed fence hides nothing — or every apply would append once more', () => {
    const raw = `# notes\n\n\`\`\`\nstray fence\n\n${START}\n${BASE}\n${END}\n`
    expect(extractSharedBlock(raw)).toBe(BASE)
    expect(upsertSharedBlock(raw, BASE)).toBe(raw)
  })

  it('blanks around a marker and CRLF line endings are tolerated', () => {
    const crlf = BASE.replace(/\n/g, '\r\n')
    const raw = `# mine\r\n\r\n  ${START}  \r\n${crlf}\r\n\t${END}\r\n`
    expect(fileStatus(raw, BASE)).toBe('synced')
    expect(fileStatus(raw, BASE + '\nNew rule.')).toBe('drifted')
  })
})

describe('claudeImports', () => {
  const home = '/Users/x'

  it('resolves a relative path against the importing file, and ~ against home', () => {
    expect(claudeImports('See @AGENTS.md for the rules.', '/repo', home)).toEqual(['/repo/AGENTS.md'])
    expect(claudeImports('@./AGENTS.md\n', '/repo', home)).toEqual(['/repo/AGENTS.md'])
    expect(claudeImports('@../AGENTS.md', '/repo/.claude', home)).toEqual(['/repo/AGENTS.md'])
    expect(claudeImports('Also @~/.codex/AGENTS.md', '/Users/x/.claude', home)).toEqual([
      '/Users/x/.codex/AGENTS.md'
    ])
    expect(claudeImports('@/abs/path.md', '/repo', home)).toEqual(['/abs/path.md'])
  })

  it('ignores a token inside code, a comment, or another word', () => {
    expect(claudeImports('`@AGENTS.md` is literal', '/repo', home)).toEqual([])
    expect(claudeImports('```\n@AGENTS.md\n```\n', '/repo', home)).toEqual([])
    expect(claudeImports('<!-- @AGENTS.md -->', '/repo', home)).toEqual([])
    expect(claudeImports('mail me@example.com', '/repo', home)).toEqual([])
  })
})

/*
 * A Claude file that reads another target instead of holding a block — a repo
 * CLAUDE.md that imports @AGENTS.md, or is a symlink to it — is folded into that
 * target, or Claude would load the text twice.
 */
describe('foldTargets', () => {
  const targets = instructionTargets('/repo')
  const read = (i: number, raw: string | null, real?: string): TargetRead => ({
    target: targets[i],
    raw,
    real: real ?? targets[i].path
  })

  it('a CLAUDE.md that imports AGENTS.md and has no block is folded into it', () => {
    const out = foldTargets([read(0, '# Repo\n\n@AGENTS.md\n'), read(1, upsertSharedBlock('', BASE))])
    expect(out.map((t) => t.target.path)).toEqual(['/repo/AGENTS.md'])
    expect(out[0].target.agents).toEqual(['claude', 'codex', 'copilot'])
    expect(out[0].readBy).toEqual([{ path: '/repo/CLAUDE.md', how: 'import' }])
  })

  it('a CLAUDE.md with a block of its own is managed by that block, import or not', () => {
    const out = foldTargets([read(0, `@AGENTS.md\n\n${START}\n${BASE}\n${END}\n`), read(1, null)])
    expect(out.map((t) => t.target.path)).toEqual(['/repo/CLAUDE.md', '/repo/AGENTS.md'])
    expect(out.every((t) => t.readBy.length === 0)).toBe(true)
  })

  it('an import that is not a target of the scope changes nothing', () => {
    expect(foldTargets([read(0, '@docs/RULES.md\n'), read(1, null)])).toHaveLength(2)
  })

  it('folds an importing CLAUDE.md even when AGENTS.md is missing — the apply creates it', () => {
    const out = foldTargets([read(0, '@AGENTS.md\n'), read(1, null)])
    expect(out.map((t) => [t.target.path, t.raw])).toEqual([['/repo/AGENTS.md', null]])
    expect(out[0].target.agents).toEqual(['claude', 'codex', 'copilot'])
  })

  it('two paths that are one file keep the one with the file’s own name', () => {
    const shared = upsertSharedBlock('', BASE)
    const out = foldTargets([read(0, shared, '/repo/AGENTS.md'), read(1, shared, '/repo/AGENTS.md')])
    expect(out.map((t) => t.target.path)).toEqual(['/repo/AGENTS.md'])
    expect(out[0].readBy).toEqual([{ path: '/repo/CLAUDE.md', how: 'link' }])
    expect(out[0].target.agents).toEqual(['claude', 'codex', 'copilot'])
    // and the other way round: AGENTS.md linking to CLAUDE.md
    const back = foldTargets([read(0, shared), read(1, shared, '/repo/CLAUDE.md')])
    expect(back.map((t) => t.target.path)).toEqual(['/repo/CLAUDE.md'])
    expect(back[0].readBy).toEqual([{ path: '/repo/AGENTS.md', how: 'link' }])
  })

  it('global: ~/.claude/CLAUDE.md importing the codex file joins its row', () => {
    const g = instructionTargets(null, '/Users/x')
    const out = foldTargets(
      [
        { target: g[0], raw: '@~/.codex/AGENTS.md\n', real: g[0].path },
        { target: g[1], raw: null, real: g[1].path },
        { target: g[2], raw: null, real: g[2].path }
      ],
      '/Users/x'
    )
    expect(out.map((t) => t.target.path)).toEqual([
      '/Users/x/.codex/AGENTS.md',
      '/Users/x/.copilot/copilot-instructions.md'
    ])
    expect(out[0].target.agents).toEqual(['claude', 'codex'])
    expect(out[1].readBy).toEqual([])
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

  it('writes nothing into a CLAUDE.md that imports AGENTS.md — Claude reads it there', () => {
    const claude = '# Repo\n\nThe rules: @AGENTS.md\n'
    writeFileSync(claudeMd(), claude)
    saveBaseline(repo, BASE)
    const state = getInstructions(repo)
    expect(state.files.map((f) => [f.path, f.agents, f.status])).toEqual([
      [agentsMd(), ['claude', 'codex', 'copilot'], 'missing']
    ])
    expect(state.files[0].readBy).toEqual([{ path: claudeMd(), how: 'import' }])

    applyInstructions(repo)
    expect(readFileSync(claudeMd(), 'utf8')).toBe(claude)
    expect(extractSharedBlock(readFileSync(agentsMd(), 'utf8'))).toBe(BASE)
    expect(getInstructions(repo).files.map((f) => f.status)).toEqual(['synced'])
    expect(() => applyInstructions(repo, claudeMd())).toThrow(/reads its block through/)
  })

  it('a CLAUDE.md that is a link to AGENTS.md is one row, written once', () => {
    writeFileSync(agentsMd(), '# AGENTS\n')
    symlinkSync('AGENTS.md', claudeMd())
    saveBaseline(repo, BASE)
    const state = getInstructions(repo)
    expect(state.files.map((f) => f.path)).toEqual([agentsMd()])
    expect(state.files[0].readBy).toEqual([{ path: claudeMd(), how: 'link' }])
    expect(state.files[0].agents).toEqual(['claude', 'codex', 'copilot'])
    applyInstructions(repo)
    expect(count(readFileSync(agentsMd(), 'utf8'), START)).toBe(1)
    expect(getInstructions(repo).files.map((f) => f.status)).toEqual(['synced'])
  })

  it('apply renames the older markers and folds a doubled block, file by file', () => {
    // CLAUDE.md as an earlier Cockpit left it; AGENTS.md after the plugin and that
    // Cockpit each appended a copy of their own
    const own = '# Repo rules\n\nRun the tests first.\n'
    writeFileSync(claudeMd(), `${own}\n${LEGACY_START}\n${BASE}\n${LEGACY_END}\n`)
    writeFileSync(agentsMd(), `${START}\n${BASE}\n${END}\n\n${LEGACY_START}\n${BASE}\n${LEGACY_END}\n`)
    saveBaseline(repo, BASE)

    const before = getInstructions(repo)
    expect(before.files.map((f) => [f.status, f.duplicates])).toEqual([
      ['synced', 0],
      ['drifted', 1]
    ])

    const after = applyInstructions(repo)
    expect(after.files.map((f) => [f.status, f.duplicates])).toEqual([
      ['synced', 0],
      ['synced', 0]
    ])
    expect(readFileSync(claudeMd(), 'utf8')).toBe(`${own}\n${START}\n${BASE}\n${END}\n`)
    expect(readFileSync(agentsMd(), 'utf8')).toBe(`${START}\n${BASE}\n${END}\n`)
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

  it('adopts a block an earlier Cockpit wrote just the same', () => {
    writeFileSync(join(repo, 'CLAUDE.md'), `# Repo rules\n\n${LEGACY_START}\n${BASE}\n${LEGACY_END}\n`)
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
