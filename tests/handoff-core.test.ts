import { describe, it, expect } from 'vitest'
import {
  BRIEFING_MAX_CHARS,
  buildGitSection,
  buildHandoffBriefing,
  buildSummarizeCommand,
  composeImprovedBriefing,
  SUMMARIZE_PROMPT
} from '../src/main/handoff-core'
import type { GitSnapshot, HandoffSourceInfo } from '../src/main/handoff-core'
import type { SessionMessage } from '../src/shared/types'

const source: HandoffSourceInfo = {
  provider: 'claude',
  title: 'Fix the flaky indexer test',
  cwd: '/tmp/wt/fix-flaky',
  branch: 'cockpit/fix-flaky'
}

const git: GitSnapshot = {
  branch: 'cockpit/fix-flaky\n',
  status: ' M src/main/indexer.ts\n?? notes.md\n',
  diffStat: ' src/main/indexer.ts | 12 ++--\n 1 file changed, 8 insertions(+), 4 deletions(-)\n',
  log: 'abc1234 fix(indexer): stabilise watcher\n'
}

const msg = (over: Partial<SessionMessage>): SessionMessage => ({
  role: 'user',
  kind: 'text',
  text: 'hello',
  ...over
})

const transcript: SessionMessage[] = [
  msg({ role: 'user', text: 'Please fix the flaky indexer test' }),
  msg({ role: 'assistant', text: 'Looking at the watcher debounce now.' }),
  msg({ role: 'assistant', kind: 'tool_call', toolName: 'Bash', text: '{"command":"npm test"}', preview: 'npm test' }),
  msg({ role: 'tool', kind: 'tool_result', text: '2 passed' }),
  msg({ role: 'assistant', kind: 'reasoning', text: 'thinking about mtimes' }),
  msg({ role: 'assistant', text: 'Found it — the cache tmp name races.' })
]

describe('buildHandoffBriefing', () => {
  it('includes task, conversation, actions, and git state; excludes reasoning/tool_result', () => {
    const { briefing, warnings } = buildHandoffBriefing(source, transcript, git)
    expect(briefing).toContain('## Original request')
    expect(briefing).toContain('Please fix the flaky indexer test')
    expect(briefing).toContain('Assistant: Looking at the watcher debounce now.')
    expect(briefing).toContain('- Bash: npm test')
    expect(briefing).toContain(' M src/main/indexer.ts')
    expect(briefing).toContain('Recent commits')
    expect(briefing).toContain('Claude Code')
    expect(briefing).toContain('- Branch: cockpit/fix-flaky')
    expect(briefing).not.toContain('thinking about mtimes')
    expect(briefing).not.toContain('2 passed')
    expect(warnings).toEqual([])
  })

  it('the original request is not repeated inside recent conversation', () => {
    const { briefing } = buildHandoffBriefing(source, transcript, git)
    const hits = briefing.split('Please fix the flaky indexer test').length - 1
    expect(hits).toBe(1)
  })

  it('caps conversation at 10 with an omitted marker', () => {
    const many: SessionMessage[] = [
      msg({ role: 'user', text: 'the task' }),
      ...Array.from({ length: 25 }, (_, i) => msg({ role: 'assistant', text: `reply ${i}` }))
    ]
    const { briefing } = buildHandoffBriefing(source, many, git)
    expect(briefing).toContain('(15 earlier messages omitted)')
    expect(briefing).not.toContain('reply 14')
    expect(briefing).toContain('reply 15')
    expect(briefing).toContain('reply 24')
  })

  it('caps actions at 15 with an omitted marker', () => {
    const many: SessionMessage[] = [
      msg({ role: 'user', text: 'the task' }),
      ...Array.from({ length: 40 }, (_, i) =>
        msg({ role: 'assistant', kind: 'tool_call', toolName: 'Edit', text: `edit ${i}` })
      )
    ]
    const { briefing } = buildHandoffBriefing(source, many, git)
    expect(briefing).toContain('(25 earlier actions omitted)')
    expect(briefing).not.toContain('edit 24')
    expect(briefing).toContain('edit 25')
  })

  it('works on a copilot-shaped transcript (no tool_result, no reasoning)', () => {
    const copilot: SessionMessage[] = [
      msg({ role: 'user', text: 'ship the fix' }),
      msg({ role: 'assistant', kind: 'tool_call', toolName: 'bash', text: 'git commit' }),
      msg({ role: 'assistant', text: 'done' })
    ]
    const { briefing, warnings } = buildHandoffBriefing({ ...source, provider: 'copilot' }, copilot, git)
    expect(briefing).toContain('(Copilot)')
    expect(briefing).toContain('- bash: git commit')
    expect(warnings).toEqual([])
  })

  it('empty transcript produces a warning and a placeholder', () => {
    const { briefing, warnings } = buildHandoffBriefing(source, [], git)
    expect(briefing).toContain('(no transcript could be read for this session)')
    expect(warnings.some((w) => w.includes('No transcript'))).toBe(true)
  })

  it('surfaces the parsers’ tail-truncation marker as a warning', () => {
    const truncated: SessionMessage[] = [
      { role: 'system', kind: 'system', text: '(older messages omitted — transcript is very large)' },
      msg({ role: 'user', text: 'the task' })
    ]
    const { warnings } = buildHandoffBriefing(source, truncated, git)
    expect(warnings.some((w) => w.includes('very large'))).toBe(true)
  })

  it('missing cwd (git null) yields an unavailable section and warning', () => {
    const { briefing, warnings } = buildHandoffBriefing(source, transcript, null)
    expect(briefing).toContain('(unavailable — the working directory no longer exists)')
    expect(warnings.some((w) => w.includes('no longer exists'))).toBe(true)
  })

  it('all git commands failing yields the not-a-repo warning', () => {
    const dead: GitSnapshot = { branch: null, status: null, diffStat: null, log: null }
    const { briefing, warnings } = buildHandoffBriefing(source, transcript, dead)
    expect(briefing).toContain('not a git repository')
    expect(warnings.some((w) => w.includes('could not be read'))).toBe(true)
  })

  it('partial git failure marks only the failed block', () => {
    const partial: GitSnapshot = { ...git, log: null }
    const { briefing, warnings } = buildHandoffBriefing(source, transcript, partial)
    expect(briefing).toContain(' M src/main/indexer.ts')
    expect(briefing).toContain('Recent commits (git log --oneline -5):\n(unavailable)')
    expect(warnings).toEqual([])
  })

  it('a clean tree says so and omits the diff block', () => {
    const clean: GitSnapshot = { ...git, status: '', diffStat: '' }
    const { briefing } = buildHandoffBriefing(source, transcript, clean)
    expect(briefing).toContain('(clean — no uncommitted changes)')
    expect(briefing).not.toContain('Working-tree diff')
  })

  it('long status output is line-capped with a count', () => {
    const lines = Array.from({ length: 60 }, (_, i) => ` M file-${i}.ts`).join('\n')
    const { briefing } = buildHandoffBriefing(source, transcript, { ...git, status: lines })
    expect(briefing).toContain(' M file-39.ts')
    expect(briefing).not.toContain(' M file-40.ts')
    expect(briefing).toContain('… (+20 more lines)')
  })

  it('stays within the size budget, dropping oldest content first', () => {
    const huge: SessionMessage[] = [
      msg({ role: 'user', text: 'the task. ' + 'x'.repeat(1500) }),
      ...Array.from({ length: 10 }, (_, i) => msg({ role: 'assistant', text: `reply ${i} ` + 'y'.repeat(1600) })),
      ...Array.from({ length: 15 }, () => msg({ kind: 'tool_call', toolName: 'Bash', text: 'z'.repeat(300) }))
    ]
    // per-message caps bound the transcript's share, so the overflow vector is a
    // status block with long paths: 40 kept lines × 300 chars ≈ 12K on its own
    const bigStatus = Array.from({ length: 45 }, (_, i) => ` M ${'d/'.repeat(148)}f${i}.ts`).join('\n')
    const { briefing, warnings } = buildHandoffBriefing(source, huge, { ...git, status: bigStatus })
    expect(briefing.length).toBeLessThan(BRIEFING_MAX_CHARS + 100)
    expect(briefing).toContain('(briefing truncated to fit)')
    expect(warnings.some((w) => w.includes('truncated'))).toBe(true)
    // the newest reply survives the oldest-first drop
    expect(briefing).toContain('reply 9')
  })

  it('is deterministic', () => {
    const a = buildHandoffBriefing(source, transcript, git)
    const b = buildHandoffBriefing(source, transcript, git)
    expect(a).toEqual(b)
  })
})

