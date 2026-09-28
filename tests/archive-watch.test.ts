import { describe, expect, it } from 'vitest'
import { ArchiveWatch } from '../src/main/archive-watch'
import type { SessionMeta } from '../src/shared/types'

function session(id: string): SessionMeta {
  return {
    id,
    provider: 'claude',
    nativeId: id,
    source: '/sources/claude',
    sourcePath: `/sources/claude/${id}.jsonl`,
    title: id,
    cwd: `/wt/app/${id}`,
    logBranch: null,
    gitBranch: null,
    startedAt: 0,
    updatedAt: 0,
    messageCount: 1
  }
}

/** An index as the watch sees it: what it holds, and which of those are thrown away. */
function world(ids: string[]) {
  const held = new Map(ids.map((id) => [id, session(id)]))
  const away = new Set<string>()
  const stops: { archived: string[]; listed: string[] }[] = []
  const watch = new ArchiveWatch({
    listed: () => [...held.values()].filter((s) => !away.has(s.id)),
    held: () => [...held.values()],
    thrownAway: (id) => held.has(id) && away.has(id),
    session: (id) => held.get(id) ?? null,
    stop: async ({ archived, listed }) => {
      stops.push({ archived: archived.map((s) => s.id), listed: listed.map((s) => s.id) })
      return { cleaned: 0, freedBytes: 0, failed: [] }
    }
  })
  return { held, away, stops, watch }
}

describe('ArchiveWatch', () => {
  it('hands over a session archived since the last index update, once', async () => {
    const w = world(['a', 'b'])
    w.watch.start()
    w.away.add('a')
    w.watch.update()
    w.watch.update()
    await w.watch.settled()
    expect(w.stops).toEqual([{ archived: ['a'], listed: ['b'] }])
  })

  it('acts on nothing before the first scan is done', async () => {
    const w = world(['a'])
    w.away.add('a')
    w.watch.update()
    // already archived when the scan finished: an archive from before this launch
    w.watch.start()
    w.watch.update()
    await w.watch.settled()
    expect(w.stops).toEqual([])
  })

  it('takes a session the index lost for another reason for no archive', async () => {
    const w = world(['a'])
    w.watch.start()
    // its log deleted, its source removed
    w.held.delete('a')
    w.watch.update()
    await w.watch.settled()
    expect(w.stops).toEqual([])
  })

  it('hands over a session archived again after it was brought back and worked in', async () => {
    const w = world(['a'])
    w.watch.start()
    w.away.add('a')
    w.watch.update()
    w.away.delete('a')
    w.watch.update()
    // a turn in it since it came back
    w.held.set('a', { ...session('a'), updatedAt: 1_000 })
    w.watch.update()
    w.away.add('a')
    w.watch.update()
    await w.watch.settled()
    expect(w.stops.map((s) => s.archived)).toEqual([['a'], ['a']])
  })

  it('counts a return with work in it even when it was worked in while thrown away', async () => {
    const w = world(['a'])
    w.watch.start()
    w.away.add('a')
    w.watch.update()
    // resumed in a terminal while archived here, then brought back
    w.held.set('a', { ...session('a'), updatedAt: 1_000 })
    w.away.delete('a')
    w.watch.update()
    w.away.add('a')
    w.watch.update()
    await w.watch.settled()
    expect(w.stops.map((s) => s.archived)).toEqual([['a'], ['a']])
  })

  it('takes a session thrown away before the watch started that flickers back for no archive', async () => {
    const w = world(['a', 'b'])
    w.away.add('a')
    w.watch.start()
    // a read of the provider's archive that missed it, then one that did not
    w.away.delete('a')
    w.watch.update()
    w.watch.update()
    w.away.add('a')
    w.watch.update()
    await w.watch.settled()
    expect(w.stops).toEqual([])
  })

  it('takes a session brought back and thrown away again with nothing new in it for no news', async () => {
    const w = world(['a'])
    w.watch.start()
    w.away.add('a')
    w.watch.update()
    w.away.delete('a')
    w.watch.update()
    w.away.add('a')
    w.watch.update()
    await w.watch.settled()
    expect(w.stops.map((s) => s.archived)).toEqual([['a']])
  })

  it('reads what is still listed when the stop runs, not when it was queued', async () => {
    const w = world(['a', 'b'])
    w.watch.start()
    w.away.add('a')
    w.watch.update()
    // brought back before the stop got its turn
    w.away.delete('a')
    await w.watch.settled()
    expect(w.stops).toEqual([{ archived: ['a'], listed: ['a', 'b'] }])
  })

  it('keeps watching after a stop fails', async () => {
    const w = world(['a', 'b'])
    let calls = 0
    const watch = new ArchiveWatch({
      listed: () => [...w.held.values()].filter((s) => !w.away.has(s.id)),
      thrownAway: (id) => w.away.has(id),
      session: (id) => w.held.get(id) ?? null,
      stop: async () => {
        calls += 1
        if (calls === 1) throw new Error('lsof went away')
        return { cleaned: 1, freedBytes: 0, failed: [] }
      }
    })
    watch.start()
    w.away.add('a')
    watch.update()
    w.away.add('b')
    watch.update()
    await watch.settled()
    expect(calls).toBe(2)
  })
})
