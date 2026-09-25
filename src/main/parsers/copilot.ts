import { basename, dirname, join, sep } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import type { SessionMeta, SessionMessage } from '../../shared/types'
import { planArtifact, sharedArtifact, todoTableArtifact, toolArtifact } from './artifacts'
import { checkOutcome, exitCodeIn } from './checks'
import {
  capText,
  isRegularFile,
  readJson,
  readJsonlTail,
  readHead,
  parseJsonlText,
  fileTimes,
  jsonText,
  toMs,
  contentToText,
  toolPreview,
  truncate,
  usableCwd,
  walkFiles
} from './util'

/**
 * Copilot CLI sessions (current layout): <configDir>/session-state/<uuid>/events.jsonl
 * events.jsonl lines: { type: "session.start"|"user.message"|"assistant.message"|"tool.execution_start"|..., data, timestamp }
 * session.start carries full context: cwd, repository (owner/repo), branch.
 *
 * Legacy layouts (history-session-state/*.json, sessions/*.json) are still parsed best-effort.
 *
 * IMPORTANT: ~/.copilot also holds multi-GB non-session data (pkg/, repos/, logs/, data.db).
 * Only the roots below may ever be walked or watched.
 */
export function listCopilotSessionRoots(sourceDir: string): string[] {
  return [
    join(sourceDir, 'session-state'),
    join(sourceDir, 'history-session-state'),
    join(sourceDir, 'sessions')
  ]
}

/** Meta parsing reads at most this much of an events.jsonl (metadata lives up front). */
const META_HEAD_BYTES = 256 * 1024
/**
 * A legacy session is one JSON document, so it is read whole or not at all — up to this
 * much. The layout is no longer written; this only bounds what an odd file costs.
 */
const LEGACY_JSON_BYTES = 8 * 1024 * 1024
/** workspace.yaml is a handful of keys; the name is among the first */
const WORKSPACE_HEAD_BYTES = 64 * 1024

export function listCopilotSessionFiles(sourceDir: string): string[] {
  const out: string[] = []
  const stateRoot = join(sourceDir, 'session-state')
  if (existsSync(stateRoot)) {
    let dirs: string[] = []
    try {
      dirs = readdirSync(stateRoot)
    } catch {
      /* ignore */
    }
    for (const d of dirs) {
      const ev = join(stateRoot, d, 'events.jsonl')
      // the rule walkFiles keeps for the other layouts: a file, never a link or a FIFO
      if (isRegularFile(ev)) out.push(ev)
    }
  }
  for (const legacy of [join(sourceDir, 'history-session-state'), join(sourceDir, 'sessions')]) {
    out.push(...walkFiles(legacy, 3).filter((f) => f.endsWith('.json')))
  }
  return out
}

export function listCopilotSessions(sourceDir: string, sourceLabel: string): SessionMeta[] {
  const out: SessionMeta[] = []
  const seen = new Set<string>()
  for (const file of listCopilotSessionFiles(sourceDir)) {
    const meta = parseCopilotMeta(file, sourceLabel)
    if (meta && !seen.has(meta.id)) {
      seen.add(meta.id)
      out.push(meta)
    }
  }
  return out
}

export function parseCopilotMeta(file: string, sourceLabel: string): SessionMeta | null {
  if (file.endsWith('events.jsonl')) return parseEventsMeta(file, sourceLabel)
  return parseLegacyMeta(file, sourceLabel)
}

/**
 * The generated session name lives in workspace.yaml next to events.jsonl
 * (`name: Instructions access inquiry`). Line-based extraction — no YAML dep.
 */
export function copilotWorkspaceFile(eventsFile: string): string {
  return join(dirname(eventsFile), 'workspace.yaml')
}

/** A YAML block-scalar header: `|` literal or `>` folded, with optional chomping and
 *  indentation indicators in either order, and an optional trailing comment. */
const BLOCK_SCALAR = /^([|>])(?:[1-9][+-]?|[+-][1-9]?)?(?:[ \t]+#.*)?$/

function workspaceName(eventsFile: string): string {
  const raw = readHead(copilotWorkspaceFile(eventsFile), WORKSPACE_HEAD_BYTES).text
  if (!raw) return ''
  const lines = raw.split(/\r?\n/)
  const at = lines.findIndex((l) => l.startsWith('name:'))
  if (at < 0) return ''
  let v = lines[at].slice('name:'.length).trim()
  // A name that runs over several lines — until a session is named it carries its whole
  // kickoff prompt, and the prompt one session writes for another is long — is written
  // as a block scalar: `name: |-` with the text indented underneath. The key's own line
  // then holds only the indicator, which used to become the title verbatim.
  const block = BLOCK_SCALAR.exec(v)
  if (block) {
    // the block runs over every indented or blank line, up to the next top-level key;
    // a title wants its first paragraph — one line of a literal, the joined lines of a
    // folded one (truncate() collapses the whitespace either way)
    const paragraph: string[] = []
    for (const l of lines.slice(at + 1)) {
      if (l.trim() === '') {
        if (paragraph.length > 0) break
        continue
      }
      if (!/^[ \t]/.test(l)) break
      paragraph.push(l.trim())
      if (block[1] === '|') break
    }
    return paragraph.join(' ')
  }
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1)
  }
  return v
}

