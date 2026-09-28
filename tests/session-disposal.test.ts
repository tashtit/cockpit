import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync, spawn } from 'node:child_process'
import { disposalBytes, disposalFiles, disposalOf, dispose, lsofHolds, openBy } from '../src/main/session-disposal'
import type { ExecResult } from '../src/main/env'
import { foldThread } from '../src/main/indexer'
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

/** lsof is how a database held open is seen; a CI image may lack it */
const hasLsof = (() => {
  try {
    execFileSync('lsof', ['-v'], { stdio: 'ignore' })
    return true
  } catch (err) {
    return (err as { status?: number }).status !== undefined
  }
})()

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

  it('Cursor: what an editor chat is sized at is exactly what deleting it removes', () => {
    const db = join(dir, 'state.vscdb')
    writeCursorChats(db, [
      { id: 'a', created: 1, updated: 1, bubbles: [{ type: 1, at: 1, text: 'x'.repeat(300) }, { type: 2, at: 2, text: 'y' }] },
      { id: 'b', created: 1, updated: 1, bubbles: [{ type: 1, at: 1, text: 'z' }] }
    ])
    const w = new DatabaseSync(db)
    const put = w.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)')
    // what else Cursor keys per chat, and what it keys otherwise
    put.run('checkpointId:a:cp1', 'c'.repeat(100))
    put.run('messageRequestContext:a:m1', 'r'.repeat(50))
    put.run('composerVirtualRowHeights:a', 'h'.repeat(20))
    put.run('agentKv:blob:0a1b', 'k'.repeat(70))
    w.close()
    const total = (): number =>
      Number((new DatabaseSync(db, { readOnly: true }).prepare('SELECT sum(length(value)) AS n FROM cursorDiskKV').get() as { n: number }).n)
    const plan = (id: string) => disposalOf(meta({ provider: 'cursor', nativeId: id, sourcePath: `${db}#${id}` }))
    const before = total()
    const a = disposalBytes(plan('a'))
    expect(a).toBeGreaterThan(450)
    dispose(plan('a'))
    expect(before - total()).toBe(a)
    // the database changed: sizes are read again, not served from before
    const b = disposalBytes(plan('b'))
    const more = new DatabaseSync(db)
    more.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)').run('bubbleId:b:late', 'l'.repeat(1_000))
    more.close()
    expect(disposalBytes(plan('b'))).toBe(b + 1_000)
  })

  it('Cursor: a chat kept both in the editor’s database and as an agent transcript goes whole', () => {
    const db = join(dir, 'ide', 'state.vscdb')
    writeCursorChats(db, [
      { id: 'both', created: 1, updated: 1, bubbles: [{ type: 1, at: 1, text: 'a' }, { type: 2, at: 2, text: 'b' }] },
      { id: 'kept', created: 1, updated: 1, bubbles: [{ type: 1, at: 1, text: 'c' }] }
    ])
    const log = write(join(dir, 'home', 'projects', 'x', 'agent-transcripts', 'both', 'both.jsonl'), '{}\n')
    // the indexer finds the one chat twice and keeps the fuller record
    const session = foldThread([
      { ...meta({ provider: 'cursor', nativeId: 'both', sourcePath: log }), messageCount: 1 },
      { ...meta({ provider: 'cursor', nativeId: 'both', sourcePath: `${db}#both` }), messageCount: 2 }
    ])
    expect(session).toMatchObject({ sourcePath: `${db}#both`, otherRecords: [log] })
    const plan = disposalOf(session)
    expect(plan).toMatchObject({ paths: [dirname(log)], rows: { db, kind: 'cursor-chat', id: 'both' }, databases: [db] })
    expect(disposalFiles(plan)).toEqual([dirname(log), db])
    dispose(plan)
    expect(existsSync(dirname(log))).toBe(false)
    const keys = new DatabaseSync(db, { readOnly: true }).prepare('SELECT key FROM cursorDiskKV ORDER BY key').all()
    expect(keys.map((k) => (k as { key: string }).key)).toEqual(['bubbleId:kept:kept-b0', 'composerData:draft-1', 'composerData:kept'])
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
    const withoutEvents = disposalBytes(plan)
    expect(withoutEvents).toBeGreaterThan(0)
    // 1.18's event store, as it declares it: the session is the aggregate
    const e = new DatabaseSync(db, { enableForeignKeyConstraints: false })
    e.exec(
      'CREATE TABLE `event_sequence` (`aggregate_id` text PRIMARY KEY, `seq` integer NOT NULL, `owner_id` text);' +
        'CREATE TABLE `event` (`id` text PRIMARY KEY, `aggregate_id` text NOT NULL, `seq` integer NOT NULL, `type` text NOT NULL, `data` text NOT NULL,' +
        ' CONSTRAINT `fk_event_aggregate_id_event_sequence_aggregate_id_fk` FOREIGN KEY (`aggregate_id`) REFERENCES `event_sequence`(`aggregate_id`) ON DELETE CASCADE);'
    )
    const event = e.prepare('INSERT INTO event VALUES (?, ?, ?, ?, ?)')
    for (const id of ['ses_gone', 'ses_kept']) {
      e.prepare('INSERT INTO event_sequence VALUES (?, 2, NULL)').run(id)
      event.run(`evt_${id}_1`, id, 1, 'session.created.1', 'c'.repeat(500))
      event.run(`evt_${id}_2`, id, 2, 'message.updated.1', 'm'.repeat(500))
    }
    e.close()
    expect(disposalBytes(plan)).toBe(withoutEvents + 1_000)
    dispose(plan)
    const r = new DatabaseSync(db, { readOnly: true })
    const ids = (sql: string): unknown[] => r.prepare(sql).all().map((x) => Object.values(x as object)[0])
    expect(ids('SELECT id FROM session')).toEqual(['ses_kept'])
    expect(ids('SELECT DISTINCT session_id FROM message')).toEqual(['ses_kept'])
    expect(ids('SELECT DISTINCT session_id FROM part')).toEqual(['ses_kept'])
    expect(ids('SELECT session_id FROM todo')).toEqual(['ses_kept'])
    expect(ids('SELECT DISTINCT aggregate_id FROM event')).toEqual(['ses_kept'])
    expect(ids('SELECT aggregate_id FROM event_sequence')).toEqual(['ses_kept'])
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
    expect(await openBy([db])).toEqual(new Map())
  })

  it.runIf(hasLsof)('a database another process has open is held, the rest of the batch free', async () => {
    const held = join(dir, 'held.db')
    const free = join(dir, 'free.db')
    new DatabaseSync(held).close()
    new DatabaseSync(free).close()
    const fd = openSync(held, 'r')
    const holder = spawn('sleep', ['30'], { stdio: [fd, 'ignore', 'ignore'] })
    closeSync(fd)
    try {
      await new Promise((r) => setTimeout(r, 300))
      expect(await openBy([held, free])).toEqual(new Map([[held, 'held']]))
    } finally {
      holder.kill()
    }
  })
})

