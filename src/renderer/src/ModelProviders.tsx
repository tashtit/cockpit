import { useEffect, useRef, useState, type JSX } from 'react'
import type { EndpointAuth, ModelEndpoint, NewModelEndpoint, WireApi } from '../../shared/types'
import { ENDPOINT_PRESETS, endpointAgents, type EndpointPreset } from '../../shared/endpoints'
import { api } from './api'
import { ConfirmRemove, useArmedConfirm } from './ConfirmRemove'
import { ipcErrorText } from './ipc-error'
import { EndpointIcon, ProviderLogo, PROVIDER_LABEL } from './logos'
import { Select } from './Select'

const DEFAULT_PRESET = ENDPOINT_PRESETS[0]

/** "Claude · Copilot" — the agents a provider class serves, as the pickers annotate it */
const agentsHint = (p: Pick<EndpointPreset, 'type'>): string =>
  endpointAgents(p).map((a) => PROVIDER_LABEL[a]).join(' · ')

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
  /** The provider the form starts from — it fills every field below with what works */
  const [preset, setPreset] = useState<EndpointPreset>(DEFAULT_PRESET)
  const [epLabel, setEpLabel] = useState(DEFAULT_PRESET.name)
  const [epUrl, setEpUrl] = useState(DEFAULT_PRESET.baseUrl)
  const [epKey, setEpKey] = useState('')
  const [epWire, setEpWire] = useState<'' | WireApi>(DEFAULT_PRESET.wireApi ?? '')
  const [epAuth, setEpAuth] = useState<EndpointAuth>(DEFAULT_PRESET.auth ?? 'key')
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

  const pickPreset = (id: string): void => {
    const next = ENDPOINT_PRESETS.find((p) => p.id === id) ?? DEFAULT_PRESET
    // a field still holding the last provider's suggestion follows the new one;
    // anything typed over it stays
    if (!epLabel.trim() || epLabel === preset.name) setEpLabel(next.name)
    if (!epUrl.trim() || epUrl === preset.baseUrl) setEpUrl(next.baseUrl)
    setEpWire(next.wireApi ?? '')
    setEpAuth(next.auth ?? 'key')
    // a field the new provider doesn't show must not carry a value it can't see
    if (!next.ask.includes('headers')) setEpHeaders('')
    setPreset(next)
    setEpError(null)
  }

  const resetForm = (): void => {
    setPreset(DEFAULT_PRESET)
    setEpLabel(DEFAULT_PRESET.name)
    setEpUrl(DEFAULT_PRESET.baseUrl)
    setEpKey('')
    setEpWire(DEFAULT_PRESET.wireApi ?? '')
    setEpAuth(DEFAULT_PRESET.auth ?? 'key')
    setEpHeaders('')
  }

  const notice = (msg: string): void => {
    setEpNotice(msg)
    onStatus(msg)
  }

  // a double click or a second Enter while the first add is in flight added the
  // provider twice — two rows, two keychain entries — since main mints an id per call
  const adding = useRef(false)
  const [addBusy, setAddBusy] = useState(false)
  const addEndpoint = async (): Promise<void> => {
    if (adding.current) return
    adding.current = true
    setAddBusy(true)
    setEpError(null)
    try {
      let headers: Record<string, string> | undefined
      if (epHeaders.trim() && epHeaders.trim() !== '{}') {
        try {
          headers = JSON.parse(epHeaders) as Record<string, string>
        } catch {
          throw new Error('Custom headers must be a JSON object, e.g. {"X-Tenant-Id": "team-a"}.')
        }
      }
      const def: NewModelEndpoint = {
        label: epLabel.trim(),
        type: preset.type,
        baseUrl: epUrl.trim(),
        apiKey: epKey.trim() || undefined,
        wireApi: preset.type === 'openai' && epWire ? epWire : undefined,
        // only an Anthropic-shaped API has two ways to take a key worth telling apart
        auth: preset.type === 'anthropic' ? epAuth : undefined,
        headers
      }
      const before = endpoints
      const after = await api.addModelEndpoint(def)
      setEndpoints(after)
      setAddOpen(false)
      resetForm()
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
          notice(`Added ${def.label} — couldn't list models (${ipcErrorText(err)})`)
        }
      }
    } catch (err) {
      setEpError(ipcErrorText(err))
    } finally {
      adding.current = false
      setAddBusy(false)
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
      setKeyError(`Could not save the key for ${ep.label}: ${ipcErrorText(err)}`)
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
      setRemoveError(`Could not remove ${ep.label}: ${ipcErrorText(err)}`)
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
      <p className="ns-hint ns-prose">
        Models you bring your own key for — a gateway, a local server, or a vendor&apos;s API — to
        pick when starting a session. Each row says which agents can use it. Keys are encrypted with
        your OS keychain, never written to config, and sent only to that provider.
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
                    {ep.auth === 'bearer' ? ' · bearer' : ''}
                  </span>
                  <span className="repo-providers" aria-hidden="true">
                    {endpointAgents(ep).map((p) => (
                      <span key={p} className={`plogo plogo-${p}`}>
                        <ProviderLogo p={p} size={12} />
                      </span>
                    ))}
                  </span>
                  <span className="source-origin">works with {agents}</span>
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
                      placeholder="paste the API key"
                      autoFocus
                      value={keying.value}
                      onChange={(e) => setKeying({ id: ep.id, value: e.target.value })}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.stopPropagation()
                          setKeying(null)
                        }
                      }}
                    />
                    <button type="submit" className="btn-ghost small" disabled={!keying.value.trim()}>
                      Save key
                    </button>
                    <button type="button" className="btn-ghost small" onClick={() => setKeying(null)}>
                      Cancel
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
          <div className="ns-opt source-opt-provider">
            <label className="ns-label" htmlFor="ep-preset">Provider</label>
            <Select
              id="ep-preset"
              ariaLabel="Provider"
              autoFocus
              value={preset.id}
              options={ENDPOINT_PRESETS.map((p) => ({
                value: p.id,
                label: p.label,
                hint: agentsHint(p),
                title: p.baseUrl || p.label
              }))}
              onChange={pickPreset}
            />
          </div>
          <div className="ns-opt">
            <label className="ns-label" htmlFor="ep-label">Display name</label>
            <input
              id="ep-label"
              placeholder="LiteLLM"
              value={epLabel}
              onChange={(e) => setEpLabel(e.target.value)}
            />
          </div>
          <div className="ns-opt source-opt-path">
            <label className="ns-label" htmlFor="ep-url">Base URL</label>
            <input
              id="ep-url"
              placeholder={preset.urlExample}
              value={epUrl}
              aria-invalid={!!epError}
              aria-describedby={epError ? 'endpoint-add-error' : undefined}
              onChange={(e) => {
                setEpUrl(e.target.value)
                setEpError(null)
              }}
            />
          </div>
        </div>
        <div className="ns-options">
          <div className="ns-opt">
            <label className="ns-label" htmlFor="ep-key">
              {preset.keyOptional ? 'API key · optional' : 'API key'}
            </label>
            <input
              id="ep-key"
              type="password"
              autoComplete="off"
              placeholder={preset.keyExample}
              value={epKey}
              aria-describedby="ep-preset-note"
              onChange={(e) => setEpKey(e.target.value)}
            />
          </div>
          {preset.ask.includes('wireApi') && (
            <div className="ns-opt">
              <label className="ns-label" htmlFor="ep-wire">Wire API</label>
              <Select
                id="ep-wire"
                ariaLabel="Wire API"
                mono
                value={epWire}
                options={[
                  { value: '', label: 'completions' },
                  { value: 'responses', label: 'responses', hint: 'GPT-5 series' }
                ]}
                onChange={(v) => setEpWire(v as '' | WireApi)}
              />
            </div>
          )}
          {preset.ask.includes('auth') && (
            <div className="ns-opt">
              <label className="ns-label" htmlFor="ep-auth">Send key as</label>
              <Select
                id="ep-auth"
                ariaLabel="Send key as"
                mono
                value={epAuth}
                options={[
                  { value: 'bearer', label: 'Bearer', hint: 'Authorization header · most gateways' },
                  { value: 'key', label: 'x-api-key', hint: 'like the Anthropic API' }
                ]}
                onChange={(v) => setEpAuth(v as EndpointAuth)}
              />
            </div>
          )}
          {preset.ask.includes('headers') && (
            <div className="ns-opt">
              <label className="ns-label" htmlFor="ep-headers">Headers · optional</label>
              <input
                id="ep-headers"
                placeholder='{"X-Tenant-Id": "team-a"}'
                value={epHeaders}
                onChange={(e) => setEpHeaders(e.target.value)}
              />
            </div>
          )}
        </div>
        <p id="ep-preset-note" className="ns-hint">{preset.note}</p>
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
          <button
            type="submit"
            className="btn-primary"
            // a hosted API refuses every request without a key — adding one without it
            // would only store a provider no session can start on
            disabled={addBusy || !epLabel.trim() || !epUrl.trim() || (!preset.keyOptional && !epKey.trim())}
          >
            Add provider
          </button>
        </div>
      </form>
      )}
    </>
  )
}
