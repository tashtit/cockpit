import { statSync } from 'node:fs'
import type { HandoffBriefing, Provider, SessionMeta } from '../shared/types'
import type { SessionIndexer } from './indexer'
import { execText } from './env'
import {
  buildHandoffBriefing,
  buildSummarizeCommand,
  composeImprovedBriefing
} from './handoff-core'
import type { GitSnapshot, HandoffSourceInfo } from './handoff-core'
import { parseClaudeStreamLine, parseCodexStreamLine } from './chat'
import { listModelEndpoints, loadConfig, sessionEndpointFor } from './config'
import { getEndpointKey } from './secrets'
import { endpointEnv } from '../shared/endpoints'

/**
 * IO around handoff-core: indexer lookups, git snapshots, and the "Improve with
 * AI" resume of the source CLI. The briefing itself is built by the pure core.
 */

function sourceInfo(meta: SessionMeta): HandoffSourceInfo {
  return { provider: meta.provider, title: meta.title, cwd: meta.cwd, branch: meta.gitBranch }
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
  const run = async (args: string[]): Promise<string | null> => {
    const r = await execText('git', args, { cwd, timeoutMs: 5_000 })
    return r.ok ? r.stdout : null
  }
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
function summarizeEnv(meta: SessionMeta): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  const src = loadConfig().sources.find(
    (s) => s.provider === meta.provider && s.label === meta.source
  )
  if (src) {
    if (meta.provider === 'claude') env['CLAUDE_CONFIG_DIR'] = src.path
    else if (meta.provider === 'codex') env['CODEX_HOME'] = src.path
    else env['COPILOT_HOME'] = src.path
  }
  const endpointId = sessionEndpointFor(meta.id)
  if (endpointId) {
    const ep = listModelEndpoints().find((e) => e.id === endpointId)
    if (!ep) {
      throw new Error(
        'This session runs on a custom model provider that is no longer configured — re-add it, or use the extracted briefing.'
      )
    }
    Object.assign(env, endpointEnv(meta.provider, ep, ep.hasKey ? getEndpointKey(ep.id) : undefined))
  }
  return env
}

/** Collect the assistant's text out of a stream-json transcript on stdout. */
function textFromStream(provider: Provider, stdout: string): string {
  if (provider === 'copilot') return stdout.trim()
  const parse = provider === 'claude' ? parseClaudeStreamLine : parseCodexStreamLine
  const texts: string[] = []
  let error: string | null = null
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (line === '') continue
    let obj: unknown
    try {
      obj = JSON.parse(line)
    } catch {
      continue
    }
    for (const ev of parse('handoff-summarize', obj)) {
      if (ev.type === 'text') texts.push(ev.text)
      if (ev.type === 'error') error = ev.message
    }
  }
  if (texts.length === 0 && error !== null) throw new Error(error)
  return texts.join('\n').trim()
}

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
  const meta = indexer.getSession(sessionId)
  if (!meta) throw new Error('Unknown session — it may not be indexed yet.')
  const cwd = meta.cwd
  if (cwd === null || !dirExists(cwd)) {
    throw new Error('The working directory no longer exists — handoff needs it.')
  }
  const { cmd, args } = buildSummarizeCommand(meta.provider, meta.nativeId)
  const env = summarizeEnv(meta)
  const r = await execText(cmd, args, { cwd, timeoutMs: 120_000, env })
  if (!r.ok) {
    const detail = (r.stderr.trim() || r.error || 'unknown error').slice(0, 500)
    throw new Error(`${cmd} could not summarize the session: ${detail}`)
  }
  const aiText = textFromStream(meta.provider, r.stdout)
  if (aiText === '') throw new Error(`${cmd} returned no briefing text.`)
  return composeImprovedBriefing(sourceInfo(meta), aiText, await gitSnapshot(cwd))
}
