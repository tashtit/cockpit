import { useEffect, useState, type JSX, type ReactElement, type ReactNode } from 'react'
import ReactMarkdown, { type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import { api } from './api'

function nodeText(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (node && typeof node === 'object' && 'props' in node) {
    return nodeText((node as { props: { children?: ReactNode } }).props.children)
  }
  return ''
}

function CodeBlock({ children }: { children?: ReactNode }): JSX.Element {
  // copy must acknowledge — a click with no visible result reads as broken
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <div className="codeblock">
      <button
        className={`code-copy ${copied ? 'copied' : ''}`}
        aria-label="Copy code"
        onClick={() => {
          void navigator.clipboard.writeText(nodeText(children))
          setCopied(true)
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      {/* a long line makes this scroll sideways, and a region you can only reach
          with a pointer is not reachable at all (WCAG 2.1.1) — so it takes focus */}
      <pre tabIndex={0}>{children}</pre>
    </div>
  )
}

/**
 * A link in an agent's reply — a PR, a doc, a stack trace's source.
 *
 * The window itself must never navigate (main's `will-navigate` prevents it, since
 * this renderer holds `window.cockpit` and can spawn CLIs), so an `<a href>` left to
 * itself is a control that looks live and does nothing. It goes to the real browser
 * instead, through the same `openExternal` every other link in the app uses.
 *
 * Anything that isn't http(s) — a relative path, a bare `#anchor`, a `mailto:` — is
 * not somewhere this can send anyone: main refuses it, so it renders as its own text
 * rather than as a link that swallows clicks.
 */
function Link({ href, children }: { href?: string; children?: ReactNode }): JSX.Element {
  if (href === undefined || !/^https?:\/\//i.test(href)) return <>{children}</>
  return (
    <a
      href={href}
      title={href}
      onClick={(e) => {
        e.preventDefault()
        void api.openExternal(href)
      }}
    >
      {children}
    </a>
  )
}

/**
 * One highlighter for every message. rehype-highlight builds a lowlight of its own —
 * registering ~37 grammars — each time a processor is frozen, and react-markdown
 * builds a processor on every render, so each reply mounted paid for all of them
 * again. The transformer keeps nothing per document, so the one built here serves all.
 */
const highlight = rehypeHighlight()
const sharedHighlight = (): typeof highlight => highlight

/** Module-level, so no render hands the pipeline new plugin lists or components */
const OPTIONS = {
  remarkPlugins: [remarkGfm],
  rehypePlugins: [sharedHighlight],
  components: { pre: CodeBlock, a: Link }
} satisfies Options

/**
 * What the pipeline drew lately, by its text — reopening a session, showing earlier
 * rows or remounting a row parsed and highlighted every one of them again. Least
 * recently used first (a Map iterates in insertion order), and bounded by entries and
 * by the text they came from: a drawn tree is some multiple of its source.
 */
const drawn = new Map<string, ReactElement>()
let drawnChars = 0
const DRAWN_MAX = 500
const DRAWN_MAX_CHARS = 1_000_000

function draw(text: string): ReactElement {
  const hit = drawn.get(text)
  if (hit) {
    drawn.delete(text)
    drawn.set(text, hit)
    return hit
  }
  // react-markdown's sync component is a plain function with no hooks, so calling it
  // gives the element tree it would render — an immutable description, safe to reuse
  const tree = ReactMarkdown({ ...OPTIONS, children: text })
  drawn.set(text, tree)
  drawnChars += text.length
  while (drawn.size > DRAWN_MAX || drawnChars > DRAWN_MAX_CHARS) {
    const oldest = drawn.keys().next().value
    if (oldest === undefined) break
    drawn.delete(oldest)
    drawnChars -= oldest.length
  }
  return tree
}

/**
 * The app's one markdown pipeline: GFM + syntax highlighting + copyable code
 * blocks and links that open where links open. Chat replies and the instructions
 * preview render through this same component so the two surfaces can never drift.
 *
 * Nothing imports this directly — it is the lazy half of `Markdown.tsx`, which is
 * what callers use. react-markdown, remark-gfm and the highlighter's grammars are
 * about a third of the renderer bundle and no view needs them to paint, so they
 * load in their own chunk once the window is up.
 */
export function MarkdownPipeline({ text }: { text: string }): JSX.Element {
  return draw(text)
}
