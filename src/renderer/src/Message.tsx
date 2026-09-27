import { memo, type JSX } from 'react'
import type { Provider, SessionMessage } from '../../shared/types'
import { artifactStat, planTitle, tabFor, type WorkTab } from '../../shared/work'
import { relativeTo } from './format'
import { DiffStat } from './InstructionDiff'
import { Markdown } from './Markdown'
import { ProviderLogo, WorkIcon } from './logos'
import { runSummary, type Row } from './transcript-rows'

/**
 * A folded run of tool calls: one line that says what the agent did, opening to the
 * rows themselves. Collapsed by default — a twelve-step run between two paragraphs
 * of prose buried the prose.
 */
export function ToolRun({
  rows,
  provider,
  cwd,
  onOpenWork
}: {
  rows: readonly Row[]
  provider: Provider
  cwd: string
  onOpenWork?: (key: number, tab: WorkTab) => void
}): JSX.Element {
  return (
    <details className="tool-run">
      <summary>
        <span className="tool-chip">
          <span aria-hidden="true">⚙︎ </span>
          work
        </span>
        <span className="tool-run-sum">{runSummary(rows)}</span>
      </summary>
      <div className="tool-run-rows">
        {rows.map((r) => (
          <Message
            key={r.key}
            m={r.m}
            provider={provider}
            result={r.result}
            cwd={cwd}
            workKey={r.key}
            onOpenWork={onOpenWork}
          />
        ))}
      </div>
    </details>
  )
}

/** A row's one-liner for what it hands the panel: the plan's title, where the list
 *  stands, the task it adds, the files an edit touched. */
function artifactHeadline(m: SessionMessage, cwd: string | undefined): string {
  const a = m.artifact
  if (!a) return m.preview ?? m.text
  switch (a.kind) {
    case 'plan':
      return planTitle(a.text)
    case 'todos': {
      const done = a.items.filter((t) => t.status === 'completed').length
      return a.items.length === 0 ? 'cleared the list' : `${done} of ${a.items.length} done`
    }
    case 'task-add':
      return a.items.join(' · ')
    case 'task-update':
      return m.preview ?? `#${a.id}`
    case 'edits':
      return relativeTo(a.files.map((f) => f.path).join(', '), cwd).slice(0, 120)
    case 'check':
      return relativeTo(m.preview ?? a.command, cwd).slice(0, 120)
    case 'follow-up':
      return a.title
    case 'shared': {
      // the names it handed over, then the pages — what a person looks for in the row
      const names = a.files.map((f) => f.split('/').pop() ?? f)
      const pages = a.links.map((l) => l.title ?? l.url)
      return [...names, ...pages].join(', ').slice(0, 120)
    }
  }
}

/** The first non-empty line of a tool's output: its verdict ("20 passed"), at a glance. */
function firstLine(text: string): string {
  return text.split('\n').find((l) => l.trim())?.trim() ?? ''
}

