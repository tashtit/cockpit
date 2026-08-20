import { useEffect, useRef, useState, type JSX } from 'react'
import type { RepoGroup } from '../../shared/types'
import { AgentPanel } from './AgentPanel'
import { Select } from './Select'

/**
 * Agents: what every agent on this machine shares, in one place.
 *
 * The card is deliberately shallow — a heading, one line saying *where* these
 * settings apply and letting you search them, then the panel. It used to stack a
 * scope switch over a tab bar over section pills: three bars in three visual
 * languages all answering "where am I", which is why nothing below them could be
 * read. Scope is the only thing above the panel now, because it is the only thing
 * that changes what every row underneath means.
 */

type Notice = { text: string; kind: 'ok' | 'error' } | null

export function AiSetup({
  repos,
  repoRoot,
  onScope,
  onClose
}: {
  repos: RepoGroup[]
  /** null = global; otherwise the repo this view is scoped to */
  repoRoot: string | null
  onScope: (repoRoot: string | null) => void
  onClose: () => void
}): JSX.Element {
  const [notice, setNotice] = useState<Notice>(null)
  const [query, setQuery] = useState('')
  const headingRef = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

  const gitRepos = repos.filter((r) => r.root !== null)
  const scoped = gitRepos.find((r) => r.root === repoRoot)
  // a repo that vanished from the index leaves the view pointing at nothing —
  // fall back to global rather than showing an empty project scope
  const project = repoRoot !== null && scoped ? repoRoot : null

  useEffect(() => {
    if (repoRoot !== null && !scoped) onScope(null)
  }, [repoRoot, scoped, onScope])

  return (
    <main className="chat settings-view">
      <div className="ns-card">
        <div className="ns-head">
          <h2 ref={headingRef} tabIndex={-1}>
            Agents
          </h2>
          <button className="btn-ghost" onClick={onClose}>
            Close
          </button>
        </div>

        {/* one line: where these settings apply, and a way to find one */}
        <div className="scope-line">
          <div className="scope-seg" role="group" aria-label="Settings scope">
            <button
              className={`scope-opt ${project === null ? 'active' : ''}`}
              aria-pressed={project === null}
              onClick={() => onScope(null)}
            >
              Global
            </button>
            <Select
              ariaLabel="Project"
              className={`scope-select ${project !== null ? 'active' : ''}`}
              value={project ?? ''}
              options={[
                { value: '', label: gitRepos.length === 0 ? 'No repos indexed' : 'A project…' },
                ...gitRepos.map((r) => ({ value: r.root as string, label: r.fullName ?? r.name }))
              ]}
              onChange={(v) => onScope(v === '' ? null : v)}
            />
          </div>
          <input
            type="search"
            className="pnl-search"
            placeholder="Search…"
            aria-label="Search this scope"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        <p className="scope-blurb">
          {project === null ? (
            <>
              Applies to <strong>every session, in every repo</strong> — written into each agent’s
              own config in your home folder.
            </>
          ) : (
            <>
              Applies to sessions in <code>{project.replace(/^\/Users\/[^/]+/, '~')}</code> only.
              Global settings apply here too, on top of these.
            </>
          )}
        </p>

        {notice && (
          <div
            className={`ext-notice ${notice.kind}`}
            role={notice.kind === 'error' ? 'alert' : 'status'}
          >
            {notice.text}
          </div>
        )}

        <AgentPanel
          key={project ?? 'global'}
          repoRoot={project}
          query={query}
          setNotice={setNotice}
        />
      </div>
    </main>
  )
}
