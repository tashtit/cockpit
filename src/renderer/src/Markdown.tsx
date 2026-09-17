import { Suspense, lazy, type JSX } from 'react'

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

export function Markdown({ text }: { text: string }): JSX.Element {
  return (
    <Suspense fallback={<pre className="md-plain">{text}</pre>}>
      <Pipeline text={text} />
    </Suspense>
  )
}
