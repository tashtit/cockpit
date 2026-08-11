import { memo, useEffect, useMemo, useRef, useState, type JSX, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { PermissionMode, Provider, PrStatus, SessionMessage } from '../../shared/types'
import type { ChatBinding } from './App'
import { MODES } from './NewSession'
import { BranchIcon, CockpitLogo, PrBadge, ProviderLogo, PROVIDER_LABEL } from './logos'
import { Select } from './Select'

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

/** Big transcripts are already tail-capped in main; this bounds the DOM too. */
const RENDER_LAST = 400

export function ChatView({
  binding,
  prs,
  log,
  busy,
  prBusy,
  onSend,
  onCancel,
  onCreatePr,
  onOpenUrl
}: {
  binding: ChatBinding | null
  prs: PrStatus[]
  log: SessionMessage[]
  busy: boolean
  prBusy: boolean
  onSend: (prompt: string, mode: PermissionMode) => void
  onCancel: () => void
  onCreatePr: () => void
  onOpenUrl: (url: string) => void
}): JSX.Element {
  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<PermissionMode>(
    () => (window.localStorage.getItem('cockpit:mode') as PermissionMode) ?? 'auto-edit'
  )
  const [cwdCopied, setCwdCopied] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)
  /** Auto-scroll only while the user is pinned to the bottom — never hijack a scroll-up. */
  const atBottomRef = useRef(true)

  useEffect(() => {
    if (atBottomRef.current) scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [log, busy])

  useEffect(() => {
    if (!cwdCopied) return
    const t = setTimeout(() => setCwdCopied(false), 1500)
    return () => clearTimeout(t)
  }, [cwdCopied])

  // focus follows the conversation: opening/starting a session lands in the composer
  useEffect(() => {
    if (binding) composerRef.current?.focus()
  }, [binding?.cwd, binding?.nativeSessionId === null])

  // a freshly opened session always starts pinned to the bottom
  useEffect(() => {
    atBottomRef.current = true
  }, [binding])

  const branchPr = useMemo(
    () => (binding?.branch ? prs.find((p) => p.headRefName === binding.branch) : undefined),
    [prs, binding?.branch]
  )

  const sliced = log.length > RENDER_LAST ? log.slice(-RENDER_LAST) : log
  const base = log.length - sliced.length
  // providers repeat identical system notices; consecutive duplicates add nothing.
  // each row keeps its absolute log offset as the key — stable because the log is
  // append-only, even when the dedup filter drops rows in the middle.
  const visible: Array<{ m: SessionMessage; key: number }> = []
  sliced.forEach((m, i) => {
    if (m.kind === 'system' && sliced[i - 1]?.kind === 'system' && sliced[i - 1].text === m.text)
      return
    visible.push({ m, key: base + i })
  })
  const hidden = log.length - sliced.length

  // screen-reader announcement on turn completion/failure — not per streamed token
  const lastSys = [...log].reverse().find((m) => m.kind === 'system')
  const status = busy ? 'Assistant is working' : (lastSys?.text ?? (log.length ? 'Ready' : ''))

  const submit = (): void => {
    const p = draft.trim()
    if (!p || busy || !binding) return
    setDraft('')
    onSend(p, mode)
  }

  if (!binding) {
    return (
      <main className="chat">
        <div className="empty-chat">
          <CockpitLogo size={52} />
          <h2>Cockpit</h2>
          <p>Pick a repository, open a session — or start one in a fresh worktree and ship it as a PR.</p>
        </div>
      </main>
    )
  }

  return (
    <main className="chat">
      <header className="chat-header">
        <span className={`badge badge-${binding.provider}`}>
          <ProviderLogo p={binding.provider} size={11} /> {PROVIDER_LABEL[binding.provider]}
        </span>
        {/* compact: the local part identifies the account at a glance; the full
            identity lives in the tooltip (same pattern as the sidebar footer) */}
        <span
          className={`acct-chip acct-${binding.provider}`}
          title={`Running as ${binding.accountLabel ?? 'default account'}`}
        >
          {(binding.accountLabel ?? 'default account').split('@')[0]}
        </span>
        <div className="chat-header-text">
          <div className="chat-title">{binding.title}</div>
          <div className="chat-sub">
            {binding.branch && (
              <span className="branch-chip">
                <BranchIcon size={10} />
                <span className="chip-text">{binding.branch}</span>
              </span>
            )}
            <button
              className={`chat-cwd ${cwdCopied ? 'copied' : ''}`}
              title={`${binding.cwd}${binding.nativeSessionId ? `\nsession ${binding.nativeSessionId}` : ''}\nclick to copy path`}
              onClick={() => {
                void navigator.clipboard.writeText(binding.cwd)
                setCwdCopied(true)
              }}
            >
              {binding.cwd}
            </button>
            {cwdCopied && (
              <span className="copy-flash" role="status">
                copied
              </span>
            )}
            {!binding.nativeSessionId && ' · not started'}
          </div>
        </div>
        {branchPr ? (
          <PrBadge pr={branchPr} onOpen={onOpenUrl} />
        ) : (
          binding.repoRoot &&
          binding.branch && (
            <button
              className="btn-pr"
              disabled={busy || prBusy}
              onClick={onCreatePr}
              title="Push branch and open a pull request"
            >
              {prBusy ? 'Creating PR…' : 'Create PR'}
            </button>
          )
        )}
        <Select
          className="mode-select-wrap"
          value={mode}
          ariaLabel="Permission mode"
          options={MODES.map((m) => ({ value: m.v, label: m.label, title: m.hint }))}
          onChange={(v) => {
            setMode(v as PermissionMode)
            window.localStorage.setItem('cockpit:mode', v)
          }}
        />
      </header>

      <div
        className="messages"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget
          atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
        }}
      >
        {hidden > 0 && <div className="sys-row">(showing the last {RENDER_LAST} of {log.length} messages)</div>}
        {visible.map(({ m, key }, i) => (
          <Message
            key={key}
            m={m}
            provider={binding.provider}
            resultOf={
              m.kind === 'tool_result' && visible[i - 1]?.m.kind === 'tool_call'
                ? visible[i - 1].m.toolName
                : undefined
            }
          />
        ))}
        {busy && (
          <div className="thinking">
            <span className="pulse" /> {PROVIDER_LABEL[binding.provider]} is working…
          </div>
        )}
        {log.length === 0 && !busy && (
          <div className="empty-chat small">Send a prompt to start this session.</div>
        )}
      </div>
      <div className="sr-only" role="status" aria-live="polite">
        {status}
      </div>

      <footer className="composer">
        <textarea
          ref={composerRef}
          aria-label={`Message ${PROVIDER_LABEL[binding.provider]}`}
          placeholder={`Message ${PROVIDER_LABEL[binding.provider]}…  (Enter to send, Shift+Enter for newline)`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        {busy ? (
          <button className="btn-danger" onClick={onCancel}>
            Stop
          </button>
        ) : (
          <button className="btn-primary" disabled={!draft.trim()} onClick={submit}>
            Send
          </button>
        )}
      </footer>
    </main>
  )
}

