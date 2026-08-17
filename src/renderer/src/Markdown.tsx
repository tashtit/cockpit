import { useEffect, useState, type JSX, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'

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
      <pre>{children}</pre>
    </div>
  )
}

/**
 * The app's one markdown pipeline: GFM + syntax highlighting + copyable code
 * blocks. Chat replies and the instructions preview render through this same
 * component so the two surfaces can never drift. Style with the `.markdown`
 * class on the container.
 */
export function Markdown({ text }: { text: string }): JSX.Element {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{ pre: CodeBlock }}
    >
      {text}
    </ReactMarkdown>
  )
}
