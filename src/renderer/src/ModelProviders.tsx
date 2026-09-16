import { useEffect, useState, type JSX } from 'react'
import type {
  ModelEndpoint,
  ModelEndpointType,
  NewModelEndpoint,
  WireApi
} from '../../shared/types'
import { endpointAgents } from '../../shared/endpoints'
import { api } from './api'
import { ConfirmRemove, useArmedConfirm } from './ConfirmRemove'
import { EndpointIcon, ProviderLogo, PROVIDER_LABEL } from './logos'
import { Select } from './Select'

/**
 * Custom model providers (BYOK): the list, the add form, and removal.
 *
 * Its own component on purpose — the ~10 form fields here are self-contained, so
 * keeping them out of Settings stops every keystroke from re-rendering the usage
 * meters and source list, and stops the ep* state from cross-wiring with the
 * source state next to it. `onStatus` feeds Settings' sr-only announcer.
 */
export function ModelProviders({ onStatus }: { onStatus: (msg: string) => void }): JSX.Element {
  const [endpoints, setEndpoints] = useState<ModelEndpoint[]>([])
  const [epLabel, setEpLabel] = useState('')
  const [epType, setEpType] = useState<ModelEndpointType>('openai')
  const [epUrl, setEpUrl] = useState('')
  const [epKey, setEpKey] = useState('')
  const [epWire, setEpWire] = useState<'' | WireApi>('')
  const [epHeaders, setEpHeaders] = useState('')
  const [epError, setEpError] = useState<string | null>(null)
  /** Visible outcome of the add + model-listing probe (the sr-only region mirrors it) */
  const [epNotice, setEpNotice] = useState<string | null>(null)
  /** Removal failures get their own slot — `epError` belongs to the add form below */
  const [removeError, setRemoveError] = useState<string | null>(null)
  /** The one row currently being given a key, and what has been typed into it */
  const [keying, setKeying] = useState<{ id: string; value: string } | null>(null)
  const [keyError, setKeyError] = useState<string | null>(null)
  /** Folded until asked for — the list is the readout, adding one is a task */
  const [addOpen, setAddOpen] = useState(false)
  const confirm = useArmedConfirm()

  useEffect(() => {
    // optional call: during dev HMR the renderer can outrun a preload that predates
    // this method — a missing bridge must not take the whole Settings view down
    void api.getModelEndpoints?.().then(setEndpoints)
  }, [])

  const notice = (msg: string): void => {
    setEpNotice(msg)
    onStatus(msg)
  }

  const addEndpoint = async (): Promise<void> => {
    setEpError(null)
    try {
      let headers: Record<string, string> | undefined
      if (epHeaders.trim() && epHeaders.trim() !== '{}') {
        try {
          headers = JSON.parse(epHeaders) as Record<string, string>
        } catch {
          throw new Error('Custom headers must be a JSON object, e.g. {"anthropic-version": "2023-06-01"}.')
        }
      }
      const def: NewModelEndpoint = {
        label: epLabel.trim(),
        type: epType,
        baseUrl: epUrl.trim(),
        apiKey: epKey.trim() || undefined,
        wireApi: epType === 'openai' && epWire ? epWire : undefined,
        headers
      }
      const before = endpoints
      const after = await api.addModelEndpoint(def)
      setEndpoints(after)
      setAddOpen(false)
      setEpLabel('')
      setEpUrl('')
      setEpKey('')
      setEpWire('')
      setEpHeaders('')
      notice(`Added ${def.label} — checking its model list…`)
      // warm the model list so the session form can offer a picker; failure is advice, not an error
      const added = after.find((e) => !before.some((o) => o.id === e.id))
      if (added) {
        try {
          const models = await api.listEndpointModels(added.id)
          setEndpoints(await api.getModelEndpoints())
          notice(
            models.length > 0
              ? `Added ${def.label} — ${models.length} models found`
              : `Added ${def.label} — it did not list any models; type one when starting a session`
          )
        } catch (err) {
          notice(
            `Added ${def.label} — couldn't list models (${err instanceof Error ? err.message : err})`
          )
        }
      }
    } catch (err) {
      setEpError(err instanceof Error ? err.message : String(err))
    }
  }

  const saveKey = async (ep: ModelEndpoint): Promise<void> => {
    const key = keying?.value.trim()
    if (!key) return
    setKeyError(null)
    try {
      setEndpoints(await api.setEndpointKey(ep.id, key))
      setKeying(null)
      onStatus(`Key saved for ${ep.label}`)
    } catch (err) {
      setKeyError(`Could not save the key for ${ep.label}: ${err instanceof Error ? err.message : err}`)
    }
  }

  const removeEndpoint = async (ep: ModelEndpoint): Promise<void> => {
    confirm.disarm()
    setRemoveError(null)
    try {
      setEndpoints(await api.removeModelEndpoint(ep.id))
    } catch (err) {
      // its own state, not the add form's: `epError` is aria-wired to the Base URL
      // field, so reusing it would announce an untouched input as invalid
      setRemoveError(`Could not remove ${ep.label}: ${err instanceof Error ? err.message : err}`)
      return
    }
    setEpNotice(null)
    onStatus(`Removed provider ${ep.label}`)
  }

  if (typeof api.addModelEndpoint !== 'function') {
    // an orphaned dev window can pair an old preload with hot-reloaded renderer
    // code — say so up front instead of erroring after the form is filled in
    return (
      <p className="ns-hint">
        This window is running an older Cockpit bridge — restart the app to manage model providers.
      </p>
    )
  }

  return (
    <>
      <p className="ns-hint">
        Access models from other providers with your own API keys. Which agents a provider can run
        depends on its type — Copilot speaks all three (OpenAI-compatible, Azure, Anthropic), Claude
        only anthropic-type, and Codex none — each row shows the agents it works with. Pick a
        provider when starting a session. Keys stay private: encrypted with your OS keychain, never
        written to config, and sent only to the provider itself.
      </p>
      <ul className="source-list">
        {endpoints.map((ep) => {
          const agents = endpointAgents(ep)
            .map((p) => PROVIDER_LABEL[p])
            .join(' and ')
          return (
            <li key={ep.id} className="source-row">
              <span className="plogo" aria-hidden="true">
                <EndpointIcon size={13} />
              </span>
              <div className="source-body">
                <div className="source-label">
                  {ep.label}
                  <span className="acct-chip">
                    {ep.type}
                    {ep.wireApi ? ` · ${ep.wireApi}` : ''}
                  </span>
                  <span
                    className="repo-providers"
                    role="img"
                    aria-label={`works with ${agents}`}
                    title={`Works with ${agents}`}
                  >
                    {endpointAgents(ep).map((p) => (
                      <span key={p} className={`plogo plogo-${p}`}>
                        <ProviderLogo p={p} size={10} />
                      </span>
                    ))}
                  </span>
                </div>
                <div className="source-path" title={ep.baseUrl}>{ep.baseUrl}</div>
              </div>
              <div className="source-health">
                {keying?.id === ep.id ? (
                  <form
                    className="source-browse-row"
                    onSubmit={(e) => {
                      e.preventDefault()
                      void saveKey(ep)
                    }}
                  >
                    <input
                      type="password"
                      autoComplete="off"
                      aria-label={`API key for ${ep.label}`}
                      autoFocus
                      value={keying.value}
                      onChange={(e) => setKeying({ id: ep.id, value: e.target.value })}
                    />
                    <button type="submit" className="btn-ghost small" disabled={!keying.value.trim()}>
                      Save key
                    </button>
                  </form>
                ) : (
                  <>
                    <span className="source-note">
                      {ep.hasKey ? 'key in keychain' : 'no key'}
                      {ep.models && ep.models.length > 0 && <> · {ep.models.length} models</>}
                    </span>
                    {!ep.hasKey && (
                      // a restore brings provider definitions, never their keys —
                      // this is how one gets its key without being re-added
                      <button
                        className="btn-ghost small"
                        onClick={() => {
                          setKeyError(null)
                          setKeying({ id: ep.id, value: '' })
                        }}
                      >
                        Add key
                      </button>
                    )}
                  </>
                )}
              </div>
              <ConfirmRemove
                id={ep.id}
                armed={confirm.armed}
                label={`Remove provider ${ep.label} — ${ep.baseUrl}`}
                confirmLabel={`Confirm removing provider ${ep.label}`}
                confirmTitle="Deletes its stored key. Sessions started on this provider will refuse to resume until it is re-added."
                onArm={confirm.arm}
                onDisarm={confirm.disarm}
                onConfirm={() => void removeEndpoint(ep)}
              />
            </li>
          )
        })}
        {endpoints.length === 0 && <li className="tree-empty">no custom providers</li>}
      </ul>
      {removeError && <div role="alert" className="new-error">{removeError}</div>}
      {keyError && <div role="alert" className="new-error">{keyError}</div>}
      {/* the outcome of an add outlives the form it was typed into: adding folds the
          form away, and "12 models found" / "couldn't list models" is the answer */}
      {epNotice && !epError && <p className="ns-hint">{epNotice}</p>}
      {!addOpen && (
        <div className="source-add-open">
          <button className="btn-ghost small" onClick={() => setAddOpen(true)}>
            Add a model provider…
          </button>
        </div>
      )}
      {addOpen && (
      <form
        className="source-add"
        onSubmit={(e) => {
          e.preventDefault()
          void addEndpoint()
        }}
      >
        <div className="ns-options">
          <div className="ns-opt">
            <label className="ns-label" htmlFor="ep-label">Display name</label>
            <input
              id="ep-label"
              autoFocus
              placeholder="Anthropic"
              value={epLabel}
              onChange={(e) => setEpLabel(e.target.value)}
            />
          </div>
          <div className="ns-opt">
            <label className="ns-label" htmlFor="ep-type">Type</label>
            <Select
              id="ep-type"
              ariaLabel="Provider type"
              mono
              value={epType}
              options={[
                { value: 'openai', label: 'openai — any OpenAI-compatible', hint: 'Copilot' },
                { value: 'azure', label: 'azure', hint: 'Copilot' },
                { value: 'anthropic', label: 'anthropic', hint: 'Claude · Copilot' }
              ]}
              onChange={(v) => {
                setEpType(v as ModelEndpointType)
                if (v !== 'openai') setEpWire('')
              }}
            />
          </div>
          <div className="ns-opt source-opt-path">
            <label className="ns-label" htmlFor="ep-url">Base URL</label>
            <input
              id="ep-url"
              placeholder="https://api.anthropic.com"
              value={epUrl}
              aria-invalid={!!epError}
              aria-describedby={epError ? 'endpoint-add-error' : undefined}
              onChange={(e) => {
                setEpUrl(e.target.value)
                setEpError(null)
              }}
            />
          </div>
          <div className="ns-opt">
            <label className="ns-label" htmlFor="ep-key">API key · optional</label>
            <input
              id="ep-key"
              type="password"
              autoComplete="off"
              placeholder="sk-…"
              value={epKey}
              onChange={(e) => setEpKey(e.target.value)}
            />
          </div>
          {epType === 'openai' && (
            <div className="ns-opt">
              <label className="ns-label" htmlFor="ep-wire">Wire API</label>
              <Select
                id="ep-wire"
                ariaLabel="Wire API"
                mono
                value={epWire}
                options={[
                  { value: '', label: 'completions (default)' },
                  { value: 'responses', label: 'responses — GPT-5 series' }
                ]}
                onChange={(v) => setEpWire(v as '' | WireApi)}
              />
            </div>
          )}
          <div className="ns-opt">
            <label className="ns-label" htmlFor="ep-headers">Custom headers (JSON) · optional</label>
            <input
              id="ep-headers"
              placeholder='{"anthropic-version": "2023-06-01"}'
              value={epHeaders}
              onChange={(e) => setEpHeaders(e.target.value)}
            />
          </div>
        </div>
        {epError && <div id="endpoint-add-error" role="alert" className="new-error">{epError}</div>}
        <div className="ns-actions">
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              setAddOpen(false)
              setEpError(null)
            }}
          >
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={!epLabel.trim() || !epUrl.trim()}>
            Add provider
          </button>
        </div>
      </form>
      )}
    </>
  )
}
