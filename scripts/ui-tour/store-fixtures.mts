/**
 * Writers for the agents that keep sessions in SQLite rather than log files — Cursor's
 * editor chats and its ACP server, opencode, Antigravity — laid out the way each writes
 * them. The unit tests build their fixtures with these, and the ui-tour's world does too,
 * so what the tour shows is exactly what the tests read.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/* ---------- the protobuf wire format, for Antigravity's steps ---------- */

/** A message field: a number (varint), text or a nested message (length-delimited). */
export type ProtoIn = readonly [number, number | string | Uint8Array | readonly ProtoIn[]]

function varint(n: number): number[] {
  const out: number[] = []
  let v = n
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80)
    v = Math.floor(v / 0x80)
  }
  out.push(v)
  return out
}

export function protoEncode(fields: readonly ProtoIn[]): Uint8Array {
  const bytes: number[] = []
  for (const [field, value] of fields) {
    if (typeof value === 'number') {
      bytes.push(...varint(field * 8), ...varint(value))
      continue
    }
    const body =
      typeof value === 'string' ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : protoEncode(value)
    bytes.push(...varint(field * 8 + 2), ...varint(body.length), ...body)
  }
  return Uint8Array.from(bytes)
}

const time = (ms: number): ProtoIn[] => [
  [1, Math.floor(ms / 1000)],
  [2, (ms % 1000) * 1e6]
]

/** One conversation step, as Antigravity's `steps` table holds it. */
export type AntigravityStep =
  | { readonly at: number; readonly user: string }
  | { readonly at: number; readonly reply?: string; readonly thinking?: string }
  | { readonly at: number; readonly tool: string; readonly args: Record<string, unknown>; readonly output?: string }
  | { readonly at: number; readonly notice: string }

function stepPayload(s: AntigravityStep): { type: number; payload: Uint8Array } {
  const meta: ProtoIn[] = [[1, time(s.at)]]
  if ('user' in s) return { type: 14, payload: protoEncode([[5, meta], [19, [[2, s.user]]]]) }
  if ('tool' in s) {
    const call: ProtoIn[] = [[1, `toolu_${s.at}`], [2, s.tool], [3, JSON.stringify(s.args)]]
    const out: ProtoIn[] = [[5, [...meta, [4, call]]]]
    if (s.output !== undefined) out.push([28, [[21, [[1, s.output]]]]])
    return { type: s.tool === 'run_command' ? 21 : 9, payload: protoEncode(out) }
  }
  if ('notice' in s) return { type: 101, payload: protoEncode([[5, meta], [114, [[2, [[1, s.notice]]]]]]) }
  const reply: ProtoIn[] = []
  if (s.reply) reply.push([1, s.reply])
  if (s.thinking) reply.push([3, s.thinking])
  return { type: 15, payload: protoEncode([[5, meta], [20, reply]]) }
}

/** An Antigravity conversation database: <home>/conversations/<id>.db. */
export function writeAntigravityConversation(
  file: string,
  o: { readonly cwd: string; readonly branch?: string; readonly repo?: string; readonly began: number; readonly steps: readonly AntigravityStep[] }
): void {
  mkdirSync(dirname(file), { recursive: true })
  rmSync(file, { force: true })
  const db = new DatabaseSync(file)
  db.exec(
    'CREATE TABLE trajectory_metadata_blob (id text DEFAULT "main", data blob, PRIMARY KEY (id));' +
      'CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, step_payload blob, PRIMARY KEY (idx));'
  )
  const ws: ProtoIn[] = [[1, `file://${o.cwd}`]]
  if (o.repo) ws.push([3, [[1, o.repo]]])
  if (o.branch) ws.push([4, o.branch])
  db.prepare('INSERT INTO trajectory_metadata_blob (id, data) VALUES (?, ?)').run('main', protoEncode([[1, ws], [2, time(o.began)]]))
  const insert = db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)')
  o.steps.forEach((s, i) => {
    const { type, payload } = stepPayload(s)
    insert.run(i, type, payload)
  })
  db.close()
}

/* ---------- opencode ---------- */

export type OpencodeSession = {
  readonly id: string
  readonly title: string
  readonly directory: string
  readonly created: number
  readonly updated: number
  readonly parent?: string
  readonly archived?: number
  /** each turn and its parts, as opencode's message and part tables keep them */
  readonly turns: ReadonlyArray<{ readonly role: 'user' | 'assistant'; readonly at: number; readonly parts: readonly object[] }>
}

/** opencode's database, <home>/opencode.db, holding these sessions. */
export function writeOpencodeDb(file: string, sessions: readonly OpencodeSession[]): void {
  mkdirSync(dirname(file), { recursive: true })
  rmSync(file, { force: true })
  const db = new DatabaseSync(file)
  db.exec(
    'CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL, title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, time_archived integer);' +
      'CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);' +
      'CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);'
  )
  const session = db.prepare(
    'INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  )
  const message = db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)')
  const part = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)')
  for (const s of sessions) {
    session.run(s.id, 'proj', s.parent ?? null, s.id, s.directory, s.title, '1.0.0', s.created, s.updated, s.archived ?? null)
    s.turns.forEach((t, i) => {
      const mid = `msg_${s.id}_${String(i).padStart(3, '0')}`
      message.run(mid, s.id, t.at, t.at, JSON.stringify({ role: t.role, time: { created: t.at } }))
      t.parts.forEach((p, j) => part.run(`prt_${mid}_${String(j).padStart(3, '0')}`, mid, s.id, t.at, t.at, JSON.stringify(p)))
    })
  }
  db.close()
}

