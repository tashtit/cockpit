import { useEffect, useState, type JSX } from 'react'
import type { AcpAgent, AcpAgentProbe, Provider } from '../../shared/types'
import { acpAgentRefusal } from '../../shared/acp'
import { api } from './api'
import { ConfirmRemove, useArmedConfirm } from './ConfirmRemove'
import { ipcErrorText } from './ipc-error'
import { ProviderLogo, PROVIDER_LABEL } from './logos'
import { Select } from './Select'

/**
 * Agents Cockpit drives over ACP: the list, the add form, and removal.
 *
 * Its own component for the same reason `ModelProviders` is — a form's worth of state
 * that would otherwise re-render the whole Settings card on every keystroke. `onStatus`
 * feeds Settings' sr-only announcer.
 */
export function AcpAgents({ onStatus }: { onStatus: (msg: string) => void }): JSX.Element {
  const [agents, setAgents] = useState<AcpAgent[]>([])
  const [label, setLabel] = useState('')
  const [provider, setProvider] = useState<Provider>('claude')
  const [command, setCommand] = useState('')
  const [args, setArgs] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  /** Result of the last handshake against the form's definition */
  const [probe, setProbe] = useState<AcpAgentProbe | null>(null)
  const [probing, setProbing] = useState(false)
  /** Folded until asked for — the list is the readout, adding one is a task */
  const [addOpen, setAddOpen] = useState(false)
  const confirm = useArmedConfirm()

  useEffect(() => {
    // optional call: during dev HMR the renderer can outrun a preload that predates
    // this method — a missing bridge must not take the whole Settings view down
    void api.getAcpAgents?.().then(setAgents)
  }, [])

  const say = (msg: string): void => {
    setNotice(msg)
    onStatus(msg)
  }

  /** The definition the form currently describes; `null` when it is not usable yet. */
  const draft = (): { label: string; provider: Provider; command: string; args?: string[] } | null => {
    const parts = args.trim() ? args.trim().split(/\s+/) : []
    const d = { label: label.trim(), provider, command: command.trim(), ...(parts.length ? { args: parts } : {}) }
    const refusal = acpAgentRefusal(d)
    if (refusal) {
      setError(refusal)
      return null
    }
    return d
  }

  const runProbe = async (): Promise<void> => {
    setError(null)
    setProbe(null)
    const d = draft()
    if (!d) return
    setProbing(true)
    try {
      setProbe(await api.probeAcpAgent(d))
    } catch (err) {
      setError(ipcErrorText(err))
    } finally {
      setProbing(false)
    }
  }

  const add = async (): Promise<void> => {
    setError(null)
    const d = draft()
    if (!d) return
    try {
      setAgents(await api.addAcpAgent(d))
      setLabel('')
      setCommand('')
      setArgs('')
      setProbe(null)
      setAddOpen(false)
      say(`Added ${d.label}. New ${PROVIDER_LABEL[d.provider]} sessions will run through it.`)
    } catch (err) {
      setError(ipcErrorText(err))
    }
  }

  const remove = async (agent: AcpAgent): Promise<void> => {
    setRemoveError(null)
    try {
      setAgents(await api.removeAcpAgent(agent.id))
      say(`Removed ${agent.label}.`)
    } catch (err) {
      setRemoveError(ipcErrorText(err))
    }
  }

  return (
    <>
      <p className="ns-hint ns-prose">
        Agents that speak the Agent Client Protocol, which Cockpit drives over the protocol instead
        of that CLI&apos;s own one-shot flags. It is a better conversation: tool calls arrive as
        events, permission prompts can be answered here, and the session keeps its own id. Each
        agent says which CLI it drives, so its work still appears in your sessions.
      </p>
      <ul className="source-list">
        {agents.map((agent) => (
          <li key={agent.id} className={`source-row tint-${agent.provider}`}>
            <span className={`plogo plogo-${agent.provider}`} aria-hidden="true">
              <ProviderLogo p={agent.provider} size={13} />
            </span>
            <div className="source-body">
              <div className="source-label">
                {agent.label}
                <span className="acct-chip">{agent.provider}</span>
                {agent.builtin && <span className="source-origin">built in</span>}
              </div>
              <div className="source-path" title={`${agent.command} ${(agent.args ?? []).join(' ')}`}>
                {agent.command} {(agent.args ?? []).join(' ')}
              </div>
            </div>
            {agent.builtin ? (
              <div className="source-health">
                <span className="source-note">used when this CLI supports it</span>
              </div>
            ) : (
              <ConfirmRemove
                id={agent.id}
                armed={confirm.armed}
                label={`Remove agent ${agent.label} — ${agent.command}`}
                confirmLabel={`Confirm removing agent ${agent.label}`}
                confirmTitle={`New ${PROVIDER_LABEL[agent.provider]} sessions go back to its own CLI. Existing sessions are unaffected.`}
                onArm={confirm.arm}
                onDisarm={confirm.disarm}
                onConfirm={() => void remove(agent)}
              />
            )}
          </li>
        ))}
        {agents.length === 0 && <li className="tree-empty">no ACP agents</li>}
      </ul>
      {removeError && (
        <div role="alert" className="new-error">
          {removeError}
        </div>
      )}
      {notice && !error && <p className="ns-hint">{notice}</p>}
      {!addOpen && (
        <div className="source-add-open">
          <button className="btn-ghost small" onClick={() => setAddOpen(true)}>
            Add an ACP agent…
          </button>
        </div>
      )}
      {addOpen && (
        <form
          className="source-add"
          onSubmit={(e) => {
            e.preventDefault()
            void add()
          }}
        >
          <div className="ns-options">
            <div className="ns-opt">
              <label className="ns-label" htmlFor="acp-label">
                Display name
              </label>
              <input
                id="acp-label"
                autoFocus
                placeholder="Claude (ACP)"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
            </div>
            <div className="ns-opt">
              <label className="ns-label" htmlFor="acp-provider">
                Drives
              </label>
              <Select
                id="acp-provider"
                ariaLabel="Which agent this CLI drives"
                value={provider}
                options={(['claude', 'codex', 'copilot'] as Provider[]).map((p) => ({
                  value: p,
                  label: PROVIDER_LABEL[p]
                }))}
                onChange={(v) => setProvider(v as Provider)}
              />
            </div>
            <div className="ns-opt">
              <label className="ns-label" htmlFor="acp-command">
                Command
              </label>
              <input
                id="acp-command"
                placeholder="claude-code-acp"
                value={command}
                onChange={(e) => setCommand(e.target.value)}
              />
              <span className="ns-hint">
                An executable name, or its full path. A relative path is refused — it would resolve
                inside whichever repository the agent runs in.
              </span>
            </div>
            <div className="ns-opt">
              <label className="ns-label" htmlFor="acp-args">
                Arguments
              </label>
              <input
                id="acp-args"
                placeholder="--acp"
                value={args}
                onChange={(e) => setArgs(e.target.value)}
              />
            </div>
          </div>
          {probe && (
            <p className={probe.ok ? 'ns-hint' : 'new-error'} role={probe.ok ? undefined : 'alert'}>
              {probe.ok
                ? `Answered: ${probe.name ?? 'an ACP agent'}${probe.version ? ` ${probe.version}` : ''}` +
                  ` · ACP v${probe.protocolVersion ?? '?'}` +
                  ` · ${probe.loadSession ? 'can resume sessions' : 'cannot resume sessions'}` +
                  (probe.authMethods?.length ? ` · sign in with: ${probe.authMethods.join(', ')}` : '')
                : probe.error}
            </p>
          )}
          {error && (
            <div role="alert" className="new-error">
              {error}
            </div>
          )}
          <div className="ns-actions">
            <button type="button" className="btn-ghost" onClick={() => void runProbe()} disabled={probing}>
              {probing ? 'Testing…' : 'Test'}
            </button>
            <button type="submit" className="btn-primary">
              Add agent
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setAddOpen(false)
                setError(null)
                setProbe(null)
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </>
  )
}
