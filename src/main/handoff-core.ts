import type { Provider, SessionMessage } from '../shared/types'
import { capText, truncate } from './parsers/util'
import { isValidNativeId } from './chat'

/**
 * Pure handoff logic: turn a parsed transcript + a git snapshot into the context
 * briefing that seeds the target agent's first prompt. No IO here — handoff.ts
 * owns the indexer lookup and the git/CLI calls (the instructions-core pattern).
 * Deliberately timestamp-free so identical inputs give identical briefings.
 */

export type GitSnapshot = {
  /** Each field is the raw stdout of one git command; null = that command failed */
  readonly branch: string | null
  readonly status: string | null
  readonly diffStat: string | null
  readonly log: string | null
}

export type HandoffSourceInfo = {
  readonly provider: Provider
  readonly title: string
  readonly cwd: string | null
  readonly branch: string | null
}

/**
 * The briefing rides to the CLI as one positional argv entry. macOS ARG_MAX is
 * ~1MB for argv+env combined, so 18K is two orders of magnitude under it — if
 * this cap is ever raised past ~100K, switch the spawn to stdin instead.
 */
export const BRIEFING_MAX_CHARS = 18_000

const TASK_CAP = 2_000
const CONVO_MESSAGES = 10
const CONVO_EACH = 700
const ACTIONS = 15
const ACTION_EACH = 120
const STATUS_LINES = 40
const DIFFSTAT_LINES = 21

const AGENT_NAME: Record<Provider, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  copilot: 'Copilot'
}

function preamble(provider: Provider): string {
  return (
    '# Handoff briefing\n\n' +
    `You are taking over an in-progress task from another AI coding agent (${AGENT_NAME[provider]}). ` +
    'You are working in the SAME directory and on the SAME branch that agent used — its ' +
    'work is already on disk. Do not clone anything, create branches, or redo completed ' +
    'work. Verify the state below against the repository, then continue.'
  )
}

function sessionSection(source: HandoffSourceInfo): string {
  return [
    '## Session',
    '',
    `- From: ${AGENT_NAME[source.provider]}`,
    `- Task: ${source.title || '(untitled)'}`,
    `- Directory: ${source.cwd ?? '(unknown)'}`,
    `- Branch: ${source.branch ?? '(unknown)'}`
  ].join('\n')
}

const INSTRUCTIONS =
  '## Instructions\n\n' +
  'Continue this task in the current working directory. Start by verifying the state — ' +
  'run `git status` and the project’s checks. The digest above is truncated; where it ' +
  'disagrees with the repository, trust the repository.'

function fenced(body: string): string {
  return '```\n' + body + '\n```'
}

/** First N lines plus an explicit count of what was dropped. */
function headLines(text: string, max: number): string {
  const lines = text.split('\n')
  if (lines.length <= max) return text
  return [...lines.slice(0, max), `… (+${lines.length - max} more lines)`].join('\n')
}

/** diff --stat: keep the leading file lines and the trailing summary line. */
function diffStatLines(text: string): string {
  const lines = text.split('\n')
  if (lines.length <= DIFFSTAT_LINES) return text
  const summary = lines[lines.length - 1]
  const shown = lines.slice(0, DIFFSTAT_LINES - 1)
  return [...shown, `… (+${lines.length - shown.length - 1} more files)`, summary].join('\n')
}

/**
 * The git facts of the briefing, regenerated verbatim for AI-improved briefings
 * so a model can never hallucinate repository state.
 */
export function buildGitSection(git: GitSnapshot | null): { section: string; warnings: string[] } {
  if (git === null) {
    return {
      section: '## Git state\n\n(unavailable — the working directory no longer exists)',
      warnings: ['The working directory no longer exists — its git state is unavailable.']
    }
  }
  const allFailed =
    git.branch === null && git.status === null && git.diffStat === null && git.log === null
  if (allFailed) {
    return {
      section: '## Git state\n\n(unavailable — not a git repository, or git failed)',
      warnings: ['Git state could not be read (not a git repository, or git failed).']
    }
  }
  const parts: string[] = ['## Git state', '']
  const status = git.status?.trimEnd() ?? null
  parts.push('Uncommitted changes (git status --porcelain):')
  parts.push(
    status === null
      ? '(unavailable)'
      : status === ''
        ? '(clean — no uncommitted changes)'
        : fenced(headLines(status, STATUS_LINES))
  )
  const diffStat = git.diffStat?.trimEnd() ?? null
  if (diffStat !== null && diffStat !== '') {
    parts.push('', 'Working-tree diff (git diff --stat HEAD):', fenced(diffStatLines(diffStat)))
  }
  const log = git.log?.trimEnd() ?? null
  parts.push('', 'Recent commits (git log --oneline -5):')
  parts.push(log === null || log === '' ? '(unavailable)' : fenced(log))
  return { section: parts.join('\n'), warnings: [] }
}

type Digest = {
  readonly original: SessionMessage | null
  readonly conversation: SessionMessage[]
  readonly omittedConversation: number
  readonly actions: SessionMessage[]
  readonly omittedActions: number
}

function digest(messages: readonly SessionMessage[], convoCount: number, actionCount: number): Digest {
  const texts = messages.filter(
    (m) => m.kind === 'text' && (m.role === 'user' || m.role === 'assistant') && m.text.trim() !== ''
  )
  const original = texts.find((m) => m.role === 'user') ?? null
  const rest = original === null ? texts : texts.filter((m) => m !== original)
  const conversation = rest.slice(Math.max(0, rest.length - convoCount))
  const tools = messages.filter((m) => m.kind === 'tool_call')
  const actions = tools.slice(Math.max(0, tools.length - actionCount))
  return {
    original,
    conversation,
    omittedConversation: rest.length - conversation.length,
    actions,
    omittedActions: tools.length - actions.length
  }
}

