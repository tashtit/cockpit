import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExtensionsInventory, McpServerInfo, Provider } from '../../shared/types'
import { api } from './api'
import { ProviderLogo, PROVIDER_LABEL } from './logos'

const PROVIDERS: Provider[] = ['claude', 'codex', 'copilot']
type Tab = 'mcp' | 'skills' | 'plugins' | 'marketplace'

export function Extensions({
  onClose,
  onOpenUrl
}: {
  onClose: () => void
  onOpenUrl: (url: string) => void
}): JSX.Element {
  const [inv, setInv] = useState<ExtensionsInventory | null>(null)
  const [tab, setTab] = useState<Tab>('mcp')
  const [notice, setNotice] = useState<{ text: string; kind: 'ok' | 'error' } | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)

  const reload = useCallback(() => {
    void api.getExtensions().then(setInv)
  }, [])

  useEffect(() => {
    reload()
    headingRef.current?.focus()
  }, [reload])

  const share = async (server: McpServerInfo, to: Provider): Promise<void> => {
    setNotice(null)
    try {
      await api.shareMcp(server.name, to)
      setNotice({
        text: `Added "${server.name}" to ${PROVIDER_LABEL[to]} — restart that CLI to pick it up.`,
        kind: 'ok'
      })
      reload()
    } catch (err) {
      setNotice({ text: `Share failed: ${err instanceof Error ? err.message : err}`, kind: 'error' })
    }
  }

  return (
    <main className="chat settings-view">
      <div className="ns-card wide">
        <div className="ns-head">
          <h2 ref={headingRef} tabIndex={-1}>Extensions</h2>
          <button className="btn-ghost" onClick={onClose}>Close</button>
        </div>

        <div className="ext-tabs" role="tablist">
          {(
            [
              ['mcp', 'MCP Servers'],
              ['skills', 'Skills'],
              ['plugins', 'Plugins'],
              ['marketplace', 'Marketplace']
            ] as Array<[Tab, string]>
          ).map(([t, label]) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              className={`ext-tab ${tab === t ? 'active' : ''}`}
              onClick={() => setTab(t)}
            >
              {label}
            </button>
          ))}
        </div>

        {notice && <div className={`ext-notice ${notice.kind}`}>{notice.text}</div>}
        {!inv && <div className="tree-empty">loading…</div>}

        {inv && tab === 'mcp' && (
          <>
            <p className="ns-hint">
              MCP servers configured across your agents. Sharing writes the server into the target
              agent&apos;s own config format (<code>~/.claude.json</code>, <code>~/.codex/config.toml</code>,{' '}
              <code>~/.copilot/mcp-config.json</code>).
            </p>
            <ul className="ext-list">
              {inv.mcp.map((s) => (
                <li key={s.name} className="ext-row">
                  <div className="ext-body">
                    <div className="ext-name">{s.name}</div>
                    <div className="ext-detail" title={s.config.url ?? `${s.config.command ?? ''} ${(s.config.args ?? []).join(' ')}`}>
                      {s.config.url ?? `${s.config.command ?? '?'} ${(s.config.args ?? []).join(' ')}`}
                    </div>
                  </div>
                  <div className="ext-agents" aria-label={`Configured in ${s.agents.map((a) => PROVIDER_LABEL[a]).join(', ')}`}>
                    {s.agents.map((a) => (
                      <span key={a} className={`plogo plogo-${a}`} title={PROVIDER_LABEL[a]}>
                        <ProviderLogo p={a} size={13} />
                      </span>
                    ))}
                  </div>
                  <div className="ext-actions">
                    {PROVIDERS.filter((p) => !s.agents.includes(p)).map((p) => (
                      <button key={p} className="btn-ghost small" onClick={() => void share(s, p)}>
                        + {PROVIDER_LABEL[p]}
                      </button>
                    ))}
                  </div>
                </li>
              ))}
              {inv.mcp.length === 0 && <li className="tree-empty">no MCP servers configured in any agent</li>}
            </ul>
          </>
        )}

        {inv && tab === 'skills' && (
          <>
            <p className="ns-hint">
              Skills found in agent skill directories (<code>~/.claude/skills</code>,{' '}
              <code>~/.copilot/skills</code>). Plugin-provided skills live inside their plugin.
            </p>
            <ul className="ext-list">
              {inv.skills.map((s) => (
                <li key={`${s.agent}:${s.name}`} className="ext-row">
                  <span className={`plogo plogo-${s.agent}`} title={PROVIDER_LABEL[s.agent]}>
                    <ProviderLogo p={s.agent} size={13} />
                  </span>
                  <div className="ext-body">
                    <div className="ext-name">{s.name}</div>
                    <div className="ext-detail">{s.description || s.path}</div>
                  </div>
                </li>
              ))}
              {inv.skills.length === 0 && (
                <li className="tree-empty">no personal skills found — plugin skills are managed by their plugins</li>
              )}
            </ul>
          </>
        )}

        {inv && tab === 'plugins' && (
          <ul className="ext-list">
            {inv.plugins.map((p) => (
              <li key={`${p.agent}:${p.name}`} className="ext-row">
                <span className={`plogo plogo-${p.agent}`} title={PROVIDER_LABEL[p.agent]}>
                  <ProviderLogo p={p.agent} size={13} />
                </span>
                <div className="ext-body">
                  <div className="ext-name">{p.name}</div>
                  {p.detail && <div className="ext-detail">{p.detail}</div>}
                </div>
              </li>
            ))}
            {inv.plugins.length === 0 && <li className="tree-empty">no plugins installed</li>}
          </ul>
        )}

        {inv && tab === 'marketplace' && (
          <>
            <ul className="ext-list">
              {inv.marketplaces.map((m) => (
                <li key={m.name} className="ext-row">
                  <span className={`plogo plogo-${m.agent}`} title={PROVIDER_LABEL[m.agent]}>
                    <ProviderLogo p={m.agent} size={13} />
                  </span>
                  <div className="ext-body">
                    <div className="ext-name">{m.name}</div>
                    {m.source && <div className="ext-detail">{m.source}</div>}
                  </div>
                  {m.source && /^[\w.-]+\/[\w.-]+$/.test(m.source) && (
                    <button
                      className="btn-ghost small"
                      onClick={() => onOpenUrl(`https://github.com/${m.source}`)}
                    >
                      Open ↗
                    </button>
                  )}
                </li>
              ))}
              {inv.marketplaces.length === 0 && <li className="tree-empty">no marketplaces registered</li>}
            </ul>
            <p className="ns-hint">
              Browse more: install marketplaces with <code>claude plugin marketplace add &lt;repo&gt;</code>,
              or explore the{' '}
              <button className="link-btn" onClick={() => onOpenUrl('https://github.com/modelcontextprotocol/servers')}>
                MCP servers registry ↗
              </button>
            </p>
          </>
        )}
      </div>
    </main>
  )
}