/**
 * The session that created this one, when another session did. The Copilot app opens a
 * session it was asked to create (`create_session`) with a `<copilot_tauri_workspace>`
 * context block naming the creator: in a `system.message` ahead of the first prompt, or
 * in that prompt's `transformedContent`. Only that block is read — a later
 * `<cross_session_message>` names sessions too, but only ones this session talks to.
 */
function creatorId(text: unknown): string | null {
  if (typeof text !== 'string') return null
  const block = /<copilot_tauri_workspace>([\s\S]*?)<\/copilot_tauri_workspace>/.exec(text)
  if (!block) return null
  const m = /^creator_chat_session_id:[ \t]*([\w-]{8,})[ \t]*$/m.exec(block[1])
  return m ? m[1] : null
}

function parseEventsMeta(file: string, sourceLabel: string): SessionMeta | null {
  const head = readHead(file, META_HEAD_BYTES)
  if (!head.text) return null
  const events = parseJsonlText(head.text, head.truncated)
  if (events.length === 0) return null

  let nativeId = basename(dirname(file))
  let cwd: string | null = null
  let logBranch: string | null = null
  let repoFullName: string | null = null
  let title = ''
  let firstTs: number | null = null
  let messageCount = 0
  let sawStart = false
  let sawPrompt = false
  let creator: string | null = null

  for (const ev of events) {
    const ts = toMs(ev.timestamp)
    if (ts && !firstTs) firstTs = ts
    // the creator is stated at kickoff: before the first prompt, or with it
    if (!sawPrompt && !creator) {
      if (ev.type === 'system.message') creator = creatorId(ev.data?.content)
      else if (ev.type === 'user.message') creator = creatorId(ev.data?.transformedContent)
    }
    if (ev.type === 'user.message') sawPrompt = true
    if (ev.type === 'session.start' && ev.data) {
      sawStart = true
      if (ev.data.sessionId) nativeId = String(ev.data.sessionId)
      const ctx = ev.data.context ?? {}
      cwd = usableCwd(ctx.cwd) ?? cwd
      // branch/repository stopped being written after CLI 1.0.80 — current sessions
      // carry a context of { cwd } alone. Still read here for older sessions; the
      // indexer derives the branch from the checkout when it's absent.
      if (typeof ctx.branch === 'string') logBranch = ctx.branch
      if (typeof ctx.repository === 'string' && ctx.repository.includes('/'))
        repoFullName = ctx.repository
      if (!firstTs) firstTs = toMs(ev.data.startTime)
    } else if (ev.type === 'user.message' || ev.type === 'assistant.message') {
      messageCount++
      if (!title && ev.type === 'user.message') {
        const t = typeof ev.data?.content === 'string' ? ev.data.content : contentToText(ev.data?.content)
        if (t) title = truncate(t)
      }
    }
  }
  // Truncated head: extrapolate the count so big sessions don't show "2 msgs"
  if (head.truncated && messageCount > 0) {
    messageCount = Math.max(messageCount, Math.round((messageCount * head.size) / META_HEAD_BYTES))
  }
  // A session whose first user message falls past the head cap is still a session —
  // session.start alone (cwd/repo/branch known) is enough to index it.
  if (!sawStart && messageCount === 0 && !title) return null

  const generated = workspaceName(file)
  if (generated) title = truncate(generated)

  const ft = fileTimes(file)
  return {
    id: `copilot:${nativeId}`,
    provider: 'copilot',
    nativeId,
    source: sourceLabel,
    title: title || '(untitled)',
    cwd,
    logBranch,
    repoFullName,
    startedAt: firstTs ?? ft.start,
    updatedAt: ft.end,
    messageCount,
    sourcePath: file,
    ...(creator && creator !== nativeId ? { parentId: `copilot:${creator}` } : {})
  }
}

