import { useEffect, useState, type JSX, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
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
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{ pre: CodeBlock, a: Link }}
    >
      {text}
    </ReactMarkdown>
  )
}