/* ---------- Cursor's editor chats ---------- */

export type CursorChat = {
  readonly id: string
  readonly name?: string
  readonly cwd?: string
  /** the workspace URI's scheme: `file` unless said otherwise (`vscode-remote` for one over SSH) */
  readonly scheme?: string
  readonly created: number
  readonly updated: number
  readonly subagents?: readonly string[]
  /** type 1 is the person, type 2 the agent */
  readonly bubbles: ReadonlyArray<{
    readonly type: 1 | 2
    readonly at: number
    readonly text?: string
    readonly thinking?: string
    readonly tool?: { readonly name: string; readonly params: object; readonly status?: string }
  }>
}

/** Cursor's editor storage, <editor data>/User/globalStorage/state.vscdb, holding these chats. */
export function writeCursorChats(file: string, chats: readonly CursorChat[]): void {
  mkdirSync(dirname(file), { recursive: true })
  rmSync(file, { force: true })
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB); CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);')
  const put = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)')
  for (const c of chats) {
    const headers = c.bubbles.map((b, i) => ({ bubbleId: `${c.id}-b${i}`, type: b.type, createdAt: new Date(b.at).toISOString() }))
    put.run(
      `composerData:${c.id}`,
      JSON.stringify({
        _v: 10,
        composerId: c.id,
        ...(c.name ? { name: c.name } : {}),
        createdAt: c.created,
        lastUpdatedAt: c.updated,
        ...(c.cwd ? { workspaceIdentifier: { id: 'ws', uri: { $mid: 1, fsPath: c.cwd, path: c.cwd, scheme: c.scheme ?? 'file' } } } : {}),
        subagentComposerIds: c.subagents ?? [],
        fullConversationHeadersOnly: headers
      })
    )
    c.bubbles.forEach((b, i) =>
      put.run(
        `bubbleId:${c.id}:${c.id}-b${i}`,
        JSON.stringify({
          _v: 3,
          bubbleId: `${c.id}-b${i}`,
          type: b.type,
          text: b.text ?? '',
          createdAt: new Date(b.at).toISOString(),
          ...(b.thinking ? { thinking: { text: b.thinking } } : {}),
          ...(b.tool
            ? { toolFormerData: { name: b.tool.name, params: JSON.stringify(b.tool.params), status: b.tool.status ?? 'completed' } }
            : {})
        })
      )
    )
  }
  // a draft: every chat Cursor opens starts as one, with nothing in it
  put.run('composerData:draft-1', JSON.stringify({ _v: 10, composerId: 'draft-1', createdAt: 1, fullConversationHeadersOnly: [] }))
  db.close()
}

/* ---------- Cursor's ACP server ---------- */

export type CursorAcpSession = {
  readonly id: string
  readonly cwd: string
  readonly name?: string
  readonly created: number
  /** each message as Cursor stores it: `{role, content}`, AI-SDK-style parts */
  readonly messages: readonly object[]
  /** messages of an earlier root, left in the store as the conversation grew */
  readonly stale?: readonly object[]
}

/** A conversation Cursor's ACP server keeps: <home>/acp-sessions/<id>/{meta.json,store.db}. */
export function writeCursorAcpSession(home: string, s: CursorAcpSession): string {
  const dir = `${home}/acp-sessions/${s.id}`
  const file = `${dir}/store.db`
  mkdirSync(dir, { recursive: true })
  rmSync(file, { force: true })
  writeFileSync(`${dir}/meta.json`, JSON.stringify({ schemaVersion: 1, cwd: s.cwd, title: s.name ?? 'New Chat' }))
  const db = new DatabaseSync(file)
  db.exec('CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB); CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);')
  const put = db.prepare('INSERT OR IGNORE INTO blobs (id, data) VALUES (?, ?)')
  const blob = (data: Uint8Array): Uint8Array => {
    const id = createHash('sha256').update(data).digest()
    put.run(id.toString('hex'), data)
    return new Uint8Array(id)
  }
  const json = (m: object): Uint8Array => blob(new TextEncoder().encode(JSON.stringify(m)))
  for (const m of s.stale ?? []) json(m)
  const ids = s.messages.map(json)
  const root = blob(protoEncode([...ids.map((id): ProtoIn => [1, id]), [9, `file://${s.cwd}`], [22, 'cli']]))
  const meta = { agentId: s.id, latestRootBlobId: Buffer.from(root).toString('hex'), name: s.name, createdAt: s.created, mode: 'default' }
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('0', Buffer.from(JSON.stringify(meta)).toString('hex'))
  db.close()
  return file
}