function extractTimeline(j: any): any[] {
  for (const key of ['timeline', 'messages', 'chatMessages', 'events', 'history']) {
    if (Array.isArray(j?.[key])) return j[key]
  }
  return []
}

function itemRole(m: any): 'user' | 'assistant' | 'tool' {
  const r = (m?.role ?? m?.sender ?? m?.type ?? '').toString().toLowerCase()
  if (r.includes('user')) return 'user'
  if (r.includes('tool')) return 'tool'
  return 'assistant'
}

function itemText(m: any): string {
  if (typeof m?.content === 'string') return m.content
  const c = contentToText(m?.content)
  if (c) return c
  for (const k of ['text', 'message', 'body']) {
    if (typeof m?.[k] === 'string') return m[k]
  }
  return ''
}

/**
 * The conversation inside a legacy (whole-document JSON) session, role and text per
 * timeline item — what transcript search reads from those files. Tool items are
 * tagged so the search can leave them out.
 */
export function legacyTimelineTexts(
  j: unknown
): ReadonlyArray<{ readonly role: 'user' | 'assistant' | 'tool'; readonly text: string; readonly ts: number | null }> {
  const out: Array<{ role: 'user' | 'assistant' | 'tool'; text: string; ts: number | null }> = []
  for (const m of extractTimeline(j)) {
    const text = itemText(m)
    if (!text) continue
    const toolName = typeof m?.toolName === 'string' ? m.toolName : typeof m?.tool === 'string' ? m.tool : null
    out.push({ role: toolName ? 'tool' : itemRole(m), text, ts: toMs(m?.timestamp ?? m?.ts) })
  }
  return out
}

function parseLegacyMeta(file: string, sourceLabel: string): SessionMeta | null {
  const j = readJson(file, LEGACY_JSON_BYTES)
  if (!j || typeof j !== 'object') return null
  const timeline = extractTimeline(j)
  // id-less files in the FLAT legacy roots must fall back to the file stem — the
  // parent dir there is the root itself ('sessions'/'history-session-state'), and
  // basename() never returns nullish, so a `??` chain can't express this
  const parentDir = basename(dirname(file))
  const dirFallback =
    parentDir === 'sessions' || parentDir === 'history-session-state'
      ? basename(file, '.json')
      : parentDir
  const nativeId = String(j.sessionId ?? j.id ?? dirFallback)
  if (!j.sessionId && !j.id && timeline.length === 0) return null

  let title = typeof j.title === 'string' ? j.title : typeof j.summary === 'string' ? j.summary : ''
  let messageCount = 0
  for (const m of timeline) {
    const role = itemRole(m)
    if (role === 'user' || role === 'assistant') {
      messageCount++
      if (!title && role === 'user') {
        const t = itemText(m)
        if (t) title = truncate(t)
      }
    }
  }
  if (messageCount === 0 && !j.sessionId) return null

  const ft = fileTimes(file)
  return {
    id: `copilot:${nativeId}`,
    provider: 'copilot',
    nativeId,
    source: sourceLabel,
    title: title || '(untitled)',
    cwd: usableCwd(j.cwd) ?? usableCwd(j.workingDirectory),
    logBranch: typeof j.branch === 'string' ? j.branch : null,
    startedAt: toMs(j.startTime ?? j.createdAt) ?? ft.start,
    updatedAt: toMs(j.updatedAt ?? j.endTime) ?? ft.end,
    messageCount,
    sourcePath: file
  }
}

/**
 * Copilot keeps the plan it asks approval for in a file of its own — `plan.md` in the
 * session's directory, `files/plan.md` in some CLI releases — written with its ordinary
 * file tools, and `exit_plan_mode` carries only a summary of it.
 */
const PLAN_FILES = ['plan.md', join('files', 'plan.md')]
/** The plan artifact is capped well under this; a head read is enough */
const PLAN_HEAD_BYTES = 128 * 1024

/** Which of the session's plan files this call writes (one of PLAN_FILES); null for
 *  everything else. */
function planFileWritten(sessionDir: string, toolName: string, args: unknown): string | null {
  if (!['create', 'edit', 'str_replace', 'str_replace_editor'].includes(toolName)) return null
  const path = args && typeof args === 'object' ? (args as Record<string, unknown>).path : null
  if (typeof path !== 'string') return null
  // matched on the session's id, not the config home: a home that moved since still
  // wrote this session's plan
  const id = basename(sessionDir)
  return PLAN_FILES.find((f) => path.endsWith(`${sep}${id}${sep}${f}`)) ?? null
}

/**
 * A file Copilot wrote to the session's own `files/` folder — what its app lists as the
 * session's files: a PR body drafted, a report, a screenshot. Handed to the person, not
 * an edit of the repo.
 */
