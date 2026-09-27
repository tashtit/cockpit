import { statSync } from 'node:fs'
import type { HandoffBriefing, Provider, SessionMeta } from '../shared/types'
import type { SessionIndexer } from './indexer'
import { execOrThrow, gitRead } from './env'
import {
  buildHandoffBriefing,
  buildSummarizeCommand,
  composeImprovedBriefing
} from './handoff-core'
import type { GitSnapshot, HandoffSourceInfo } from './handoff-core'
import { parseClaudeStreamLine, parseCodexStreamLine } from './chat'
import { listModelEndpoints, sessionEndpointFor, sourceFor } from './config'
import { getEndpointKey } from './secrets'
import { parseJsonlText } from './parsers/util'
import { endpointEnv } from '../shared/endpoints'
import { CONFIG_HOME_VAR, isDrivable } from '../shared/providers'

/**
 * IO around handoff-core: indexer lookups, git snapshots, and the "Improve with
 * AI" resume of the source CLI. The briefing itself is built by the pure core.
 */

function sourceInfo(meta: SessionMeta): HandoffSourceInfo {
  return {
    provider: meta.provider,
    title: meta.title,
    cwd: meta.cwd,
    branch: meta.gitBranch ?? null
  }
}

function dirExists(cwd: string): boolean {
  try {
    return statSync(cwd).isDirectory()
  } catch {
    return false
  }
}

/** Four independent probes, each fail-soft — a session cwd may be a deleted worktree. */
async function gitSnapshot(cwd: string): Promise<GitSnapshot> {
  // read-only: a plain status refreshes the index under index.lock, in a worktree
  // whose agent may be committing right now
  const run = (args: readonly string[]): Promise<string | null> => gitRead(cwd, args, { timeoutMs: 5_000 })
  const [branch, status, diffStat, log] = await Promise.all([
    run(['rev-parse', '--abbrev-ref', 'HEAD']),
    run(['status', '--porcelain']),
    run(['diff', '--stat', 'HEAD']),
    run(['log', '--oneline', '-5'])
  ])
  return { branch, status, diffStat, log }
}

export async function getHandoffBriefing(
  indexer: SessionIndexer,
  sessionId: string
): Promise<HandoffBriefing> {
  const meta = indexer.getSession(sessionId)
  if (!meta) throw new Error('Unknown session — it may not be indexed yet.')
  const messages = indexer.getMessages(sessionId)
  const cwd = meta.cwd
  const git = cwd !== null && dirExists(cwd) ? await gitSnapshot(cwd) : null
  const { briefing, warnings } = buildHandoffBriefing(sourceInfo(meta), messages, git)
  return { briefing, cwdExists: git !== null, ...(warnings.length > 0 ? { warnings } : {}) }
}

/**
 * Env for resuming this session's CLI outside ChatManager: the account's config
 * home plus, for BYOK-bound sessions, the endpoint env. A removed endpoint
 * refuses loudly — same contract as resuming the session itself.
 */
function summarizeEnv(meta: SessionMeta, provider: Provider): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  const src = sourceFor(meta)
  if (src) env[CONFIG_HOME_VAR[provider]] = src.path
  const endpointId = sessionEndpointFor(meta.id)
  if (endpointId) {
    const ep = listModelEndpoints().find((e) => e.id === endpointId)
    if (!ep) {
      throw new Error(
        'This session runs on a custom model provider that is no longer configured — re-add it, or use the extracted briefing.'
      )
    }
    Object.assign(env, endpointEnv(provider, ep, ep.hasKey ? getEndpointKey(ep.id) : undefined))
  }
  return env
}

/** Collect the assistant's text out of a stream-json transcript on stdout. */
function textFromStream(provider: Provider, stdout: string): string {
  if (provider === 'copilot') return stdout.trim()
  const parse = provider === 'claude' ? parseClaudeStreamLine : parseCodexStreamLine
  const texts: string[] = []
  let error: string | null = null
  for (const obj of parseJsonlText(stdout, false)) {
    for (const ev of parse('handoff-summarize', obj)) {
      if (ev.type === 'text') texts.push(ev.text)
      if (ev.type === 'error') error = ev.message
    }
  }
  if (texts.length === 0 && error !== null) throw new Error(error)
  return texts.join('\n').trim()
}

/** Sessions an "Improve with AI" resume is running against right now. */
const improving = new Set<string>()

/**
 * "Improve with AI": resume the source session read-only and let its own agent —
 * which still has full native context — write the briefing narrative. Git facts
 * are re-extracted mechanically so the model cannot misstate repository state.
 * Side effect, inherent to resume: the exchange lands in the source transcript
 * (and claude may mint a sibling session id, as it does for any resumed turn).
 */
export async function improveHandoffBriefing(
  indexer: SessionIndexer,
  sessionId: string
): Promise<string> {
  // one resume at a time per session: a second click would be a second writer on
  // the same log, which is what ChatManager's one-turn rule exists to prevent
  if (improving.has(sessionId)) throw new Error('Already asking this session for a briefing.')
  improving.add(sessionId)
  try {
    return await improve(indexer, sessionId)
  } finally {
    improving.delete(sessionId)
  }
}

async function improve(indexer: SessionIndexer, sessionId: string): Promise<string> {
  const meta = indexer.getSession(sessionId)
  if (!meta) throw new Error('Unknown session — it may not be indexed yet.')
  const provider = meta.provider
  if (!isDrivable(provider)) {
    throw new Error('Improving the briefing resumes the source agent’s own CLI, which Cockpit does not run for this agent — use the extracted briefing.')
  }
  const cwd = meta.cwd
  if (cwd === null || !dirExists(cwd)) {
    throw new Error('The working directory no longer exists — handoff needs it.')
  }
  const { cmd, args } = buildSummarizeCommand(provider, meta.nativeId)
  const env = summarizeEnv(meta, provider)
  const stdout = await execOrThrow(cmd, args, {
    cwd,
    timeoutMs: 120_000,
    env,
    failure: (r) => `${cmd} could not summarize the session: ${(r.stderr.trim() || r.error || 'unknown error').slice(0, 500)}`
  })
  const aiText = textFromStream(provider, stdout)
  if (aiText === '') throw new Error(`${cmd} returned no briefing text.`)
  return composeImprovedBriefing(sourceInfo(meta), aiText, await gitSnapshot(cwd))
}
