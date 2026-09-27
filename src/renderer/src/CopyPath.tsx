import { useEffect, useState, type JSX } from 'react'

/** How long "copied" stays beside the path after a click */
const COPIED_MS = 1500

/**
 * The header's directory: a short label for where the conversation runs, the full path
 * one hover away and one click from the clipboard — a transient "copied" says it went.
 * The chat and the roundtable headers both carry it.
 */
export function CopyPath({
  path,
  label,
  detail
}: {
  /** What a click copies, and the tooltip's first line */
  path: string
  /** What the header shows in its place */
  label: string
  /** A line the tooltip adds under the path (the session's id) */
  detail?: string
}): JSX.Element {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(t)
  }, [copied])

  return (
    <>
      <button
        className={`chat-cwd ${copied ? 'copied' : ''}`}
        title={`${path}${detail ? `\n${detail}` : ''}\nclick to copy path`}
        onClick={() => {
          void navigator.clipboard.writeText(path)
          setCopied(true)
        }}
      >
        {label}
      </button>
      {copied && (
        <span className="copy-flash" role="status">
          copied
        </span>
      )}
    </>
  )
}
