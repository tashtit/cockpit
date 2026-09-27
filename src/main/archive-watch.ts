import type { CleanupResult, SessionMeta } from '../shared/types'

/**
 * Stopping what an archived session left running, the watching half: which sessions
 * have just been thrown away. Nothing announces it — a session is archived here, in
 * the Cleanup view, or in its provider's own app, and all Cockpit ever sees is the
 * index updating — so the watch remembers what the last update listed, and a session
 * listed then and archived or deleted now is the news. One the index lost for another
 * reason (its file deleted, its source removed) is not: that is not a session ending.
 *
 * `stopLeftBehind` in cleanup.ts decides what goes; this only says when, once per
 * archive, so a server someone starts again later in an archived session's worktree
 * is theirs to keep.
 */

export type ArchiveWatchDeps = {
  /** Every session still listed — not archived or deleted, here or in its provider's app */
  readonly listed: () => SessionMeta[]
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
  /** Stops run one at a time: each reads the process table the one before changed */
  private queue: Promise<void> = Promise.resolve()

  constructor(deps: ArchiveWatchDeps) {
    this.deps = deps
  }

  /**
   * The first scan is done: what is listed now is the baseline. Until then the index
   * holds only what its cache remembered, and a session missing from that is not one
   * archived.
   */
  start(): void {
    this.before ??= new Set(this.deps.listed().map((s) => s.id))
  }

  /** The index updated: hand whatever was archived or deleted since the last update to `stop`. */
  update(): void {
    if (this.before === null) return
    const now = new Set(this.deps.listed().map((s) => s.id))
    const archived: SessionMeta[] = []
    for (const id of this.before) {
      if (now.has(id) || !this.deps.thrownAway(id)) continue
      const s = this.deps.session(id)
      if (s) archived.push(s)
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

  /** Resolves once every stop handed over so far has run. */
  settled(): Promise<void> {
    return this.queue
  }
}
