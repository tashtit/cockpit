import { useState, type JSX } from 'react'
import type { BackupPreview, RestoreSummary } from '../../shared/types'
import { api } from './api'
import { ipcErrorText } from './ipc-error'

/**
 * Backup: export everything of Cockpit's own to a file, and put one back.
 *
 * Its own component for the same reason as ModelProviders — two passphrase fields
 * and a preview would otherwise re-render the usage meters on every keystroke.
 * `onStatus` feeds Settings' sr-only announcer; `onRestored` lets it reload the
 * settings a restore just changed underneath it.
 */
export function BackupSection({
  onStatus,
  onRestored
}: {
  onStatus: (msg: string) => void
  onRestored: () => void
}): JSX.Element {
  const [pass, setPass] = useState('')
  const [confirmPass, setConfirmPass] = useState('')
  const [busy, setBusy] = useState<'export' | 'open' | 'restore' | 'undo' | null>(null)
  const [exportError, setExportError] = useState<string | null>(null)
  const [restoreError, setRestoreError] = useState<string | null>(null)
  const [exported, setExported] = useState<string | null>(null)
  const [preview, setPreview] = useState<BackupPreview | null>(null)
  const [restorePass, setRestorePass] = useState('')
  const [summary, setSummary] = useState<RestoreSummary | null>(null)

  const mismatch = pass !== '' && pass !== confirmPass
  const tooShort = pass !== '' && pass.length < 8

  const doExport = async (): Promise<void> => {
    setExportError(null)
    setExported(null)
    setBusy('export')
    try {
      const res = await api.exportBackup(pass || undefined)
      if (!res) return
      setPass('')
      setConfirmPass('')
      const said = res.secretsIncluded
        ? `Backup written to ${res.path} — secrets included`
        : `Backup written to ${res.path} — without secrets`
      setExported(said)
      onStatus(said)
    } catch (err) {
      setExportError(ipcErrorText(err))
    } finally {
      setBusy(null)
    }
  }

  const choose = async (): Promise<void> => {
    setRestoreError(null)
    setSummary(null)
    setBusy('open')
    try {
      const res = await api.openBackup()
      if (!res) return
      setPreview(res)
      setRestorePass('')
      onStatus(`Backup from ${new Date(res.createdAt).toLocaleString()} opened`)
    } catch (err) {
      setRestoreError(ipcErrorText(err))
    } finally {
      setBusy(null)
    }
  }

  const restore = async (): Promise<void> => {
    if (!preview) return
    setRestoreError(null)
    setBusy('restore')
    try {
      const res = await api.restoreBackup(preview.token, restorePass || undefined)
      setSummary(res)
      setPreview(null)
      setRestorePass('')
      onStatus(restoreLine(res))
      onRestored()
    } catch (err) {
      // the file stays open on a wrong passphrase, so the user can just type it again
      setRestoreError(ipcErrorText(err))
    } finally {
      setBusy(null)
    }
  }

  const undo = async (): Promise<void> => {
    if (!summary?.undoId) return
    setRestoreError(null)
    setBusy('undo')
    try {
      await api.undoRestore(summary.undoId)
      setSummary(null)
      onStatus('Restore undone — settings are back as they were')
      onRestored()
    } catch (err) {
      setRestoreError(ipcErrorText(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <p className="ns-hint ns-prose">
        One file with everything of Cockpit&apos;s own: config homes, shared instructions, the
        library and its skills, model providers and view settings. Never session transcripts — those
        stay where each agent keeps them.
      </p>
      <form
        className="source-add"
        onSubmit={(e) => {
          e.preventDefault()
          void doExport()
        }}
      >
        <div className="ns-options">
          <div className="ns-opt">
            <label className="ns-label" htmlFor="backup-pass">Passphrase · optional</label>
            <input
              id="backup-pass"
              type="password"
              autoComplete="new-password"
              placeholder="at least 8 characters"
              value={pass}
              aria-invalid={!!exportError || tooShort}
              aria-describedby={exportError ? 'backup-export-error' : undefined}
              onChange={(e) => {
                setPass(e.target.value)
                setExportError(null)
              }}
            />
          </div>
          <div className="ns-opt">
            <label className="ns-label" htmlFor="backup-pass-2">Repeat passphrase</label>
            <input
              id="backup-pass-2"
              type="password"
              autoComplete="new-password"
              placeholder="the same again"
              value={confirmPass}
              disabled={pass === ''}
              aria-invalid={mismatch}
              onChange={(e) => setConfirmPass(e.target.value)}
            />
          </div>
        </div>
        <p className="ns-hint">
          Without a passphrase, API keys and MCP credentials are left out and listed as missing
          after a restore; MCP commands, arguments and URLs are written as they are. With one they
          are encrypted into the file — and a lost passphrase cannot be recovered.
        </p>
        {mismatch && <div className="ns-hint">The two passphrases don&apos;t match yet.</div>}
        {tooShort && <div className="ns-hint">A passphrase needs at least 8 characters.</div>}
        {exportError && (
          <div id="backup-export-error" role="alert" className="new-error">{exportError}</div>
        )}
        {exported && <p className="ns-hint">{exported}</p>}
        <div className="ns-actions">
          <button
            type="submit"
            className="btn-ghost"
            disabled={busy !== null || mismatch || tooShort}
          >
            {busy === 'export' ? 'Exporting…' : 'Export backup…'}
          </button>
        </div>
      </form>

      <ul className="source-list">
        <li className="source-row">
          <div className="source-body">
            <div className="source-label">Restore from a backup</div>
            <div className="source-note">
              {preview
                ? `From ${new Date(preview.createdAt).toLocaleString()} · ${preview.counts.entries} library entries · ${preview.counts.skills} skills · ${preview.counts.endpoints} providers`
                : 'Nothing already here is replaced or deleted — a restore only adds what is missing.'}
            </div>
            {preview && preview.commands.length > 0 && (
              <div className="source-note">
                MCP servers it would add run: {preview.commands.join(', ')}
              </div>
            )}
            {preview && preview.unmatched.length > 0 && (
              <div className="source-note">
                No repo here for {preview.unmatched.join(', ')} — open the same file again once
                they are cloned and have a session.
              </div>
            )}
          </div>
          <div className="source-health">
            <button className="btn-ghost small" disabled={busy !== null} onClick={() => void choose()}>
              {busy === 'open' ? 'Opening…' : preview ? 'Choose another…' : 'Choose backup…'}
            </button>
          </div>
        </li>
      </ul>
      {preview?.sealed && (
        <div className="ns-opt">
          <label className="ns-label" htmlFor="restore-pass">Passphrase for this backup</label>
          <input
            id="restore-pass"
            type="password"
            autoComplete="off"
            value={restorePass}
            onChange={(e) => setRestorePass(e.target.value)}
          />
        </div>
      )}
      {restoreError && <div role="alert" className="new-error">{restoreError}</div>}
      {preview && (
        <div className="ns-actions">
          <button
            className="btn-primary"
            disabled={busy !== null || (preview.sealed && restorePass.trim() === '')}
            onClick={() => void restore()}
          >
            {busy === 'restore' ? 'Restoring…' : 'Restore'}
          </button>
        </div>
      )}
      {summary && (
        <>
          <p className="ns-hint">{restoreLine(summary)}</p>
          {summary.needsValues.length > 0 && (
            <p className="ns-hint">
              Needs values before it can be switched on: {summary.needsValues.join(' · ')}
            </p>
          )}
          {summary.kept.length > 0 && <p className="ns-hint">Kept as they were: {summary.kept.join(' · ')}</p>}
          {summary.skipped.length > 0 && <p className="ns-hint">Skipped: {summary.skipped.join(' · ')}</p>}
          {summary.undoId && (
            <p className="ns-hint">
              Restored things sit switched off until you turn them on in Agents.{' '}
              <button className="link-btn" disabled={busy !== null} onClick={() => void undo()}>
                {busy === 'undo' ? 'Undoing…' : 'Undo this restore'}
              </button>
            </p>
          )}
        </>
      )}
    </>
  )
}

function restoreLine(s: RestoreSummary): string {
  const parts = [
    s.added.entries > 0 ? `${s.added.entries} library entries` : '',
    s.added.skills > 0 ? `${s.added.skills} skills` : '',
    s.added.endpoints > 0 ? `${s.added.endpoints} providers` : '',
    s.added.sources > 0 ? `${s.added.sources} config homes` : '',
    s.added.instructions > 0 ? `${s.added.instructions} instruction baselines` : ''
  ].filter(Boolean)
  return parts.length === 0
    ? 'Restored — everything in that backup was already here'
    : `Restored ${parts.join(', ')}`
}