describe('what lsof says of the databases it was asked about', () => {
  const a = { db: '/tmp/x/a.db', real: '/private/tmp/x/a.db' }
  const b = { db: '/tmp/x/b.db', real: '/private/tmp/x/b.db' }
  const names = [a, b]
  const run = (over: Partial<ExecResult>): ExecResult => ({ ok: false, stdout: '', stderr: '', error: 'Command failed: lsof -w -F pn -- …', ...over })

  it('frees what a finished run found open nowhere — lsof exits 1 then', () => {
    expect(lsofHolds(run({}), { names, selfPid: 5 })).toEqual(new Map())
  })

  it('holds what another process has open, by the real path lsof prints', () => {
    const stdout = 'p77\nf12\nn/private/tmp/x/a.db\np5\nf3\nn/private/tmp/x/b.db\n'
    // pid 5 is Cockpit itself, reading it
    expect(lsofHolds(run({ stdout }), { names, selfPid: 5 })).toEqual(new Map([[a.db, 'held']]))
    expect(lsofHolds(run({ ok: true, error: null, stdout }), { names, selfPid: 9 })).toEqual(
      new Map([
        [a.db, 'held'],
        [b.db, 'held']
      ])
    )
  })

  it('clears nothing when lsof was cut short or never ran', () => {
    const cut = run({ stdout: 'p77\nf12\nn/private/tmp/x/a.db\n', cutShort: true })
    expect(lsofHolds(cut, { names, selfPid: 5 })).toEqual(new Map([[a.db, 'unchecked'], [b.db, 'unchecked']]))
    const missing = run({ error: 'spawn lsof ENOENT' })
    expect(lsofHolds(missing, { names, selfPid: 5 })).toEqual(new Map([[a.db, 'unchecked'], [b.db, 'unchecked']]))
  })

  it('leaves a file lsof could not examine unchecked, and only that one', () => {
    const stderr = 'lsof: status error on /tmp/x/b.db: No such file or directory\nlsof 4.91\n usage: [-?abhlnNoOPRtUvVX]\n'
    expect(lsofHolds(run({ stderr }), { names, selfPid: 5 })).toEqual(new Map([[b.db, 'unchecked']]))
    // an error that names none of them: none is cleared
    expect(lsofHolds(run({ stderr: 'lsof: can’t read kernel name list\n' }), { names, selfPid: 5 })).toEqual(
      new Map([[a.db, 'unchecked'], [b.db, 'unchecked']])
    )
  })
})
