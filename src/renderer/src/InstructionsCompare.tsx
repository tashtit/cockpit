import { useEffect, useState, type JSX } from 'react'
import { fileChange } from '../../shared/instruction-changes'
import { api } from './api'
import { ipcErrorText } from './ipc-error'
import { useDiffLayout } from './diff-layout'
import { APPLY_LABEL, DiffLayoutToggle, InstructionDiff } from './InstructionDiff'
import { applyFile, takeFile, type InstructionsWrite } from './instruction-writes'
import type { Notice } from './notice'
import { useLoaded } from './use-loaded'

/**
 * The instructions row opened up: what each agent's file holds against the saved
 * baseline, line by line, with the one action that settles it on each. The baseline
 * is the one thing Cockpit really owns a version of, so unlike every other kind the
 * comparison here has a right side — and the fix is always "write it".
 */
export function InstructionsCompare({
  repoRoot,
  setNotice,
  onChanged
}: {
  repoRoot: string | null
  setNotice: (n: Notice) => void
  /** an apply rewrote an agent's file — the panel's own row is now stale */
  onChanged: () => void
}): JSX.Element | null {
  const { value: state, set: setState, error } = useLoaded(() => api.getInstructions(repoRoot), [repoRoot])
  const [busy, setBusy] = useState<string | null>(null)
  const layout = useDiffLayout()

  // a failed read says why on the card's notice line, rather than reading forever
  useEffect(() => {
    if (error) setNotice({ text: error, kind: 'error' })
  }, [error])

  const act = async (path: string, { op, ok }: InstructionsWrite): Promise<void> => {
    setNotice(null)
    setBusy(path)
    try {
      setState(await op())
      setNotice({ text: ok, kind: 'ok' })
      onChanged()
    } catch (err) {
      setNotice({ text: ipcErrorText(err), kind: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const apply = (path: string): Promise<void> => act(path, applyFile(repoRoot, path))
  const take = (path: string): Promise<void> => act(path, takeFile(repoRoot, path))

  if (!state) return error ? null : <div className="tree-empty">reading each agent’s file…</div>
  if (state.baseline.trim() === '') {
    return (
      <p className="pnl-note">
        No shared baseline written yet — the <strong>Instructions</strong> section is where it goes.
      </p>
    )
  }
  const changes = state.files.map((file) => ({ file, change: fileChange(file, state.baseline) }))
  return (
    <>
      {changes.some((c) => c.change.status !== 'synced') && (
        <div className="idiff-tools">
          <DiffLayoutToggle />
        </div>
      )}
      <div className="idiff-list">
        {changes.map(({ file, change }) => (
          <InstructionDiff
            key={file.path}
            file={file}
            change={change}
            layout={layout}
            action={
              change.status !== 'synced' && (
                <>
                  {change.status === 'drifted' && (
                    <button
                      className="link-btn"
                      disabled={busy !== null}
                      aria-label={`Take the shared block in ${file.path} as the baseline`}
                      onClick={() => void take(file.path)}
                    >
                      use this file&apos;s version
                    </button>
                  )}
                  <button
                    className="btn-ghost small"
                    disabled={busy !== null}
                    onClick={() => void apply(file.path)}
                  >
                    {busy === file.path ? 'applying…' : APPLY_LABEL[change.status]}
                  </button>
                </>
              )
            }
          />
        ))}
      </div>
    </>
  )
}
