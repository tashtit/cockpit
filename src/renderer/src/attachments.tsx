import { useRef, useState, type ClipboardEvent, type JSX } from 'react'
import { api } from './api'

/** Mirrors MAX_CHAT_IMAGES in src/main/chat-images.ts (main enforces it; this is just UX). */
export const MAX_IMAGES = 8

/** A pasted image already persisted by main; url is a local blob: preview. */
export type ImageAttachment = { readonly path: string; readonly name: string; readonly url: string }

export type AttachmentsState = {
  readonly attachments: readonly ImageAttachment[]
  readonly error: string | null
  /** Composer textarea paste handler — captures image files, saves them via IPC */
  readonly onPaste: (e: ClipboardEvent<HTMLTextAreaElement>) => void
  readonly remove: (a: ImageAttachment) => void
  /** Current paths for a send; undefined when nothing is attached */
  readonly paths: () => readonly string[] | undefined
  /** Revoke previews and empty the row (after a send, or on conversation switch) */
  readonly clear: () => void
  /** Hand the attachments to another view, previews intact (Home → full form) */
  readonly release: () => readonly ImageAttachment[]
}

/** IPC rejections arrive wrapped ("Error invoking remote method '…': Error: …") — unwrap. */
function ipcErrorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '')
}

/**
 * Pasted-image state shared by every composer (chat, home quick composer, new
 * session form). Preview URLs are revoked on clear/remove but deliberately not on
 * unmount: StrictMode's throwaway mount and the Home → full-form handoff both
 * outlive a single mount, and an orphaned preview is bounded by MAX_IMAGES.
 */
export function useImageAttachments(initial?: readonly ImageAttachment[]): AttachmentsState {
  const [attachments, setAttachments] = useState<readonly ImageAttachment[]>(initial ?? [])
  const [error, setError] = useState<string | null>(null)
  // async saves land against the latest list, not the render they started from
  const ref = useRef(attachments)
  ref.current = attachments

  const attach = async (files: readonly File[]): Promise<void> => {
    let count = ref.current.length
    for (const f of files) {
      if (count >= MAX_IMAGES) {
        setError(`At most ${MAX_IMAGES} images per message.`)
        return
      }
      try {
        const bytes = new Uint8Array(await f.arrayBuffer())
        const path = await api.saveChatImage(bytes, f.type)
        const url = URL.createObjectURL(f)
        setAttachments((prev) => [...prev, { path, name: f.name || 'pasted image', url }])
        setError(null)
        count++
      } catch (err) {
        setError(ipcErrorText(err))
      }
    }
  }

  return {
    attachments,
    error,
    onPaste: (e) => {
      const files = Array.from(e.clipboardData.items)
        .filter((it) => it.kind === 'file' && it.type.startsWith('image/'))
        .map((it) => it.getAsFile())
        .filter((f): f is File => f !== null)
      if (files.length === 0) return
      e.preventDefault()
      void attach(files)
    },
    remove: (a) => {
      URL.revokeObjectURL(a.url)
      setAttachments((prev) => prev.filter((x) => x.path !== a.path))
    },
    paths: () => (ref.current.length > 0 ? ref.current.map((a) => a.path) : undefined),
    clear: () => {
      ref.current.forEach((a) => URL.revokeObjectURL(a.url))
      setAttachments([])
      setError(null)
    },
    release: () => {
      const out = ref.current
      setAttachments([])
      setError(null)
      return out
    }
  }
}

/** The chip row every composer renders above its textarea. */
export function AttachRow({ atts }: { atts: AttachmentsState }): JSX.Element | null {
  if (atts.attachments.length === 0 && !atts.error) return null
  return (
    <div className="composer-attach">
      {atts.attachments.map((a) => (
        <span className="attach-chip" key={a.path} title={a.path}>
          <img src={a.url} alt="" />
          <span className="attach-name">{a.name}</span>
          <button
            className="attach-remove"
            aria-label={`Remove ${a.name}`}
            onClick={() => atts.remove(a)}
          >
            ×
          </button>
        </span>
      ))}
      {atts.error && (
        <span className="attach-error" role="alert">
          {atts.error}
        </span>
      )}
    </div>
  )
}

/** Transcript-visible marker lines for a sent message's attachments. */
export function withImageMarks(prompt: string, images?: readonly string[]): string {
  const marks = images?.map((p) => `[image: ${p.split('/').pop() ?? p}]`).join('\n')
  return prompt && marks ? `${prompt}\n${marks}` : prompt || (marks ?? '')
}