/** Memoized: during streaming only the last row's props change. */
export const Message = memo(function Message({
  m,
  provider,
  result,
  cwd,
  logKey,
  anchored = false,
  workKey,
  onOpenWork
}: {
  m: SessionMessage
  provider: Provider
  /** The tool_result answering this tool_call, folded into the same row */
  result?: SessionMessage
  /** The session's directory — paths under it render relative */
  cwd?: string
  /** The row's absolute log offset, on the element so a search anchor can find it */
  logKey?: number
  /** The message a transcript search landed on — rings for a moment */
  anchored?: boolean
  /** The row's log offset for the Work panel, where `logKey` is left off (a folded run) */
  workKey?: number
  /** Opens the Work panel at this row — a row carrying a plan, to-dos or an edit is
   *  one click from it. Absent (a roundtable) keeps the ordinary tool row. */
  onOpenWork?: (key: number, tab: WorkTab) => void
}): JSX.Element {
  const ring = anchored ? ' anchored' : ''
  const key = logKey ?? workKey
  if (m.kind === 'tool_call' && m.artifact && onOpenWork && key !== undefined) {
    const a = m.artifact
    const headline = artifactHeadline(m, cwd)
    return (
      <button
        className={`tool-row tool-open${ring}`}
        data-log-key={logKey}
        title="Open in the Work panel"
        onClick={() => onOpenWork(key, tabFor(a))}
      >
        <span className="tool-chip">
          <span aria-hidden="true">⚙︎ </span>
          {m.toolName ?? 'tool'}
        </span>
        <code className="tool-preview">{headline}</code>
        {a.kind === 'edits' && !m.failed && <DiffStat {...artifactStat(a)} />}
        {/* a check says how it ended; a check that failed ran, it didn't fail to apply */}
        {a.kind === 'check' && a.status && (
          <span className={`tool-verdict ${a.status === 'passed' ? 'tone-ok' : 'tone-danger'}`}>{a.status}</span>
        )}
        {a.kind === 'follow-up' && a.dismissed && <span className="tool-verdict tone-dim">withdrawn</span>}
        {m.failed && a.kind !== 'check' && <span className="tool-failed">didn't apply</span>}
        <span className="tool-open-go" aria-hidden="true">
          <WorkIcon size={11} />
        </span>
        <span className="sr-only"> — open in the Work panel</span>
      </button>
    )
  }
  if (m.kind === 'tool_call' || m.kind === 'tool_result') {
    const call = m.kind === 'tool_call'
    const peek = result ? firstLine(result.text) : ''
    return (
      <details className={`tool-row${ring}`} data-log-key={logKey}>
        <summary>
          <span className="tool-chip">
            {/* ︎ forces text presentation — the bare gear renders as color emoji on some
                platforms; aria-hidden keeps screen readers from reading the glyph aloud */}
            <span aria-hidden="true">{call ? '⚙︎ ' : '↳ '}</span>
            {call ? (m.toolName ?? 'tool') : 'result'}
          </span>
          <code className="tool-preview">{relativeTo(m.preview ?? m.text, cwd).slice(0, 120)}</code>
          {peek && (
            // a short verdict ("ok", "20 passed") keeps its place in a narrow row; a long
            // first line gives the width back to the command (see `@container tool`)
            <span className={`tool-peek${peek.length <= 12 ? ' tool-peek-short' : ''}`}>
              <span className="sr-only">result: </span>
              {peek.slice(0, 60)}
            </span>
          )}
        </summary>
        <pre className="tool-full">{relativeTo(m.text, cwd)}</pre>
        {result && (
          <pre className="tool-full tool-out">
            <span className="tool-out-label" aria-hidden="true">↳ </span>
            {relativeTo(result.text, cwd)}
          </pre>
        )}
      </details>
    )
  }
  if (m.kind === 'system') {
    return (
      <div className={`sys-row${ring}`} data-log-key={logKey}>
        {m.text}
      </div>
    )
  }
  if (m.role === 'user') {
    return (
      <div className={`msg msg-user${ring}`} data-log-key={logKey}>
        <div className="bubble bubble-user">
          <pre>{m.text}</pre>
        </div>
      </div>
    )
  }
  return (
    <div
      className={`msg msg-assistant${m.kind === 'reasoning' ? ' reasoning' : ''}${ring}`}
      data-log-key={logKey}
    >
      <span className={`avatar plogo-${provider}`} aria-hidden="true">
        <ProviderLogo p={provider} size={14} />
      </span>
      <div className="assistant-body markdown">
        {m.streaming ? (
          // the in-flight message grows on every ~40ms flush — re-running the full
          // markdown+highlight pipeline over it each time is O(n²) per reply, so
          // stream as plain text and markdownify once when the turn completes
          <p className="streaming-plain">{m.text}</p>
        ) : (
          <Markdown text={m.text} />
        )}
      </div>
    </div>
  )
})