/** Memoized: during streaming only the last row's props change. */
const Message = memo(function Message({
  m,
  provider,
  resultOf
}: {
  m: SessionMessage
  provider: Provider
  resultOf?: string
}): JSX.Element {
  if (m.kind === 'tool_call' || m.kind === 'tool_result') {
    return (
      <details className="tool-row">
        <summary>
          <span className="tool-chip">
            {/* ︎ forces text presentation — the bare gear renders as color emoji on some
                platforms; aria-hidden keeps screen readers from reading the glyph aloud */}
            <span aria-hidden="true">{m.kind === 'tool_call' ? '⚙︎ ' : '↳ '}</span>
            {m.kind === 'tool_call' ? (m.toolName ?? 'tool') : (resultOf ?? 'result')}
          </span>
          <code className="tool-preview">{m.text.slice(0, 120)}</code>
        </summary>
        <pre className="tool-full">{m.text}</pre>
      </details>
    )
  }
  if (m.kind === 'system') {
    return <div className="sys-row">{m.text}</div>
  }
  if (m.role === 'user') {
    return (
      <div className="msg msg-user">
        <div className="bubble bubble-user">
          <pre>{m.text}</pre>
        </div>
      </div>
    )
  }
  return (
    <div className={`msg msg-assistant ${m.streaming ? 'streaming' : ''} ${m.kind === 'reasoning' ? 'reasoning' : ''}`}>
      <span className={`avatar plogo-${provider}`} aria-hidden="true">
        <ProviderLogo p={provider} size={14} />
      </span>
      <div className="assistant-body markdown">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={{ pre: CodeBlock }}
        >
          {m.text}
        </ReactMarkdown>
      </div>
    </div>
  )
})
