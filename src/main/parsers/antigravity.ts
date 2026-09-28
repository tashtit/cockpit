import { readdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SessionMeta, SessionMessage, WorkArtifact } from '../../shared/types'
import { checklistArtifact, fileWriteArtifact, planArtifact, replaceArtifact } from './artifacts'
import { checkArtifact, checkOutcome } from './checks'
import { protoAll, protoString, protoStrings, protoTime } from './protobuf'
import { dbMtime, queryAll, queryEach } from './sqlite'
import { capText, jsonText, TRANSCRIPT_TAIL_BYTES, truncate, usableCwd } from './util'

/**
 * Antigravity — the agent IDE and its CLI — keeps one SQLite database per conversation,
 * <home>/conversations/<id>.db, with the markdown it writes for the person beside it in
 * brain/<id>/. Its homes are ~/.gemini/antigravity-ide, ~/.gemini/antigravity-cli, and
 * ~/.gemini/antigravity for the first releases. Conversations from before the database
 * are `<id>.pb`, encrypted, and are neither readable nor listed.
 *
 * The `steps` table is the conversation, one protobuf message per step, read without a
 * schema (none is published) by these field paths, and so failure-tolerant throughout:
 *   5.1        when the step happened (a Timestamp)
 *   5.4        a tool call: 1 its id, 2 its name, 3 its arguments as JSON
 *   19.2       a person's message
 *   20.1       the model's reply; 20.3 its reasoning
 *   28.21.1    what `run_command` printed
 *   114.2.1    a notice the harness posted into the conversation
 * A step is recognized by the fields it has, not by its `step_type` number.
 * `trajectory_metadata_blob` holds the workspace: 1.1 its file URI, 1.3.1 owner/repo,
 * 1.4 the branch, 2 when the conversation began.
 */
export function listAntigravitySessionRoots(home: string): string[] {
  return [join(home, 'conversations')]
}

export function listAntigravitySessionFiles(home: string): string[] {
  const dir = join(home, 'conversations')
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.db'))
      .map((e) => join(dir, e.name))
  } catch {
    return []
  }
}

export function listAntigravitySessions(home: string, sourceLabel: string): SessionMeta[] {
  return listAntigravitySessionFiles(home).flatMap((f) => parseAntigravityMeta(f, sourceLabel) ?? [])
}

/** A step's payload bigger than this is not read — a browser step can carry screenshots. */
const MAX_STEP_BYTES = 1024 * 1024
/** The steps a meta read looks through for the opening prompt when the numbering has moved… */
const PROMPT_SCAN_STEPS = 24
/** …reading no more of them than a log's head is read within, */
const PROMPT_SCAN_BYTES = 256 * 1024
/** …and passing over a step bigger than this unread: typed words are small, screenshots are not */
const PROMPT_STEP_BYTES = 64 * 1024

function bytes(v: unknown): Uint8Array | null {
  return v instanceof Uint8Array ? v : null
}

function workspace(file: string): { cwd: string | null; branch: string | null; repo: string | null; began: number | null } {
  const data = bytes(queryAll(file, 'SELECT data FROM trajectory_metadata_blob LIMIT 1')?.[0]?.['data'])
  if (!data) return { cwd: null, branch: null, repo: null, began: null }
  let cwd: string | null = null
  const uri = protoString(data, [1, 1])
  if (uri?.startsWith('file://')) {
    try {
      cwd = usableCwd(fileURLToPath(uri))
    } catch {
      /* not a path this machine can name */
    }
  }
  const repo = protoString(data, [1, 3, 1])
  return {
    cwd,
    branch: protoString(data, [1, 4]) || null,
    repo: repo && /^[\w.-]+\/[\w.-]+$/.test(repo) ? repo : null,
    began: protoTime(data, [2])
  }
}

/** What the person typed, when this step is theirs. */
function userText(p: Uint8Array): string | null {
  const t = protoString(p, [19, 2])
  return t && t.trim() ? t : null
}

export function parseAntigravityMeta(file: string, sourceLabel: string): SessionMeta | null {
  if (!file.endsWith('.db')) return null
  const counted = queryAll(file, 'SELECT count(*) AS n FROM steps WHERE step_type IN (14, 15)')
  if (!counted) return null
  // the opening prompt: step type 14 today; the first steps otherwise, stepped through
  // under a budget (length() reads a payload's size, not the payload)
  let prompt: string | null = null
  const first = bytes(
    queryAll(
      file,
      `SELECT CASE WHEN length(step_payload) <= ${MAX_STEP_BYTES} THEN step_payload END AS p FROM steps WHERE step_type = 14 ORDER BY idx LIMIT 1`
    )?.[0]?.['p']
  )
  if (first) prompt = userText(first)
  if (!prompt) {
    let budget = PROMPT_SCAN_BYTES
    queryEach(
      file,
      {
        sql: `SELECT CASE WHEN length(step_payload) <= ${PROMPT_STEP_BYTES} THEN step_payload END AS p
              FROM steps ORDER BY idx LIMIT ${PROMPT_SCAN_STEPS}`
      },
      (r) => {
        const p = bytes(r['p'])
        if (!p) return true
        budget -= p.length
        prompt = userText(p)
        return !prompt && budget > 0
      }
    )
  }
  const messageCount = Number(counted[0]?.['n'] ?? 0) || (prompt ? 1 : 0)
  if (!prompt || messageCount === 0) return null
  const ws = workspace(file)
  const nativeId = basename(file, '.db')
  return {
    id: `antigravity:${nativeId}`,
    provider: 'antigravity',
    nativeId,
    source: sourceLabel,
    title: truncate(prompt) || '(untitled)',
    cwd: ws.cwd,
    logBranch: ws.branch,
    ...(ws.repo ? { repoFullName: ws.repo } : {}),
    startedAt: ws.began ?? (first ? protoTime(first, [5, 1]) : null) ?? dbMtime(file),
    updatedAt: dbMtime(file),
    messageCount,
    sourcePath: file
  }
}