function sessionFileWritten(sessionDir: string, toolName: string, args: unknown): string | null {
  if (!['create', 'edit', 'str_replace', 'str_replace_editor'].includes(toolName)) return null
  const path = args && typeof args === 'object' ? (args as Record<string, unknown>).path : null
  if (typeof path !== 'string') return null
  return path.includes(`${sep}${basename(sessionDir)}${sep}files${sep}`) ? path : null
}

/**
 * The plan's text after a write to it: a `create` replaces it whole, an `edit` swaps
 * one passage. Null when the write can't be followed — an edit to a plan never seen,
 * or a passage that isn't there — so a version is never guessed.
 */
function replayPlanWrite(plan: string | null, toolName: string, args: unknown): string | null {
  const i = args && typeof args === 'object' ? (args as Record<string, unknown>) : {}
  const command = toolName === 'str_replace_editor' ? i.command : toolName
  if (command === 'create') return typeof i.file_text === 'string' ? i.file_text : null
  if (command !== 'edit' && command !== 'str_replace') return null
  if (plan === null || typeof i.old_str !== 'string' || typeof i.new_str !== 'string') return null
  const next = i.new_str
  return plan.includes(i.old_str) ? plan.replace(i.old_str, () => next) : null
}

/**
 * Copilot keeps its to-do list in a table of the session's own database — `todos` in
 * `session.db` beside the log — and changes it through its `sql` tool, in every form
 * SQL has (inserts, updates by id, CASE WHEN over the set). Replaying those statements
 * would mean writing a SQL engine; the table already says where the list stands.
 */
const TODO_DB = 'session.db'
/** More than the artifact keeps (it caps the list itself); bounds the read */
const TODO_ROWS = 200

/** A `sql` call that changed the to-do table — the row the list is shown on. */
function changesTodos(toolName: string, args: unknown): boolean {
  if (toolName !== 'sql' || !args || typeof args !== 'object') return false
  const query = (args as Record<string, unknown>).query
  return typeof query === 'string' && /\btodos\b/i.test(query) && /\b(insert|update|delete|replace)\b/i.test(query)
}

/**
 * The to-do table as it stands, read-only and in the order the steps were added; null
 * when it can't be read (no db, no table yet, a lock) — the row then stays a plain
 * query, never an empty list that would read as "cleared".
 */
function todoTable(sessionDir: string): unknown[] | null {
  const file = join(sessionDir, TODO_DB)
  // sqlite's own open would block on a FIFO there, as a plain read did
  if (!isRegularFile(file)) return null
  let db: DatabaseSync | null = null
  try {
    db = new DatabaseSync(file, { readOnly: true })
    return db.prepare(`SELECT title, status FROM todos ORDER BY rowid LIMIT ${TODO_ROWS}`).all()
  } catch {
    return null
  } finally {
    db?.close()
  }
}

/**
 * The plan file as it is now: the one the log last wrote, else whichever exists —
 * always inside the session's own directory, whatever path the log named.
 */
function planOnDisk(sessionDir: string, written: string | null): string | null {
  const names = written ? [written, ...PLAN_FILES.filter((f) => f !== written)] : PLAN_FILES
  for (const name of names) {
    const f = join(sessionDir, name)
    if (!existsSync(f)) continue
    const text = readHead(f, PLAN_HEAD_BYTES).text
    if (text.trim()) return text
  }
  return null
}