function conversationSection(d: Digest): string {
  const parts: string[] = ['## Recent conversation (oldest first)', '']
  if (d.omittedConversation > 0) parts.push(`(${d.omittedConversation} earlier messages omitted)`, '')
  for (const m of d.conversation) {
    parts.push(`${m.role === 'user' ? 'User' : 'Assistant'}: ${capText(m.text.trim(), CONVO_EACH)}`, '')
  }
  return parts.join('\n').trimEnd()
}

function actionsSection(d: Digest): string {
  const parts: string[] = ['## Recent agent actions', '']
  if (d.omittedActions > 0) parts.push(`(${d.omittedActions} earlier actions omitted)`)
  for (const m of d.actions) {
    parts.push(`- ${m.toolName ?? 'tool'}: ${truncate(m.preview ?? m.text, ACTION_EACH)}`)
  }
  return parts.join('\n')
}

function assemble(source: HandoffSourceInfo, d: Digest, gitSection: string): string {
  const parts: string[] = [preamble(source.provider), sessionSection(source)]
  parts.push(
    '## Original request\n\n' +
      (d.original === null
        ? '(no transcript could be read for this session)'
        : capText(d.original.text.trim(), TASK_CAP))
  )
  if (d.conversation.length > 0) parts.push(conversationSection(d))
  if (d.actions.length > 0) parts.push(actionsSection(d))
  parts.push(gitSection, INSTRUCTIONS)
  return parts.join('\n\n')
}

export function buildHandoffBriefing(
  source: HandoffSourceInfo,
  messages: readonly SessionMessage[],
  git: GitSnapshot | null
): { briefing: string; warnings: string[] } {
  const warnings: string[] = []
  const gitPart = buildGitSection(git)
  warnings.push(...gitPart.warnings)
  if (!messages.some((m) => m.kind === 'text' && m.text.trim() !== '')) {
    warnings.push('No transcript could be read for this session — the briefing has no conversation context.')
  }
  // the parsers prepend this marker when the 4MB tail-read dropped older lines
  if (messages.some((m) => m.kind === 'system' && m.text.includes('older messages omitted'))) {
    warnings.push('Transcript is very large — the digest covers only its most recent part.')
  }

  // over budget: drop conversation oldest-first, then actions, then hard-cap
  let convoCount = CONVO_MESSAGES
  let actionCount = ACTIONS
  let briefing = assemble(source, digest(messages, convoCount, actionCount), gitPart.section)
  while (briefing.length > BRIEFING_MAX_CHARS && convoCount > 0) {
    convoCount--
    briefing = assemble(source, digest(messages, convoCount, actionCount), gitPart.section)
  }
  while (briefing.length > BRIEFING_MAX_CHARS && actionCount > 0) {
    actionCount--
    briefing = assemble(source, digest(messages, convoCount, actionCount), gitPart.section)
  }
  if (briefing.length > BRIEFING_MAX_CHARS) briefing = capText(briefing, BRIEFING_MAX_CHARS)
  if (convoCount < CONVO_MESSAGES || actionCount < ACTIONS) {
    briefing += '\n\n(briefing truncated to fit)'
    warnings.push('The briefing was truncated to fit the size budget.')
  }
  return { briefing, warnings }
}

/** What the source agent is asked when the user clicks "Improve with AI". */
export const SUMMARIZE_PROMPT =
  'You are handing this coding session off to another AI agent that will continue your ' +
  'work in the same directory on the same branch. Write a handoff briefing in markdown ' +
  'with exactly these sections: "## Original request", "## Current state", ' +
  '"## What has been done", "## What remains", "## Gotchas". Be specific about files, ' +
  'commands, and decisions. Do not include git status output — it is appended ' +
  'mechanically. Do not run any tools. Reply with ONLY the briefing text.'

/**
 * The resume invocation that asks the source CLI to write the briefing itself.
 * Always read-only / safe mode — a summary must never be able to touch the tree.
 */
export function buildSummarizeCommand(
  provider: Provider,
  nativeId: string
): { cmd: string; args: string[] } {
  if (!isValidNativeId(nativeId)) throw new Error('malformed session id')
  switch (provider) {
    case 'claude':
      return {
        cmd: 'claude',
        args: ['-p', '--output-format', 'stream-json', '--verbose', '--resume', nativeId, SUMMARIZE_PROMPT]
      }
    case 'codex':
      return {
        cmd: 'codex',
        args: ['exec', 'resume', nativeId, '--json', '-c', 'sandbox_mode="read-only"', SUMMARIZE_PROMPT]
      }
    case 'copilot':
      return { cmd: 'copilot', args: ['-p', SUMMARIZE_PROMPT, '--resume', nativeId] }
  }
}

/**
 * AI narrative + mechanically regenerated git facts. The model's text is framed by
 * the same preamble/instructions as the deterministic briefing so the target agent
 * gets identical ground rules either way.
 */
export function composeImprovedBriefing(
  source: HandoffSourceInfo,
  aiText: string,
  git: GitSnapshot | null
): string {
  const body = [
    preamble(source.provider),
    sessionSection(source),
    aiText.trim(),
    buildGitSection(git).section,
    INSTRUCTIONS
  ].join('\n\n')
  return capText(body, BRIEFING_MAX_CHARS)
}
