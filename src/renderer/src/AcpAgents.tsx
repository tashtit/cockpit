import { useEffect, useRef, useState, type JSX } from 'react'
import type { AcpAgent, AcpAgentProbe, SessionProvider } from '../../shared/types'
import { acpAgentRefusal } from '../../shared/acp'
import { isDrivable, SESSION_PROVIDERS } from '../../shared/providers'
import { api } from './api'
import { refreshAcpReadiness, useAcpReadiness } from './acp-readiness'
import { ConfirmRemove, useArmedConfirm } from './ConfirmRemove'
import { ipcErrorText } from './ipc-error'
import { ProviderMark, PROVIDER_LABEL } from './logos'
import { Select } from './Select'
import { useLoaded } from './use-loaded'
import { ErrorAlert } from './ErrorAlert'

/**
 * Agents Cockpit drives over ACP: the list, the add form, and removal.
 *
 * Its own component for the same reason `ModelProviders` is — a form's worth of state
 * that would otherwise re-render the whole Settings card on every keystroke. `onStatus`
 * feeds Settings' sr-only announcer.
 */
export function AcpAgents({ onStatus }: { onStatus: (msg: string) => void }): JSX.Element {
  // optional call: during dev HMR the renderer can outrun a preload that predates
  // this method — a missing bridge must not take the whole Settings view down
  const { value: agents, set: setAgents } = useLoaded(api.getAcpAgents ? () => api.getAcpAgents() : null, [], {
    initial: [] as AcpAgent[]
  })
  const [label, setLabel] = useState('')
  const [provider, setProvider] = useState<SessionProvider>('claude')
  const { builtinsReady } = useAcpReadiness()
  // a built-in's CLI installed since launch is found here too, not only by the start forms
  useEffect(() => refreshAcpReadiness(), [])
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

  const say = (msg: string): void => {
    setNotice(msg)
    onStatus(msg)
  }

  /** The definition the form currently describes; `null` when it is not usable yet. */
  const draft = (): { label: string; provider: SessionProvider; command: string; args?: string[] } | null => {
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

  // main mints an id per add: a second submit in flight was a second agent
  const adding = useRef(false)
  const [addBusy, setAddBusy] = useState(false)
  const add = async (): Promise<void> => {
    setError(null)
    const d = draft()
    if (!d || adding.current) return
    adding.current = true
    setAddBusy(true)
    try {
      setAgents(await api.addAcpAgent(d))
      setLabel('')
      setCommand('')
      setArgs('')
      setProbe(null)
      setAddOpen(false)
      say(
        isDrivable(d.provider)
          ? `Added ${d.label}. New ${PROVIDER_LABEL[d.provider]} sessions will run through it.`
          : `Added ${d.label}. ${PROVIDER_LABEL[d.provider]} sessions can be started and continued through it.`
      )
    } catch (err) {
      setError(ipcErrorText(err))
    } finally {
      adding.current = false
      setAddBusy(false)
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
        agent says which CLI it drives, so its work still appears in your sessions. For an agent
        Cockpit otherwise only reads, one of these is what lets you start and continue its
        sessions here.
      </p>
      <ul className="source-list">
        {agents.map((agent) => (
          <li key={agent.id} className={`source-row tint-${agent.provider}`}>
            <ProviderMark p={agent.provider} decorative />
            <div className="source-body">
              <div className="source-label">
                {agent.label}
                <span className="acct-chip">{PROVIDER_LABEL[agent.provider]}</span>
                {agent.builtin && <span className="source-origin">built in</span>}
              </div>
              <div className="source-path" title={`${agent.command} ${(agent.args ?? []).join(' ')}`}>
                {agent.command} {(agent.args ?? []).join(' ')}
              </div>
            </div>
            {agent.builtin ? (
              <div className="source-health">
                {/* the handshake is the only test: a CLI that is missing, or too old to
                    speak ACP, simply never answers */}
                <span className="source-note">{builtinNote(agent, builtinsReady.includes(agent.id), agents)}</span>
              </div>
            ) : (
              <ConfirmRemove
                id={agent.id}
                armed={confirm.armed}
                label={`Remove agent ${agent.label} — ${agent.command}`}
                confirmLabel={`Confirm removing agent ${agent.label}`}
                confirmTitle={
                  isDrivable(agent.provider)
                    ? `New ${PROVIDER_LABEL[agent.provider]} sessions go back to its own CLI. Existing sessions are unaffected.`
                    : `Cockpit stops running ${PROVIDER_LABEL[agent.provider]} through it. Existing sessions are unaffected.`
                }
                onArm={confirm.arm}
                onDisarm={confirm.disarm}
                onConfirm={() => void remove(agent)}
              />
            )}
          </li>
        ))}
        {agents.length === 0 && <li className="tree-empty">no ACP agents</li>}
      </ul>
      {removeError && <ErrorAlert>{removeError}</ErrorAlert>}
      {notice && !error && <p className="ns-hint">{notice}</p>}
      {!addOpen && (
        <div className="source-add-open">
          {/* every built-in, now: one installed since is found, and one whose CLI has
              gone or broken stops being used */}
          <button
            className="btn-ghost small"
            onClick={() => {
              refreshAcpReadiness({ recheck: true })
              say('Checking the built-in agents again — each row updates as its CLI answers.')
            }}
          >
            Check the built-ins again
          </button>
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
                options={SESSION_PROVIDERS.map((p) => ({
                  value: p,
                  label: PROVIDER_LABEL[p]
                }))}
                onChange={(v) => setProvider(v as SessionProvider)}
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
          {probe?.ok && (
            <p className="ns-hint">
              {`Answered: ${probe.name ?? 'an ACP agent'}${probe.version ? ` ${probe.version}` : ''}` +
                ` · ACP v${probe.protocolVersion ?? '?'}` +
                ` · ${probe.loadSession ? 'can resume sessions' : 'cannot resume sessions'}` +
                (probe.authMethods?.length ? ` · sign in with: ${probe.authMethods.join(', ')}` : '')}
            </p>
          )}
          {probe && !probe.ok && <ErrorAlert>{probe.error}</ErrorAlert>}
          {error && <ErrorAlert>{error}</ErrorAlert>}
          <div className="ns-actions">
            <button type="button" className="btn-ghost" onClick={() => void runProbe()} disabled={probing}>
              {probing ? 'Testing…' : 'Test'}
            </button>
            <button type="submit" className="btn-primary" disabled={addBusy}>
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

/**
 * What a built-in's row says: whether its CLI answered, and which transport that agent's
 * turns take — an agent the person defined for the same CLI wins over the built-in, the
 * way main's `acpAgentFor` picks.
 */
function builtinNote(agent: AcpAgent, ready: boolean, agents: readonly AcpAgent[]): string {
  const defined = agents.find((a) => !a.builtin && a.provider === agent.provider)
  if (defined) return `${ready ? 'answered — ' : ''}${defined.label} is used instead`
  return ready ? 'answered — in use' : 'used once its CLI answers'
}
