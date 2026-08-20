import { useEffect, useRef, useState, type JSX } from 'react'
import type { InstructionFile, InstructionsState } from '../../shared/types'
import { api } from './api'
import { ProviderLogo, PROVIDER_LABEL } from './logos'
import { Markdown } from './Markdown'

/**
 * Writing the shared baseline: the one surface here that authors content rather
 * than switching it on and off, which is why it opens inside its own section of
 * the panel instead of being a row you toggle.
 */

const STATUS_LABEL: Record<InstructionFile['status'], string> = {
  synced: 'in sync',
  drifted: 'out of date',
  unmanaged: 'not applied',
  missing: 'no file yet'
}

const APPLY_LABEL: Record<Exclude<InstructionFile['status'], 'synced'>, string> = {
  missing: 'Create & apply',
  unmanaged: 'Apply',
  drifted: 'Re-apply'
}

type Notice = { text: string; kind: 'ok' | 'error' } | null

export function InstructionsEditor({
  repoRoot,
  setNotice,
  onSaved
}: {
  repoRoot: string | null
  setNotice: (n: Notice) => void
  /** applying changes each agent's file, so the panel's own row is now stale */
  onSaved: () => void
}): JSX.Element {
  const [inst, setInst] = useState<InstructionsState | null>(null)
  const [draft, setDraft] = useState('')
  const [mdView, setMdView] = useState<'write' | 'preview'>('write')
  const [busy, setBusy] = useState(false)
  /** Read inside async callbacks — the closure's `repoRoot` is the value at call time. */
  const repoRootRef = useRef(repoRoot)
  repoRootRef.current = repoRoot

  useEffect(() => {
    let dead = false
    setInst(null)
    void api.getInstructions(repoRoot).then((s) => {
      if (dead) return
      setInst(s)
      setDraft(s.baseline)
    })
    return () => {
      dead = true
    }
  }, [repoRoot])

  const dirty = inst !== null && draft !== inst.baseline

  const run = async (op: () => Promise<InstructionsState>, okText: string): Promise<void> => {
    setNotice(null)
    setBusy(true)
    const startedOn = repoRoot
    try {
      const s = await op()
      // a slow apply resolving after the user switched scope must not write the
      // old scope's baseline into the newly loaded one
      if (startedOn !== repoRootRef.current) return
      setInst(s)
      setDraft(s.baseline)
      setNotice({ text: okText, kind: 'ok' })
      onSaved()
    } catch (err) {
      if (startedOn !== repoRootRef.current) return
      setNotice({ text: err instanceof Error ? err.message : String(err), kind: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const saveBaseline = (): Promise<void> =>
    run(() => api.saveInstructionsBaseline(repoRoot, draft), 'Shared instructions saved.')

  const saveAndApply = (): Promise<void> =>
    run(
      async () => {
        await api.saveInstructionsBaseline(repoRoot, draft)
        return api.applyInstructions(repoRoot)
      },
      'Applied to every agent file — running sessions pick it up on their next start.'
    )

  const applyOne = (path: string): Promise<void> =>
    run(() => api.applyInstructions(repoRoot, path), 'Applied — restart that agent to pick it up.')

  return (
    <>
      <p className="ns-hint">
        One shared baseline, written into each agent&apos;s own instructions file inside{' '}
        <code>&lt;!-- cockpit:shared --&gt;</code> markers. Anything outside the markers belongs to
        that agent alone and is never touched.
      </p>

      {!inst && <div className="tree-empty">loading…</div>}

      {inst && (
        <>
          {/* GitHub-comment grammar: the baseline is markdown, so edit it like markdown */}
          <div className="md-tabs" role="group" aria-label="Editor mode">
            <button
              className={`md-tab ${mdView === 'write' ? 'active' : ''}`}
              aria-pressed={mdView === 'write'}
              onClick={() => setMdView('write')}
            >
              Write
            </button>
            <button
              className={`md-tab ${mdView === 'preview' ? 'active' : ''}`}
              aria-pressed={mdView === 'preview'}
              onClick={() => setMdView('preview')}
            >
              Preview
            </button>
          </div>
          {mdView === 'write' ? (
            <textarea
              className="inst-baseline"
              aria-label="Shared instructions"
              rows={8}
              placeholder={
                repoRoot
                  ? '# Conventions for this repo that every agent should follow…'
                  : '# General instructions every agent should follow, everywhere…\n\nE.g. commit style, language, review rules, what never to touch.'
              }
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          ) : (
            <div className="inst-preview markdown" aria-label="Shared instructions preview">
              {draft.trim() ? (
                <Markdown text={draft} />
              ) : (
                <p className="inst-preview-empty">nothing to preview yet — write some markdown first</p>
              )}
            </div>
          )}
          <div className="inst-actions">
            {dirty && <span className="inst-dirty">unsaved changes</span>}
            <button className="btn-ghost" disabled={busy || !dirty} onClick={() => void saveBaseline()}>
              Save
            </button>
            <button
              className="btn-primary"
              disabled={busy || draft.trim() === ''}
              onClick={() => void saveAndApply()}
            >
              Save &amp; apply to all
            </button>
          </div>

          <ul className="ext-list" aria-label="Agent instruction files">
            {inst.files.map((f) => (
              <InstructionFileRow
                key={f.path}
                file={f}
                busy={busy}
                baselineEmpty={inst.baseline.trim() === ''}
                onApply={() => void applyOne(f.path)}
                onSaveFile={(content) =>
                  void run(
                    () => api.saveInstructionFile(repoRoot, f.path, content),
                    'File saved.'
                  )
                }
              />
            ))}
          </ul>
        </>
      )}
    </>
  )
}

function InstructionFileRow({
  file,
  busy,
  baselineEmpty,
  onApply,
  onSaveFile
}: {
  file: InstructionFile
  busy: boolean
  baselineEmpty: boolean
  onApply: () => void
  onSaveFile: (content: string) => void
}): JSX.Element {
  const [text, setText] = useState(file.content)
  // a reload (e.g. applying another file) must not clobber an in-progress edit here:
  // only follow file.content when the textarea still matched the previous content
  const lastContent = useRef(file.content)
  useEffect(() => {
    if (file.content === lastContent.current) return
    setText((t) => (t === lastContent.current ? file.content : t))
    lastContent.current = file.content
  }, [file.content])

  return (
    <li className={`ext-row inst-file ${file.agents.length === 1 ? `tint-${file.agents[0]}` : ''}`}>
      <div className="ext-agents" aria-label={`Read by ${file.agents.map((a) => PROVIDER_LABEL[a]).join(' and ')}`}>
        {file.agents.map((a) => (
          <span key={a} className={`plogo plogo-${a}`} title={PROVIDER_LABEL[a]}>
            <ProviderLogo p={a} size={13} />
          </span>
        ))}
      </div>
      <div className="ext-body">
        <div className="ext-name">
          <span className="inst-path">{file.path.replace(/^\/Users\/[^/]+/, '~')}</span>
          <span className={`inst-status ${file.status}`}>{STATUS_LABEL[file.status]}</span>
        </div>
        {file.exists && (
          <details className="inst-edit">
            <summary>view / edit file</summary>
            <textarea
              aria-label={`Contents of ${file.path}`}
              rows={10}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="inst-actions">
              <button
                className="btn-ghost small"
                disabled={busy || text === file.content}
                onClick={() => onSaveFile(text)}
              >
                Save file
              </button>
            </div>
          </details>
        )}
      </div>
      {file.status !== 'synced' && (
        <div className="ext-actions">
          <button
            className="btn-ghost small"
            disabled={busy || baselineEmpty}
            title={baselineEmpty ? 'Write and save shared instructions first' : undefined}
            onClick={onApply}
          >
            {APPLY_LABEL[file.status]}
          </button>
        </div>
      )}
    </li>
  )
}
