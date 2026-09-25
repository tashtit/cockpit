import { Suspense, lazy, memo, type JSX } from 'react'
import { ErrorBoundary } from './ErrorBoundary'

/**
 * Markdown, everywhere the app renders it — chat replies, the instructions
 * preview. Style with the `.markdown` class on the container.
 *
 * The pipeline behind it (react-markdown + GFM + the syntax highlighter and its
 * grammars) is roughly a third of the renderer bundle and nothing needs it to
 * paint the board, settings or the sidebar, so it rides in its own chunk. App
 * warms that chunk right after the window appears, which is long before anyone
 * can open a transcript — so the plain-text fallback below is what a test or a
 * very fast click sees, never a flash during normal use.
 */
const Pipeline = lazy(() =>
  import('./MarkdownPipeline').then((m) => ({ default: m.MarkdownPipeline }))
)

/** Pull the pipeline's chunk in now, so the first transcript renders formatted. */
export function preloadMarkdown(): void {
  void import('./MarkdownPipeline')
}

/**
 * Past this, a message renders as plain text. The pipeline runs synchronously in
 * render, and its cost grows faster than the text: a 100KB table held the window for
 * about three seconds, a 50-column one for nine. Replies this long are logs and dumps,
 * which read fine unformatted — a frozen window reads as a crash.
 */
const MARKDOWN_MAX_CHARS = 64 * 1024

/**
 * Memoized on the text: a row drawn again with the same words — the Work panel folded
 * again, a table's transcript growing — must not run the pipeline; and one mounted
 * again (a session reopened, earlier rows shown) finds what the pipeline drew lately
 * in its own cache.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }): JSX.Element {
  const plain = <pre className="md-plain">{text}</pre>
  if (text.length > MARKDOWN_MAX_CHARS) return plain
  // A reply the pipeline can't draw falls back to its own text, in its own row: three
  // thousand nested `>` overflow the stack inside it, and without this boundary that
  // throw took the whole window down — again every time that session was opened.
  return (
    <ErrorBoundary fallback={plain} resetKey={text}>
      <Suspense fallback={plain}>
        <Pipeline text={text} />
      </Suspense>
    </ErrorBoundary>
  )
})
