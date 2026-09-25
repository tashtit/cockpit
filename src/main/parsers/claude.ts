import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, sep } from 'node:path'
import type { SessionMeta, SessionMessage } from '../../shared/types'
import { parseAsks } from '../../shared/asks'
import { publishedUrl, toolArtifact } from './artifacts'
import { checkOutcome, exitCodeIn } from './checks'
import {
  capText,
  contentToText,
  fileTimes,
  parseJsonlText,
  readHead,
  readJsonlTail,
  readTail,
  toMs,
  toolPreview,
  TRANSCRIPT_TAIL_BYTES,
  truncate,
  walkFiles
} from './util'

/** Meta lives in the first lines (summary/cwd/branch/first prompt) — never read the whole log. */
const META_HEAD_BYTES = 256 * 1024
/** Title lines are re-appended as the session grows — the newest ones live near the end. */
const TITLE_TAIL_BYTES = 64 * 1024

/**
 * Claude Code sessions: <configDir>/projects/<sanitized-cwd>/<session-uuid>.jsonl
 * Each line: { type: "user"|"assistant"|"summary"|"system"|..., message?, timestamp?, sessionId?, cwd?, gitBranch? }
 */
/** Only these dirs get walked/watched — never the whole config dir. */
export function listClaudeSessionRoots(sourceDir: string): string[] {
  return [join(sourceDir, 'projects')]
}

export function listClaudeSessionFiles(sourceDir: string): string[] {
  return walkFiles(join(sourceDir, 'projects'), 3).filter(
    // <proj>/<session-id>/subagents/**: sidechain transcripts (Task-tool agents,
    // workflow runs) — parts of a session, never sessions themselves
    (f) => f.endsWith('.jsonl') && !f.includes(`${sep}subagents${sep}`)
  )
}

export function listClaudeSessions(sourceDir: string, sourceLabel: string): SessionMeta[] {
  const files = listClaudeSessionFiles(sourceDir)
  const out: SessionMeta[] = []
  for (const file of files) {
    const meta = parseClaudeMeta(file, sourceLabel)
    if (meta) out.push(meta)
  }
  return out
}

