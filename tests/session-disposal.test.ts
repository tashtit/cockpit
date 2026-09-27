import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { disposalBytes, disposalFiles, disposalOf, dispose, openBy } from '../src/main/session-disposal'
import type { SessionMeta } from '../src/shared/types'
import { writeAntigravityConversation, writeCursorAcpSession, writeCursorChats, writeOpencodeDb } from '../scripts/ui-tour/store-fixtures.mts'

const root = mkdtempSync(join(tmpdir(), 'cockpit-disposal-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

let dir: string
let n = 0
beforeEach(() => {
  dir = join(root, String(n++))
  mkdirSync(dir, { recursive: true })
})

const meta = (over: Pick<SessionMeta, 'provider' | 'nativeId' | 'sourcePath'>): SessionMeta => ({
  id: `${over.provider}:${over.nativeId}`,
  source: 'x',
  title: 't',
  cwd: null,
  logBranch: null,
  startedAt: 1,
  updatedAt: 1,
  messageCount: 1,
  ...over
})

const write = (path: string, text: string): string => {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, text)
  return path
}

describe('what deleting a session removes, as its agent keeps it', () => {
  it('Gemini CLI: the log, and the folder its subagents wrote beside it', () => {
    const log = write(join(dir, 'tmp', 'p', 'chats', 'session-1.jsonl'), '{}\n')
    write(join(dir, 'tmp', 'p', 'chats', 'sess-1', 'sub.jsonl'), '{}\n')
    const other = write(join(dir, 'tmp', 'p', 'chats', 'session-2.jsonl'), '{}\n')
    const plan = disposalOf(meta({ provider: 'gemini', nativeId: 'sess-1', sourcePath: log }))
    expect(plan.paths).toEqual([log, join(dir, 'tmp', 'p', 'chats', 'sess-1')])
    expect(disposalBytes(plan)).toBe(6)
    dispose(plan)
    expect(existsSync(log)).toBe(false)
    expect(existsSync(join(dir, 'tmp', 'p', 'chats', 'sess-1'))).toBe(false)
    expect(existsSync(other)).toBe(true)
  })

  it('Cline: the task folder, and its entry in the history Cline lists tasks from', () => {
    const log = write(join(dir, 'tasks', '17', 'ui_messages.json'), '[]')
    write(join(dir, 'tasks', '17', 'api_conversation_history.json'), '[]')
    const history = write(
      join(dir, 'state', 'taskHistory.json'),
      JSON.stringify([
        { id: '17', task: 'gone' },
        { id: '18', task: 'kept' }
      ])
    )
    const plan = disposalOf(meta({ provider: 'cline', nativeId: '17', sourcePath: log }))
    expect(plan.index).toEqual({ file: history, id: '17' })
    dispose(plan)
    expect(existsSync(join(dir, 'tasks', '17'))).toBe(false)
    expect(JSON.parse(readFileSync(history, 'utf8'))).toEqual([{ id: '18', task: 'kept' }])
  })

  it('Roo Code: the task folder, and its entry in the tasks index', () => {
    const log = write(join(dir, 'tasks', 'r1', 'ui_messages.json'), '[]')
    const index = write(join(dir, 'tasks', '_index.json'), JSON.stringify({ version: 1, entries: [{ id: 'r1' }, { id: 'r2' }] }))
    dispose(disposalOf(meta({ provider: 'roo', nativeId: 'r1', sourcePath: log })))
    expect(existsSync(join(dir, 'tasks', 'r1'))).toBe(false)
    expect(JSON.parse(readFileSync(index, 'utf8')).entries).toEqual([{ id: 'r2' }])
  })

  it('Cursor: an agent transcript’s folder, with the subagents in it', () => {
    const log = write(join(dir, 'projects', 'x', 'agent-transcripts', 'c1', 'c1.jsonl'), '{}\n')
    write(join(dir, 'projects', 'x', 'agent-transcripts', 'c1', 'subagents', 's.jsonl'), '{}\n')
    const plan = disposalOf(meta({ provider: 'cursor', nativeId: 'c1', sourcePath: log }))
    expect(plan.paths).toEqual([join(dir, 'projects', 'x', 'agent-transcripts', 'c1')])
    dispose(plan)
    expect(existsSync(join(dir, 'projects', 'x', 'agent-transcripts', 'c1'))).toBe(false)
  })

  it('Cursor: an editor chat’s rows in the editor’s database, and no other chat’s', () => {
    const db = join(dir, 'state.vscdb')
    writeCursorChats(db, [
      { id: 'gone', created: 1, updated: 1, bubbles: [{ type: 1, at: 1, text: 'a' }, { type: 2, at: 2, text: 'b' }] },
      { id: 'kept', created: 1, updated: 1, bubbles: [{ type: 1, at: 1, text: 'c' }] }
    ])
    const plan = disposalOf(meta({ provider: 'cursor', nativeId: 'gone', sourcePath: `${db}#gone` }))
    expect(plan).toMatchObject({ paths: [], rows: { db, kind: 'cursor-chat', id: 'gone' }, databases: [db] })
    expect(disposalFiles(plan)).toEqual([db])
    expect(disposalBytes(plan)).toBeGreaterThan(0)
    dispose(plan)
    const keys = new DatabaseSync(db, { readOnly: true }).prepare('SELECT key FROM cursorDiskKV ORDER BY key').all()
    expect(keys.map((k) => (k as { key: string }).key)).toEqual([
      'bubbleId:kept:kept-b0',
      'composerData:draft-1',
      'composerData:kept'
    ])
  })

  it('opencode: the session’s rows in every table that keeps one per session', () => {
    const db = join(dir, 'opencode.db')
    const turn = { role: 'user' as const, at: 1, parts: [{ type: 'text', text: 'hi' }] }
    writeOpencodeDb(db, [
      { id: 'ses_gone', title: 'a', directory: '/x', created: 1, updated: 1, turns: [turn] },
      { id: 'ses_kept', title: 'b', directory: '/x', created: 1, updated: 1, turns: [turn] }
    ])
    // a table a later version added: found by its column, not named here
    const w = new DatabaseSync(db)
    w.exec("CREATE TABLE todo (session_id text, content text); INSERT INTO todo VALUES ('ses_gone', 'x'), ('ses_kept', 'y');")
    w.close()
    const plan = disposalOf(meta({ provider: 'opencode', nativeId: 'ses_gone', sourcePath: `${db}#ses_gone` }))
    expect(disposalBytes(plan)).toBeGreaterThan(0)
    dispose(plan)
    const r = new DatabaseSync(db, { readOnly: true })
    const ids = (sql: string): unknown[] => r.prepare(sql).all().map((x) => Object.values(x as object)[0])
    expect(ids('SELECT id FROM session')).toEqual(['ses_kept'])
    expect(ids('SELECT DISTINCT session_id FROM message')).toEqual(['ses_kept'])
    expect(ids('SELECT DISTINCT session_id FROM part')).toEqual(['ses_kept'])
    expect(ids('SELECT session_id FROM todo')).toEqual(['ses_kept'])
    r.close()
  })

  it('opencode’s older file store: the session, its turns, their parts, its diff and to-dos', () => {
    const storage = join(dir, 'storage')
    const log = write(join(storage, 'session', 'proj', 'ses_old.json'), '{}')
    write(join(storage, 'message', 'ses_old', 'msg_1.json'), '{}')
    write(join(storage, 'part', 'msg_1', 'prt_1.json'), '{}')
    write(join(storage, 'todo', 'ses_old.json'), '[]')
    const kept = write(join(storage, 'part', 'msg_other', 'prt_2.json'), '{}')
    dispose(disposalOf(meta({ provider: 'opencode', nativeId: 'ses_old', sourcePath: log })))
    for (const p of [log, join(storage, 'message', 'ses_old'), join(storage, 'part', 'msg_1'), join(storage, 'todo', 'ses_old.json')]) {
      expect(existsSync(p)).toBe(false)
    }
    expect(existsSync(kept)).toBe(true)
  })

  it('Antigravity: the conversation’s database and the markdown it wrote beside it', () => {
    const db = join(dir, 'conversations', 'conv.db')
    writeAntigravityConversation(db, { cwd: '/x', began: 1, steps: [{ at: 1, user: 'hi' }] })
    write(join(dir, 'brain', 'conv', 'task.md'), '- [ ] x')
    const plan = disposalOf(meta({ provider: 'antigravity', nativeId: 'conv', sourcePath: db }))
    expect(plan.databases).toEqual([db])
    dispose(plan)
    expect(existsSync(db)).toBe(false)
    expect(existsSync(join(dir, 'brain', 'conv'))).toBe(false)
  })

  it('Cursor over ACP: the conversation’s folder, its other conversations kept', () => {
    const db = writeCursorAcpSession(dir, { id: 'conv', cwd: '/x', created: 1, messages: [{ role: 'user', content: 'hi' }] })
    const other = writeCursorAcpSession(dir, { id: 'other', cwd: '/x', created: 1, messages: [{ role: 'user', content: 'hi' }] })
    const plan = disposalOf(meta({ provider: 'cursor', nativeId: 'conv', sourcePath: db }))
    // the database is what the running agent holds open, so what may block the delete
    expect(plan.databases).toEqual([db])
    expect(plan.paths).toEqual([join(dir, 'acp-sessions', 'conv')])
    dispose(plan)
    expect(existsSync(join(dir, 'acp-sessions', 'conv'))).toBe(false)
    expect(existsSync(other)).toBe(true)
  })

  it('a database nobody has open is free to write', async () => {
    const db = join(dir, 'free.db')
    new DatabaseSync(db).close()
    expect(await openBy([db])).toEqual(new Set())
  })
})