export function parseCopilotMessages(file: string): SessionMessage[] {
  if (file.endsWith('events.jsonl')) {
    const { lines, truncated } = readJsonlTail(file)
    const sessionDir = dirname(file)
    const out: SessionMessage[] = []
    if (truncated) {
      out.push({ role: 'system', kind: 'system', text: '(older messages omitted — transcript is very large)' })
    }
    // where each call's row sits, so a failed completion can mark it
    const callRows = new Map<string, number>()
    // the plan file as the log has written it so far (null: not followed), which of
    // PLAN_FILES it is, and the row that last asked for approval / last wrote it
    let plan: string | null = null
    let planPath: string | null = null
    let exitRow: { at: number; replayed: boolean } | null = null
    let planWriteRow: number | null = null
    // the calls that changed the to-do table — see TODO_DB
    const todoRows: number[] = []
    for (const ev of lines) {
      const ts = toMs(ev.timestamp) ?? undefined
      if (ev.type === 'user.message' || ev.type === 'assistant.message') {
        const text =
          typeof ev.data?.content === 'string' ? ev.data.content : contentToText(ev.data?.content)
        if (text)
          out.push({ role: ev.type === 'user.message' ? 'user' : 'assistant', kind: 'text', text: capText(text), ts })
      } else if (ev.type === 'tool.execution_start') {
        const toolName = String(ev.data?.toolName ?? ev.data?.name ?? 'tool')
        const args = ev.data?.arguments ?? ev.data?.input ?? ''
        // the same humanized headline Claude and Codex rows get — raw JSON stays in the detail
        const preview = toolPreview(toolName, args)
        const written = planFileWritten(sessionDir, toolName, args)
        const shared = written ? null : sessionFileWritten(sessionDir, toolName, args)
        let artifact = toolArtifact(toolName, args)
        if (written) {
          // the plan is not the work: a write to it is never an edit of the repo's
          plan = replayPlanWrite(plan, toolName, args)
          planPath = written
          planWriteRow = out.length
          artifact = undefined
        } else if (shared) {
          artifact = sharedArtifact({ files: [shared] })
        } else if (toolName === 'exit_plan_mode') {
          // what it asked approval for is the plan as written then, not the summary
          exitRow = { at: out.length, replayed: plan !== null }
          artifact = (plan !== null ? planArtifact(plan) : undefined) ?? artifact
        } else if (changesTodos(toolName, args)) {
          todoRows.push(out.length)
        }
        if (typeof ev.data?.toolCallId === 'string') callRows.set(ev.data.toolCallId, out.length)
        out.push({
          role: 'assistant',
          kind: 'tool_call',
          toolName,
          text: truncate(jsonText(args), 400),
          ...(preview ? { preview: truncate(preview, 200) } : {}),
          ...(artifact ? { artifact } : {}),
          ts
        })
      } else if (ev.type === 'tool.execution_complete') {
        const at = typeof ev.data?.toolCallId === 'string' ? callRows.get(ev.data.toolCallId) : undefined
        if (at === undefined) continue
        let row = out[at]!
        // an edit that never landed must not read as one
        if (ev.data.success === false) row = { ...row, failed: true }
        // a check learns how it ended: the exit code Copilot states (`success` is true
        // whatever the command exited with), else the marker at the end of its output
        if (row.artifact?.kind === 'check') {
          const result = ev.data.result
          const text = String(result?.detailedContent || result?.content || '')
          const stated = ev.data.shellExecution?.exitCode
          row = { ...row, artifact: checkOutcome(row.artifact, { text, exitCode: typeof stated === 'number' ? stated : exitCodeIn(text) }) }
        }
        out[at] = row
      } else if (ev.type === 'system.message') {
        const text = typeof ev.data?.content === 'string' ? ev.data.content : ''
        if (text) out.push({ role: 'system', kind: 'system', text: truncate(text, 200), ts })
      }
    }
    const setPlan = (at: number, text: string | null): void => {
      const artifact = planArtifact(text)
      if (artifact) out[at] = { ...out[at]!, artifact }
    }
    if (exitRow && !exitRow.replayed) {
      // the newest approval asked for a plan the log couldn't follow — created before
      // the tail read, or edited where no passage matched: the file is the plan
      setPlan(exitRow.at, planOnDisk(sessionDir, planPath))
    } else if (!exitRow && planWriteRow !== null) {
      // no approval asked yet: the draft rides the row that last wrote it
      setPlan(planWriteRow, plan ?? planOnDisk(sessionDir, planPath))
    }
    // the list as it stands now rides the call that last changed it; earlier calls
    // stay plain queries — the table keeps no history of what it said before
    const todoRow = [...todoRows].reverse().find((at) => !out[at]!.failed)
    const table = todoRow !== undefined ? todoTable(sessionDir) : null
    const todos = table ? todoTableArtifact(table) : undefined
    if (todoRow !== undefined && todos) out[todoRow] = { ...out[todoRow]!, artifact: todos }
    return out
  }

  const j = readJson(file, LEGACY_JSON_BYTES)
  if (!j) return []
  const out: SessionMessage[] = []
  for (const m of extractTimeline(j)) {
    const text = itemText(m)
    const role = itemRole(m)
    const ts = toMs(m?.timestamp ?? m?.ts) ?? undefined
    const toolName = typeof m?.toolName === 'string' ? m.toolName : typeof m?.tool === 'string' ? m.tool : undefined
    if (toolName) {
      out.push({ role: 'assistant', kind: 'tool_call', toolName, text: truncate(text || '(tool)', 400), ts })
    } else if (text) {
      out.push({ role, kind: 'text', text, ts })
    }
  }
  return out
}