export function parseClaudeMeta(file: string, sourceLabel: string): SessionMeta | null {
  const head = readHead(file, META_HEAD_BYTES)
  if (!head.text) return null
  const lines = parseJsonlText(head.text, head.truncated)
  // a truncated head can legitimately yield nothing (one preamble line larger than
  // the window) — the tail pass below still gets a chance to identify the session
  if (lines.length === 0 && !head.truncated) return null
  const nativeId = basename(file, '.jsonl')

  let cwd: string | null = null
  let logBranch: string | null = null
  // Generated names: custom-title (user-set) beats ai-title beats legacy summary
  // beats first-prompt fallback. Later lines supersede earlier ones.
  let customTitle = ''
  let aiTitle = ''
  let summary = ''
  let firstPrompt = ''
  let firstTs: number | null = null
  let lastTs: number | null = null
  let messageCount = 0

  const scanTitles = (l: any): void => {
    if (l.type === 'custom-title' && typeof l.customTitle === 'string') customTitle = l.customTitle
    if (l.type === 'ai-title' && typeof l.aiTitle === 'string') aiTitle = l.aiTitle
    if (l.type === 'summary' && typeof l.summary === 'string') summary = l.summary
  }

  // Sidechain FILES (Task-tool/workflow agents) mark lines isSidechain from the
  // first entry; older CLIs also inlined sidechain lines into real sessions, so
  // only the first flag decides — a true after a false is an inline, not a file.
  let sidechain: boolean | null = null

  const scan = (l: any): void => {
    if (sidechain === null && typeof l.isSidechain === 'boolean') sidechain = l.isSidechain
    // strings only: a cwd of another type reached the repo resolver and threw there,
    // outside the parser's own failure tolerance, on every scan
    if (typeof l.cwd === 'string' && l.cwd && !cwd) cwd = l.cwd
    if (typeof l.gitBranch === 'string' && l.gitBranch && !logBranch) logBranch = l.gitBranch
    const ts = toMs(l.timestamp)
    if (ts) {
      if (!firstTs) firstTs = ts
      lastTs = ts
    }
    scanTitles(l)
    if (l.type === 'user' || l.type === 'assistant') {
      messageCount++
      if (!firstPrompt && l.type === 'user') {
        const t = contentToText(l.message?.content)
        if (t && !t.startsWith('<')) firstPrompt = truncate(t)
      }
    }
  }

  for (const l of lines) scan(l)

  if (head.truncated) {
    const tail = readTail(file, TITLE_TAIL_BYTES)
    const tailLines = tail.text
      ? parseJsonlText(tail.truncated ? tail.text.slice(tail.text.indexOf('\n') + 1) : tail.text, false)
      : []
    // Messages can sit entirely past the head window when the file opens with a
    // large preamble (summary / file-history-snapshot entries). The tail is then
    // the only evidence this is a session at all, so count and extrapolate there.
    const fromTail = messageCount === 0
    // the tail is the wrong place to learn when a session STARTED — a head made
    // only of summary/snapshot lines carries no timestamps, so adopting the
    // tail's would collapse startedAt onto updatedAt. Keep the head's verdict.
    const headFirstTs = firstTs
    if (fromTail) for (const l of tailLines) scan(l)
    // otherwise just the titles: the current one may have been re-appended late
    else for (const l of tailLines) scanTitles(l)
    firstTs = headFirstTs
    // scale by the window the count actually came from, over the region that
    // window represents — the head covers the file from byte 0, while the tail
    // only speaks for the part the head already proved holds no messages
    const window = fromTail ? TITLE_TAIL_BYTES : META_HEAD_BYTES
    const span = fromTail ? Math.max(0, head.size - META_HEAD_BYTES) : head.size
    messageCount = Math.max(messageCount, Math.round((messageCount * span) / window))
  }
  if (sidechain || messageCount === 0) return null
  const title = truncate(customTitle || aiTitle || summary || firstPrompt)

  const ft = fileTimes(file)
  return {
    id: `claude:${nativeId}`,
    provider: 'claude',
    nativeId,
    source: sourceLabel,
    title: title || '(untitled)',
    cwd,
    logBranch,
    startedAt: firstTs ?? ft.start,
    // truncated head can't see the last line's timestamp — mtime is the truth anyway
    updatedAt: head.truncated ? ft.end : (lastTs ?? ft.end),
    messageCount,
    sourcePath: file
  }
}

/**
 * What a call's result says about the call itself: a refused or failed call is marked
 * (an edit that never landed must not read as one), a check learns how it ended, a
 * published page its address, and a created task learns the number Claude gave it —
 * `Task #3 created successfully` — which is what later TaskUpdate calls name it by.
 */