describe('buildSummarizeCommand', () => {
  it('claude resumes with stream-json and the prompt last', () => {
    const { cmd, args } = buildSummarizeCommand('claude', 'abc-123')
    expect(cmd).toBe('claude')
    expect(args).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--resume', 'abc-123', SUMMARIZE_PROMPT
    ])
  })

  it('codex resumes read-only with --json', () => {
    const { cmd, args } = buildSummarizeCommand('codex', 'abc-123')
    expect(cmd).toBe('codex')
    expect(args).toEqual([
      'exec', 'resume', 'abc-123', '--json', '-c', 'sandbox_mode="read-only"', SUMMARIZE_PROMPT
    ])
  })

  it('copilot resumes in plain print mode without tool approval flags', () => {
    const { cmd, args } = buildSummarizeCommand('copilot', 'abc-123')
    expect(cmd).toBe('copilot')
    expect(args).toEqual(['-p', SUMMARIZE_PROMPT, '--resume', 'abc-123'])
    expect(args).not.toContain('--allow-all-tools')
  })

  it('refuses a malformed native id', () => {
    expect(() => buildSummarizeCommand('claude', '--rm -rf')).toThrow('malformed')
    expect(() => buildSummarizeCommand('claude', '')).toThrow('malformed')
  })
})

describe('composeImprovedBriefing', () => {
  it('frames the AI text with the standard preamble and regenerated git facts', () => {
    const out = composeImprovedBriefing(source, '## Current state\n\nAll tests green.', git)
    expect(out).toContain('# Handoff briefing')
    expect(out).toContain('All tests green.')
    expect(out).toContain(' M src/main/indexer.ts')
    expect(out).toContain('## Instructions')
  })

  it('caps oversized AI output', () => {
    const out = composeImprovedBriefing(source, 'w'.repeat(40_000), git)
    expect(out.length).toBeLessThan(BRIEFING_MAX_CHARS + 100)
  })
})
