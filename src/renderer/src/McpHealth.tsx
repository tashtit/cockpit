import { useState, type JSX } from 'react'
import type { PanelRow } from '../../shared/library'
import type { McpProbeResult, McpVersion, Provider } from '../../shared/types'
import { api } from './api'
import { ipcErrorText } from './ipc-error'
import { PROVIDER_LABEL } from './logos'
import type { Notice } from './notice'

/**
 * The two questions only an MCP server's row asks, each on its own line in the opened
 * row: is there a newer release of what it pins, and does it answer at all.
 */

/** What the pill says beside a version line — never the same words as the sentence. */
const VERSION_LABEL: Record<McpVersion['status'], string> = {
  update: 'update',
  current: 'up to date',
  unknown: 'not checked'
}

/**
 * The version question, which only a pinned server has: it runs exactly what the
 * definition says, so "there is a newer one" is news, and one button moves every
 * agent that runs it. An unpinned server installs the latest at each launch and
 * never gets this line — its own label already says so.
 */
export function McpVersionLine({
  row,
  version,
  busy,
  onUpdate
}: {
  row: PanelRow
  version: McpVersion
  busy: string | null
  onUpdate: (row: PanelRow, version: string) => void
}): JSX.Element {
  const latest = version.latest
  const said =
    version.status === 'update'
      ? `${version.pkg} is pinned to ${version.current}; ${version.registry} has ${version.latest}.`
      : version.status === 'current'
        ? `${version.current} is the newest ${version.registry} release of ${version.pkg}.`
        : `Couldn’t ask ${version.registry} about ${version.pkg} — ${version.detail ?? 'no answer'}.`
  return (
    <div className="pnl-ver">
      <span className="pnl-health-what">{said}</span>
      <span className={`mcp-status ${version.status}`}>{VERSION_LABEL[version.status]}</span>
      {version.status === 'update' && latest && (
        <div className="pnl-fix-actions">
          <button
            className="btn-ghost small"
            disabled={busy !== null}
            title="Rewrite the pinned version wherever this server is switched on — nothing else in the command changes"
            onClick={() => onUpdate(row, latest)}
          >
            {busy === row.id ? 'pinning…' : `Update to ${latest}`}
          </button>
        </div>
      )}
    </div>
  )
}

const MCP_STATUS_LABEL: Record<McpProbeResult['status'], string> = {
  ok: 'answers',
  'needs-auth': 'needs login',
  error: 'unreachable'
}

/** The pill says the state; this says what actually happened. Never both the same. */
const MCP_STATUS_SAID: Record<McpProbeResult['status'], string> = {
  ok: 'It answered a handshake.',
  'needs-auth': 'It answered, but wants you to sign in first.',
  error: 'It didn’t answer.'
}

/** Agents whose CLI has an `mcp login` command */
const LOGIN_AGENTS: readonly Provider[] = ['claude', 'codex']

/**
 * Whether the server answers — the one thing no switch can tell you. It lives on the
 * server's own row rather than in a tab of its own, because it is a fact about this
 * server and nothing else.
 */
export function McpHealth({
  row,
  repoRoot,
  setNotice
}: {
  row: PanelRow
  repoRoot: string | null
  setNotice: (n: Notice) => void
}): JSX.Element {
  const [status, setStatus] = useState<McpProbeResult | 'checking' | null>(null)
  const [loginBusy, setLoginBusy] = useState<Provider | null>(null)

  const check = async (): Promise<void> => {
    setStatus('checking')
    try {
      setStatus(await api.checkMcp(row.name))
    } catch (err) {
      setStatus({ status: 'error', detail: ipcErrorText(err) })
    }
  }

  const login = async (agent: Provider): Promise<void> => {
    setNotice({
      text: `Logging in to “${row.name}” with ${PROVIDER_LABEL[agent]} — finish the flow in your browser.`,
      kind: 'ok'
    })
    setLoginBusy(agent)
    try {
      setNotice({ text: await api.loginMcp(row.name, agent, repoRoot ?? undefined), kind: 'ok' })
      void check()
    } catch (err) {
      setNotice({ text: `Login failed: ${ipcErrorText(err)}`, kind: 'error' })
    } finally {
      setLoginBusy(null)
    }
  }

  const result = status === 'checking' || status === null ? null : status
  return (
    <div className="pnl-health">
      <span className="pnl-health-what">
        {status === null
          ? 'Cockpit hasn’t asked this server anything yet.'
          : status === 'checking'
            ? 'Asking the server…'
            : (result!.detail ?? MCP_STATUS_SAID[result!.status])}
      </span>
      {result && (
        <span className={`mcp-status ${result.status}`}>{MCP_STATUS_LABEL[result.status]}</span>
      )}
      <div className="pnl-fix-actions">
        {result?.status === 'needs-auth' &&
          row.holders
            .filter((a) => LOGIN_AGENTS.includes(a))
            .map((a) => (
              <button
                key={a}
                className="btn-ghost small"
                disabled={loginBusy !== null}
                title={`Run “${a} mcp login ${row.name}” — opens your browser`}
                onClick={() => void login(a)}
              >
                {loginBusy === a ? 'waiting…' : `Log in · ${PROVIDER_LABEL[a]}`}
              </button>
            ))}
        <button
          className="btn-ghost small"
          disabled={status === 'checking'}
          title="Run the configured command, or hit the URL"
          onClick={() => void check()}
        >
          {status === 'checking' ? 'checking…' : 'Check'}
        </button>
      </div>
    </div>
  )
}
