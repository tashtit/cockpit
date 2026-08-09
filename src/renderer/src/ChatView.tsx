import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import type { PermissionMode, Provider, PrStatus, SessionMessage } from '../../shared/types'
import type { ChatBinding } from './App'
import { BranchIcon, CockpitLogo, PrBadge, ProviderLogo, PROVIDER_LABEL } from './logos'

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
  return (
    <div className="codeblock">
      <button
        className={`code-copy ${copied ? 'copied' : ''}`}
        aria-label="Copy code"
        onClick={() => {
          void navigator.clipboard.writeText(nodeText(children))
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre>{children}</pre>
    </div>
  )
}

const MODES: Array<{ v: PermissionMode; label: string; hint: string }> = [
  { v: 'safe', label: 'Safe', hint: 'provider defaults; tools may be blocked headless' },
  { v: 'auto-edit', label: 'Auto-edit', hint: 'auto-approve file edits (Copilot: allows all tools)' },
  { v: 'yolo', label: 'YOLO', hint: 'bypass all approvals — trusted repos only' }
]

/** Big transcripts are already tail-capped in main; this bounds the DOM too. */
const RENDER_LAST = 400

export function ChatView({
  binding,
  prs,
  log,
  busy,
  onSend,
  onCancel,
  onCreatePr,
  onOpenUrl
}: {
  binding: ChatBinding | null
  prs: PrStatus[]
  log: SessionMessage[]
  busy: boolean
  onSend: (prompt: string, mode: PermissionMode) => void
  onCancel: () => void
  onCreatePr: () => void
  onOpenUrl: (url: string) => void
}): JSX.Element {
  const [draft, setDraft] = useState('')
  const [cwdCopied, setCwdCopied] = useState(false)
  const [mode, setMode] = useState<PermissionMode>(
    () => (window.localStorage.getItem('cockpit:mode') as PermissionMode) ?? 'auto-edit'
  )
  const scrollRef = useRef<HTMLDivElement>(null)
  const composerRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight })
  }, [log, busy])

  // focus follows the conversation: opening/starting a session lands in the composer
  useEffect(() => {
    if (binding) composerRef.current?.focus()
  }, [binding?.cwd, binding?.nativeSessionId === null])

  const branchPr = useMemo(
    () => (binding?.branch ? prs.find((p) => p.headRefName === binding.branch) : undefined),
    [prs, binding?.branch]
  )

  const sliced = log.length > RENDER_LAST ? log.slice(-RENDER_LAST) : log
  // providers repeat identical system notices; consecutive duplicates add nothing
  const visible = sliced.filter(
    (m, i) =>
      !(m.kind === 'system' && sliced[i - 1]?.kind === 'system' && sliced[i - 1].text === m.text)
  )
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
                {binding.branch}
              </span>
            )}
            <button
              className={`chat-cwd ${cwdCopied ? 'copied' : ''}`}
              title={`${binding.cwd}${binding.nativeSessionId ? `\nsession ${binding.nativeSessionId}` : ''}\nclick to copy path`}
              onClick={() => {
                void navigator.clipboard.writeText(binding.cwd)
                setCwdCopied(true)
                setTimeout(() => setCwdCopied(false), 1200)
              }}
            >
              {binding.cwd}
            </button>
            {!binding.nativeSessionId && ' · not started'}
          </div>
        </div>
        {branchPr ? (
          <PrBadge pr={branchPr} onOpen={onOpenUrl} />
        ) : (
          binding.repoRoot &&
          binding.branch && (
            <button className="btn-pr" disabled={busy} onClick={onCreatePr} title="Push branch and open a pull request">
              Create PR
            </button>
          )
        )}
        <select
          className="mode-select"
          value={mode}
          aria-label="Permission mode"
          title={MODES.find((m) => m.v === mode)?.hint}
          onChange={(e) => {
            const v = e.target.value as PermissionMode
            setMode(v)
            window.localStorage.setItem('cockpit:mode', v)
          }}
        >
          {MODES.map((m) => (
            <option key={m.v} value={m.v}>
              {m.label}
            </option>
          ))}
        </select>
      </header>

      <div className="messages" ref={scrollRef}>
        {hidden > 0 && <div className="sys-row">(showing the last {RENDER_LAST} of {log.length} messages)</div>}
        {visible.map((m, i) => (
          <Message
            key={log.length - visible.length + i}
            m={m}
            provider={binding.provider}
            resultOf={
              m.kind === 'tool_result' && visible[i - 1]?.kind === 'tool_call'
                ? visible[i - 1].toolName
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
            {/* ︎ forces text presentation — the bare gear renders as color emoji on some platforms */}
            {m.kind === 'tool_call' ? `⚙︎ ${m.toolName ?? 'tool'}` : `↳ ${resultOf ?? 'result'}`}
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