function args(json: string | null): Record<string, unknown> {
  if (!json) return {}
  try {
    const v = JSON.parse(json)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** A call's one-liner: the agent's own words for what it is doing, else what it names. */
function preview(name: string, a: Record<string, unknown>): string | null {
  const question = Array.isArray(a['questions']) ? str((a['questions'][0] as Record<string, unknown> | undefined)?.['question']) : null
  return (
    question ??
    str(a['toolAction']) ??
    str(a['CommandLine']) ??
    str(a['TargetFile']) ??
    str(a['AbsolutePath']) ??
    str(a['DirectoryPath']) ??
    str(a['Query']) ??
    str(a['Url']) ??
    str(a['Task']) ??
    (name === 'ask_question' ? 'waiting for your answer' : null)
  )
}

/** What a call did that the Work panel shows: an edit, a plan, a to-do list, a check. */
function artifactOf(name: string, a: Record<string, unknown>): WorkArtifact | undefined {
  switch (name) {
    case 'run_command':
      return checkArtifact(a['CommandLine'])
    case 'write_to_file': {
      const target = str(a['TargetFile']) ?? ''
      // the files Antigravity writes for the person: its plan and its task list
      if (/(^|\/)implementation_plan\.md$/.test(target)) return planArtifact(a['CodeContent'])
      if (/(^|\/)task\.md$/.test(target)) return checklistArtifact(a['CodeContent'])
      return fileWriteArtifact(target, a['CodeContent'], 'write')
    }
    case 'replace_file_content':
      return replaceArtifact(a['TargetFile'], [[a['TargetContent'], a['ReplacementContent']]])
    case 'multi_replace_file_content': {
      const chunks = Array.isArray(a['ReplacementChunks']) ? (a['ReplacementChunks'] as Record<string, unknown>[]) : []
      return replaceArtifact(
        a['TargetFile'],
        chunks.map((c): readonly [unknown, unknown] => [c?.['TargetContent'], c?.['ReplacementContent']])
      )
    }
    default:
      return undefined
  }
}

/** One step as transcript rows. */
export function stepRows(p: Uint8Array): SessionMessage[] {
  const ts = protoTime(p, [5, 1]) ?? undefined
  const user = userText(p)
  if (user) return [{ role: 'user', kind: 'text', text: capText(user), ts }]
  if (protoAll(p, [20]).length > 0) {
    const out: SessionMessage[] = []
    const thinking = protoString(p, [20, 3])
    if (thinking?.trim()) out.push({ role: 'assistant', kind: 'reasoning', text: capText(thinking), ts })
    const reply = protoString(p, [20, 1])
    if (reply?.trim()) out.push({ role: 'assistant', kind: 'text', text: capText(reply), ts })
    // its tool calls are steps of their own, each with its result — listed there
    return out
  }
  const call = protoAll(p, [5, 4])[0]
  if (call instanceof Uint8Array) {
    const name = protoString(call, [2]) ?? 'tool'
    const json = protoString(call, [3])
    const a = args(json)
    const output = protoStrings(p, [28, 21, 1]).join('\n')
    let artifact = artifactOf(name, a)
    if (artifact?.kind === 'check' && output) artifact = checkOutcome(artifact, { text: output, exitCode: null })
    const line = preview(name, a)
    const row: SessionMessage = {
      role: 'assistant',
      kind: 'tool_call',
      toolName: name,
      text: truncate(json ?? jsonText(a), 400),
      ...(line ? { preview: truncate(line, 200) } : {}),
      ...(artifact ? { artifact } : {}),
      ts
    }
    return output ? [row, { role: 'tool', kind: 'tool_result', text: truncate(output, 400), ts }] : [row]
  }
  const notice = protoString(p, [114, 2, 1])
  if (notice?.trim()) return [{ role: 'system', kind: 'system', text: truncate(notice, 200), ts }]
  return []
}

export function parseAntigravityMessages(file: string): SessionMessage[] {
  // the newest steps that fit the transcript budget, each read only if it is not huge
  const sizes = queryAll(file, 'SELECT idx, length(step_payload) AS n FROM steps ORDER BY idx DESC')
  if (!sizes) return []
  let budget = TRANSCRIPT_TAIL_BYTES
  let from = 0
  let truncated = false
  for (const r of sizes) {
    const n = Math.min(Number(r['n'] ?? 0), MAX_STEP_BYTES)
    if (budget - n < 0) {
      truncated = true
      break
    }
    budget -= n
    from = Number(r['idx'] ?? 0)
  }
  const rows = queryAll(
    file,
    `SELECT CASE WHEN length(step_payload) > ${MAX_STEP_BYTES} THEN NULL ELSE step_payload END AS p FROM steps WHERE idx >= ? ORDER BY idx`,
    from
  )
  const out = (rows ?? []).flatMap((r) => {
    const p = bytes(r['p'])
    return p ? stepRows(p) : []
  })
  return truncated
    ? [{ role: 'system', kind: 'system', text: '(older messages omitted — transcript is very large)' }, ...out]
    : out
}
