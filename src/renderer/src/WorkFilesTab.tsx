import { useEffect, useRef, useState, type JSX } from 'react'
import { shortPath } from '../../shared/library'
import type { Provider, SessionFilePreview } from '../../shared/types'
import { sharedSummary, type SharedFileEntry, type WorkModel } from '../../shared/work'
import { api } from './api'
import { ipcErrorText } from './ipc-error'
import { PROVIDER_LABEL } from './logos'
import { Markdown } from './Markdown'
import { fmtTime, useTimeFormat } from './time'
import { useLoaded } from './use-loaded'
import { useTransient } from './use-transient'
import { RING_MS, relative, type WorkFocus } from './work-tab'

/** The Work panel's Files tab: the files the agent sent you and the pages it opened for you. */

/** "4.2 MB" — a file's size in the words the readout uses */
function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** `localhost:5173/guide` — a page as a person reads its address */
function pageLabel(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

export function WorkFilesTab({
  model,
  focus,
  cwd,
  provider,
  sessionId,
  onOpenUrl
}: {
  model: WorkModel
  focus: WorkFocus
  cwd: string
  provider: Provider
  sessionId: string | null
  onOpenUrl: (url: string) => void
}): JSX.Element {
  const fmt = useTimeFormat()
  const { files, links } = model.shared
  if (files.length === 0 && links.length === 0) {
    return (
      <p className="work-empty">
        Nothing shared yet. When {PROVIDER_LABEL[provider]} sends you a file — a screenshot, a report — or opens a
        page for you, it is kept here.
      </p>
    )
  }
  // a panel of two groups names each; one group needs no name beyond its tab's
  const grouped = files.length > 0 && links.length > 0
  return (
    <>
      <div className="work-meta">
        <span>{sharedSummary(model.shared)}</span>
      </div>
      {files.length > 0 && (
        <>
          {grouped && <h3 className="ns-label">Sent to you</h3>}
          <ul className="work-shared">
            {files.map((f, i) => (
              <SharedFileBlock
                key={f.path}
                file={f}
                cwd={cwd}
                sessionId={sessionId}
                // few enough to look at at once open by default, as edits do; a row opens its own
                open={files.length <= 3 || (i === 0 && focus.key === null) || f.key === focus.key}
                focusAt={f.key === focus.key ? focus.at : null}
                captioned={files[i - 1]?.key !== f.key}
              />
            ))}
          </ul>
        </>
      )}
      {links.length > 0 && (
        <>
          {grouped && <h3 className="ns-label">Pages it opened</h3>}
          <ul className="work-links">
            {links.map((l) => (
              <li key={l.url} className="work-link">
                <button className="link-btn" title={l.url} onClick={() => onOpenUrl(l.url)}>
                  {l.title ?? pageLabel(l.url)}
                </button>
                {l.title && <span className="work-check-meta work-link-url">{pageLabel(l.url)}</span>}
                {l.ts && <span className="work-check-meta work-check-time">{fmtTime(l.ts, fmt)}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}

function SharedFileBlock({
  file,
  cwd,
  sessionId,
  open: openByDefault,
  focusAt,
  captioned
}: {
  file: SharedFileEntry
  cwd: string
  sessionId: string | null
  open: boolean
  /** The first of its call's files: the call's caption is said once */
  captioned: boolean
  /** Set when a row opened the panel at this file: open it, bring it into view, ring it */
  focusAt: number | null
}): JSX.Element {
  const fmt = useTimeFormat()
  const [open, setOpen] = useState(openByDefault)
  const [ringed, setRinged] = useTransient<true>(RING_MS)
  const ref = useRef<HTMLLIElement>(null)
  const name = file.path.split('/').pop() ?? file.path
  // where it is, as a person reads a path: under the session's directory relative to it,
  // anywhere else with the home folded to ~
  const parent = file.path.slice(0, file.path.length - name.length - 1) || '/'
  const dir = parent === cwd ? '.' : parent.startsWith(`${cwd}/`) ? relative(parent, cwd) : shortPath(parent)

  useEffect(() => {
    if (focusAt === null) return
    setOpen(true)
    setRinged(true)
    ref.current?.scrollIntoView({ block: 'nearest' })
  }, [focusAt])

  // read on opening, and again when the agent hands the same path over anew; the error
  // line is shared with Open and Show in Finder
  const {
    value: preview,
    error,
    setError
  } = useLoaded(open && sessionId ? () => api.readSessionFile(sessionId, file.path) : null, [
    open,
    sessionId,
    file.path,
    file.key
  ])

  const act = (how: 'open' | 'reveal'): void => {
    if (!sessionId) return
    setError(null)
    api
      .openSessionFile(sessionId, file.path, how)
      .then((failure) => setError(failure))
      .catch((err: unknown) => setError(ipcErrorText(err)))
  }
  const missing = preview?.kind === 'missing'

  return (
    <li ref={ref} className={`work-shared-file${ringed ? ' ringed' : ''}`} data-work-key={file.key}>
      <details
        className="idiff review-file work-file"
        open={open}
        onToggle={(e) => {
          // a details element reports its first paint too: only a change is a choice
          if (e.currentTarget.open !== open) setOpen(e.currentTarget.open)
        }}
      >
        <summary className="idiff-head plain">
          <span className="idiff-path" title={file.path}>
            {name}
          </span>
          {missing && <span className="review-kind tone-dim">gone</span>}
          {preview && preview.kind !== 'missing' && <span className="work-count">{fileSize(preview.size)}</span>}
          {file.ts && <span className="work-count">{fmtTime(file.ts, fmt)}</span>}
        </summary>
        {open && (
          <div className="work-shared-body">
            <div className="work-shared-where">
              <span className="work-check-meta work-shared-dir" title={file.path}>
                {dir}
              </span>
              <span className="work-check-meta">· {file.toolName}</span>
            </div>
            {captioned && file.caption && <p className="work-note">{file.caption}</p>}
            <FilePreview preview={preview} name={name} waiting={!!sessionId && preview === null && !error} />
            {error && (
              <p className="review-error" role="alert">
                {error}
              </p>
            )}
            {sessionId && preview && !missing && (
              <div className="work-shared-actions">
                {preview.openable && (
                  <button className="btn-ghost small" onClick={() => act('open')}>
                    Open
                  </button>
                )}
                <button className="btn-ghost small" onClick={() => act('reveal')}>
                  Show in Finder
                </button>
              </div>
            )}
          </div>
        )}
      </details>
    </li>
  )
}

/** A shared file drawn in the panel: the image itself, the head of the text, or why not. */
function FilePreview({
  preview,
  name,
  waiting
}: {
  preview: SessionFilePreview | null
  name: string
  waiting: boolean
}): JSX.Element | null {
  const [url, setUrl] = useState<string | null>(null)
  // the renderer may load blob: images, never file: — main sends the bytes
  useEffect(() => {
    if (preview?.kind !== 'image' || typeof URL.createObjectURL !== 'function') return
    const u = URL.createObjectURL(new Blob([preview.data as BlobPart], { type: preview.mime }))
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [preview])

  if (waiting) return <p className="work-note">Reading the file…</p>
  if (!preview) return null
  switch (preview.kind) {
    case 'missing':
      return <p className="work-note">The file is no longer on disk. Agents often share files from a temporary folder.</p>
    case 'image':
      return url ? <img className="work-shared-image" src={url} alt={name} /> : null
    case 'text':
      return (
        <>
          {preview.markdown ? (
            <div className="markdown work-shared-md">
              <Markdown text={preview.text} />
            </div>
          ) : (
            <pre className="work-check-out work-shared-text">{preview.text}</pre>
          )}
          {preview.truncated && <p className="work-note">The rest of the file is not shown here.</p>}
        </>
      )
    case 'other':
      return (
        <p className="work-note">
          {preview.reason === 'size' ? 'Too large to preview here.' : 'No preview for this kind of file.'}
        </p>
      )
  }
}
