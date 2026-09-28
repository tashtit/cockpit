import type { CleanupResult, SessionMeta } from '../shared/types'

/**
 * Stopping what an archived session left running, the watching half: which sessions
 * have just been thrown away. Nothing announces it — a session is archived here, in
 * the Cleanup view, or in its provider's own app, and all Cockpit ever sees is the
 * index updating — so the watch remembers what the last update listed, and a session
 * listed then and archived or deleted now is the news. One the index lost for another
 * reason (its file deleted, its source removed) is not: that is not a session ending.
 *
 * Nor is one already thrown away. A provider's archive is read from its app's store,
 * and a read that misses a session for a moment lists it again until the next read
 * hides it — which looks exactly like an archive. So the watch keeps what it knows is
 * thrown away (`away`, seeded at `start` from everything the index holds), and a
 * session leaves it only when it is listed again for real: listed, with work in it
 * since it was thrown away (its `updatedAt` moved). A session brought back and
 * archived again with nothing new in between is no news either way — `leftBehind`
 * only takes what began while it ran, and that was weighed the first time.
 *
 * `stopLeftBehind` in cleanup.ts decides what goes; this only says when, once per
 * archive, so a server someone starts again later in an archived session's worktree
 * is theirs to keep.
 */

export type ArchiveWatchDeps = {
  /** Every session still listed — not archived or deleted, here or in its provider's app */
  readonly listed: () => SessionMeta[]
  /**
   * Every session the index holds, thrown away or not — what tells the watch, as it
   * starts, which were thrown away before it. Without it the watch knows only what it
   * has seen thrown away itself.
   */
  readonly held?: () => readonly SessionMeta[]
  /** Archived or deleted — false for an id the index no longer holds */
  readonly thrownAway: (id: string) => boolean
  readonly session: (id: string) => SessionMeta | null
  readonly stop: (sessions: {
    readonly archived: readonly SessionMeta[]
    readonly listed: readonly SessionMeta[]
  }) => Promise<CleanupResult>
}

export class ArchiveWatch {
  private readonly deps: ArchiveWatchDeps
  /** Ids the last index update listed; null until the first scan is done */
  private before: Set<string> | null = null
  /**
   * Ids known to be thrown away, each with its `updatedAt` then — filled as the watch
   * sees them go, and emptied only by a return with new work in it
   */
  private readonly away = new Map<string, number>()
  /** Stops run one at a time: each reads the process table the one before changed */
  private queue: Promise<void> = Promise.resolve()

  constructor(deps: ArchiveWatchDeps) {
    this.deps = deps
  }

  /**
   * The first scan is done: what is listed now is the baseline, and what the index
   * holds as thrown away already is old news. Until then the index holds only what its
   * cache remembered, and a session missing from that is not one archived.
   */
  start(): void {
    if (this.before !== null) return
    this.before = new Set(this.deps.listed().map((s) => s.id))
    for (const s of this.deps.held?.() ?? []) {
      if (!this.before.has(s.id) && this.deps.thrownAway(s.id)) this.away.set(s.id, s.updatedAt)
    }
  }

  /** The index updated: hand whatever was archived or deleted since the last update to `stop`. */
  update(): void {
    if (this.before === null) return
    const listed = this.deps.listed()
    const now = new Set(listed.map((s) => s.id))
    // back in the listing with work done since: its next archive is news again
    for (const s of listed) if (this.returned(s)) this.away.delete(s.id)
    const archived: SessionMeta[] = []
    for (const id of this.before) {
      if (now.has(id) || !this.deps.thrownAway(id)) continue
      const s = this.deps.session(id)
      if (!s) continue
      const known = this.away.has(id) && !this.returned(s)
      this.away.set(id, s.updatedAt)
      if (!known) archived.push(s)
    }
    this.before = now
    if (archived.length === 0) return
    // what is still listed is read when the stop runs: a session brought back from the
    // archive meanwhile keeps its worktree in use
    this.queue = this.queue
      .then(() => this.deps.stop({ archived, listed: this.deps.listed() }))
      .then((res) => {
        for (const f of res.failed) console.warn(`[cleanup] could not stop ${f.target}: ${f.reason}`)
      })
      .catch((err) => console.warn('[cleanup] stopping what an archived session left running failed:', err))
  }

  /** A session known to be thrown away, with work in it since */
  private returned(s: SessionMeta): boolean {
    const then = this.away.get(s.id)
    return then !== undefined && s.updatedAt > then
  }

  /** Resolves once every stop handed over so far has run. */
  settled(): Promise<void> {
    return this.queue
  }
}