function answered(call: SessionMessage, result: string, isError: boolean): SessionMessage {
  const a = call.artifact
  if (a?.kind === 'check') {
    // an error states the exit code (`Exit code 1`) — one that states none was refused
    // or blocked and never ran; a success is a zero exit, unless the command only
    // went to the background, where its end is not in this result
    const exitCode = isError ? exitCodeIn(result) : /^Command running in background/.test(result) ? null : 0
    const artifact = isError && exitCode === null ? a : checkOutcome(a, { text: result, exitCode })
    return { ...call, artifact, ...(isError ? { failed: true } : {}) }
  }
  if (isError) return { ...call, failed: true }
  // a published page's address is only in the result: `Published <file> at https://…`
  if (a?.kind === 'shared' && call.toolName === 'Artifact') {
    const url = publishedUrl(result)
    return url && !a.links.some((l) => l.url === url) ? { ...call, artifact: { ...a, links: [...a.links, { url }] } } : call
  }
  if (a?.kind !== 'task-add') return call
  const ids = [...result.matchAll(/Task #(\w+)/g)].map((m) => m[1]!)
  return ids.length === a.items.length ? { ...call, artifact: { ...a, ids } } : call
}

/** A subagent call (`Agent`, `Task` before the rename) and the row its edits follow.
 *  Both fields are filled in as the transcript is read — the call's row first, then
 *  its result's. */
type AgentCall = {
  /** The row the edits follow: the result's once there is one, so edits never split a
   *  call from its result */
  after: number
  /** The subagent's id, as its result names it: `subagents/agent-<id>.jsonl` */
  agentId?: string
}

/** Subagent logs one transcript read follows, newest calls first — each is a read of its own */
const MAX_SUBAGENTS = 32
/** `.meta.json` files read looking for a call's subagent before giving up */
const MAX_SUBAGENT_METAS = 256

/**
 * Where each call's subagent wrote its log. The result names it (`toolUseResult.agentId`)
 * once there is one; a subagent still running has only its `.meta.json`, which names
 * the call that started it (`toolUseId`).
 */
function subagentLogs(dir: string, calls: ReadonlyMap<string, AgentCall>): Map<string, string> {
  const out = new Map<string, string>()
  for (const [id, call] of calls) {
    const file = call.agentId ? join(dir, `agent-${call.agentId}.jsonl`) : null
    if (file && existsSync(file)) out.set(id, file)
  }
  if (out.size === calls.size) return out
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.meta.json')).slice(0, MAX_SUBAGENT_METAS)
  } catch {
    return out
  }
  for (const name of names) {
    let id: unknown
    try {
      id = JSON.parse(readHead(join(dir, name), 4096).text)?.toolUseId
    } catch {
      continue
    }
    const file = join(dir, `${name.slice(0, -'.meta.json'.length)}.jsonl`)
    if (typeof id === 'string' && calls.has(id) && !out.has(id) && existsSync(file)) out.set(id, file)
  }
  return out
}

/**
 * A subagent's edits, by its log's stamp: a live transcript is read again on every
 * write, and a finished subagent's log never changes. Bounded like the rows it holds.
 */
const subagentCache = new Map<string, { readonly stamp: string; readonly rows: SessionMessage[] }>()
const SUBAGENT_CACHE = 64
/** The only lines of a subagent's log its edits can come from — an edit call, or a result
 *  that refused one — tested on the raw text, so the rest (most of a log that reads and
 *  runs things) is never parsed */
const EDIT_LINE = /"name":\s*"(?:Edit|MultiEdit|Write)"|"is_error":\s*true/

function subagentEdits(file: string): SessionMessage[] {
  let stamp: string
  try {
    const st = statSync(file)
    stamp = `${st.mtimeMs}:${st.size}`
  } catch {
    return []
  }
  const hit = subagentCache.get(file)
  if (hit?.stamp === stamp) return hit.rows
  const tail = readTail(file, TRANSCRIPT_TAIL_BYTES)
  // a cut read starts mid-line: that line is not a line
  const text = tail.truncated ? tail.text.slice(tail.text.indexOf('\n') + 1) : tail.text
  const lines = parseJsonlText(
    text
      .split('\n')
      .filter((l) => EDIT_LINE.test(l))
      .join('\n'),
    false
  )
  const rows = transcriptRows(lines).rows.filter((m) => m.kind === 'tool_call' && m.artifact?.kind === 'edits')
  subagentCache.delete(file)
  subagentCache.set(file, { stamp, rows })
  if (subagentCache.size > SUBAGENT_CACHE) subagentCache.delete(subagentCache.keys().next().value!)
  return rows
}

/**
 * A subagent logs its edits in a file of its own (`<session-id>/subagents/agent-<id>.jsonl`),
 * never in the session's: without them a session that delegated its work shows none.
 * Each call's edits follow its result — the subagent's own rows, in its order and with
 * its times — so the Work panel counts them and the transcript shows them where the
 * work was handed off. Only edits: a subagent's own to-do list is not the session's.
 */
function withSubagentEdits(
  rows: SessionMessage[],
  calls: ReadonlyMap<string, AgentCall>,
  file: string
): SessionMessage[] {
  if (calls.size === 0) return rows
  const newest = new Map([...calls].slice(-MAX_SUBAGENTS))
  const logs = subagentLogs(join(dirname(file), basename(file, '.jsonl'), 'subagents'), newest)
  // from the last anchor back, so the earlier ones' offsets still hold
  const inserts = [...newest]
    .flatMap(([id, call]) => {
      const log = logs.get(id)
      const edits = log ? subagentEdits(log) : []
      return edits.length > 0 ? [{ after: call.after, edits }] : []
    })
    .sort((a, b) => b.after - a.after)
  if (inserts.length === 0) return rows
  const out = [...rows]
  for (const { after, edits } of inserts) out.splice(after + 1, 0, ...edits)
  return out
}

export function parseClaudeMessages(file: string): SessionMessage[] {
  const { lines, truncated } = readJsonlTail(file)
  const { rows, agents } = transcriptRows(lines)
  const out = withSubagentEdits(rows, agents, file)
  return truncated
    ? [{ role: 'system', kind: 'system', text: '(older messages omitted — transcript is very large)' }, ...out]
    : out
}

function transcriptRows(lines: readonly any[]): { rows: SessionMessage[]; agents: Map<string, AgentCall> } {
  const out: SessionMessage[] = []
  // where each call's row sits: a result answers its call by id, and parallel calls
  // put several results after several calls, so adjacency would pair them wrong
  const callRows = new Map<string, number>()
  const agents = new Map<string, AgentCall>()
  for (const l of lines) {
    const ts = toMs(l.timestamp) ?? undefined
    if (l.type === 'user' || l.type === 'assistant') {
      const content = l.message?.content
      const text = contentToText(content)
      if (text) out.push({ role: l.type, kind: 'text', text: capText(text), ts })
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type === 'tool_use') {
            const preview = toolPreview(b.name ?? 'tool', b.input)
            const asks = parseAsks(b.name ?? '', b.input)
            const artifact = toolArtifact(b.name ?? '', b.input)
            if (typeof b.id === 'string') callRows.set(b.id, out.length)
            if (typeof b.id === 'string' && (b.name === 'Agent' || b.name === 'Task'))
              agents.set(b.id, { after: out.length })
            out.push({
              role: 'assistant',
              kind: 'tool_call',
              toolName: b.name ?? 'tool',
              text: truncate(JSON.stringify(b.input ?? {}), 400),
              ...(preview ? { preview: truncate(preview, 200) } : {}),
              ...(asks ? { asks } : {}),
              ...(artifact ? { artifact } : {}),
              ts
            })
          }
          if (b?.type === 'tool_result') {
            const text = contentToText(b.content)
            const at = typeof b.tool_use_id === 'string' ? callRows.get(b.tool_use_id) : undefined
            if (at !== undefined) out[at] = answered(out[at]!, text, b.is_error === true)
            const agent = typeof b.tool_use_id === 'string' ? agents.get(b.tool_use_id) : undefined
            if (agent) {
              agent.after = out.length
              const id = l.toolUseResult?.agentId
              // it becomes part of a path: an id, never a way out of the directory
              if (typeof id === 'string' && /^[\w-]+$/.test(id)) agent.agentId = id
            }
            out.push({ role: 'tool', kind: 'tool_result', text: truncate(text || '(result)', 400), ts })
          }
        }
      }
    } else if (l.type === 'system' && typeof l.content === 'string') {
      out.push({ role: 'system', kind: 'system', text: truncate(l.content, 200), ts })
    }
  }
  return { rows: out, agents }
}
