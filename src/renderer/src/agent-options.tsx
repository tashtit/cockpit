import { useEffect, useState, type JSX } from 'react'
import type {
  AgentAccount,
  AgentModel,
  AgentOptions,
  CodexSandbox,
  ModelEndpoint,
  PermissionMode,
  SessionProvider
} from '../../shared/types'
import { effortsFor } from '../../shared/agent-models'
import { endpointSupports } from '../../shared/endpoints'
import { isDrivable } from '../../shared/providers'
import { accountRef, agentBlurb, modeHint, modeOptions, type AccountOption, type AgentChoice } from './agent-choice'
import { api } from './api'
import { ProviderLogo, PROVIDER_LABEL } from './logos'
import { Select } from './Select'
import { useLoaded } from './use-loaded'

/**
 * The pieces the New session and handoff forms are built from: the agent cards, the
 * `.ns-opt` cells of the option grid and the hints under it, and the per-agent option
 * state behind them — shared so the two forms can never drift apart.
 */

/** Per-agent option state (model / thinking / BYOK endpoint / codex sandbox). */
type AgentOptionsState = {
  /** The model that would run — one the catalog offers, or typed where none is known */
  readonly model: string
  readonly setModel: (m: string) => void
  /** The thinking level that would run — one the model takes, or '' for its default */
  readonly effort: string
  readonly setEffort: (e: string) => void
  /** Thinking levels on offer: the chosen model's own, else the agent's */
  readonly efforts: readonly string[]
  /** The level the chosen model runs at when none is picked, when its source says */
  readonly defaultEffort: string | undefined
  readonly codexSandbox: CodexSandbox | ''
  readonly setCodexSandbox: (s: CodexSandbox | '') => void
  readonly endpointId: string
  readonly setEndpointId: (id: string) => void
  readonly endpoints: ModelEndpoint[]
  readonly usableEndpoints: ModelEndpoint[]
  readonly endpoint: ModelEndpoint | undefined
  /** Every model to pick from: the custom provider's catalog, else what the agent offers
   *  under the chosen account. Null while that listing loads; empty when nothing lists
   *  what the backend serves (an Azure deployment) — the one case a model is typed. */
  readonly catalog: readonly AgentModel[] | null
  /** Copilot never learns a custom provider's catalog on its own — it needs an explicit model. */
  readonly modelMissing: boolean
  /** The composed per-agent options for ChatRequest */
  readonly options: AgentOptions
}

/**
 * `account` is the chosen account — its home, and in Copilot's the login — and each one
 * lists its own models. An agent driven over ACP has none of these knobs — its model and
 * account are its own settings — so for one the state is empty and its options are `{}`.
 */
export function useAgentOptions(provider: SessionProvider, account: AgentAccount | undefined): AgentOptionsState {
  const cli = isDrivable(provider) ? provider : null
  const [model, setModel] = useState('')
  const [effort, setEffort] = useState('')
  const [codexSandbox, setCodexSandbox] = useState<CodexSandbox | ''>('')
  // optional call: a preload from before this method must not crash the form (dev HMR)
  const { value: endpoints } = useLoaded(api.getModelEndpoints ? () => api.getModelEndpoints() : null, [], {
    initial: [] as ModelEndpoint[]
  })
  const [endpointId, setEndpointId] = useState('')
  /** Live model listings per provider id — cached `endpoint.models` until the fetch lands */
  const [endpointModels, setEndpointModels] = useState<Record<string, string[]>>({})
  /** Every model each agent offers, per account (`agentKey`) — main asks the CLIs themselves */
  const [agentModels, setAgentModels] = useState<Record<string, AgentModel[]>>({})


  // models, levels and endpoints differ per agent — reset stale choices on switch
  useEffect(() => {
    setModel('')
    setEffort('')
    setEndpointId('')
  }, [provider])

  const usableEndpoints = cli ? endpoints.filter((e) => endpointSupports(cli, e)) : []
  const endpoint = usableEndpoints.find((e) => e.id === endpointId)

  // ask the provider itself which models it serves; the cached list covers the meantime
  useEffect(() => {
    if (!endpoint || endpointModels[endpoint.id]) return
    const id = endpoint.id
    void api
      .listEndpointModels?.(id)
      .then((m) => m.length > 0 && setEndpointModels((prev) => ({ ...prev, [id]: m })))
      .catch(() => {}) // unreachable provider → its cached list, or free text, still works
  }, [endpoint?.id])

  // one listing per agent and account, fetched once
  const agentKey = `${provider}|${account?.configDir ?? ''}|${account?.copilotUser ?? ''}`
  useEffect(() => {
    if (agentModels[agentKey] || !cli) return
    const key = agentKey
    void Promise.resolve(api.listAgentModels?.(cli, accountRef(account)) ?? [])
      .then((m) => setAgentModels((prev) => ({ ...prev, [key]: m })))
      .catch(() => setAgentModels((prev) => ({ ...prev, [key]: [] })))
  }, [agentKey])

  const catalog: readonly AgentModel[] | null = !cli
    ? []
    : endpoint
      ? (endpointModels[endpoint.id] ?? endpoint.models ?? []).map((id) => ({ id, label: id }))
      : (agentModels[agentKey] ?? null)
  // a choice the current list doesn't offer (another account, another provider, a
  // catalog that arrived without it) is dropped, never run behind a picker showing default
  const chosen =
    catalog === null ? '' : catalog.length === 0 ? model : catalog.some((m) => m.id === model) ? model : ''
  const info = catalog?.find((m) => m.id === chosen)
  const efforts = cli ? effortsFor(cli, info) : []
  const chosenEffort = effort && efforts.includes(effort) ? effort : ''
  const modelMissing = provider === 'copilot' && !!endpoint && !chosen.trim()

  return {
    model: chosen,
    setModel,
    effort: chosenEffort,
    setEffort,
    efforts,
    defaultEffort: info?.defaultEffort,
    codexSandbox,
    setCodexSandbox,
    endpointId,
    setEndpointId,
    endpoints,
    usableEndpoints,
    endpoint,
    catalog,
    modelMissing,
    options: cli
      ? {
          model: chosen.trim() || undefined,
          effort: chosenEffort || undefined,
          codexSandbox: provider === 'codex' && codexSandbox ? codexSandbox : undefined,
          modelEndpoint: endpoint?.id
        }
      : {}
  }
}

/**
 * The agent picker: a `.ns-provider` card per agent the form offers (`choice.agents`) —
 * logo, name, blurb and the account it would run as, named by the same rule a start
 * resolves it with (`accountFor`). An agent driven over ACP runs as whoever it is signed
 * in as, which Cockpit never learns, so its card says how it runs instead.
 */
export function AgentCards({ choice, label }: { choice: AgentChoice; label: string }): JSX.Element {
  return (
    <div className="ns-providers" role="group" aria-label={label}>
      {choice.agents.map((p) => {
        const acct = choice.accountFor(p)
        return (
          <button
            key={p}
            aria-pressed={choice.provider === p}
            className={`ns-provider ns-${p} ${choice.provider === p ? 'active' : ''}`}
            onClick={() => choice.setProvider(p)}
          >
            <ProviderLogo p={p} size={20} />
            <span className="ns-provider-name">{PROVIDER_LABEL[p]}</span>
            <span className="ns-provider-blurb">{agentBlurb(p)}</span>
            {isDrivable(p) ? (
              // while accounts are still loading, absence is unknown — not "signed out"
              <span
                className={`acct-chip${acct || choice.accounts === null ? '' : ' missing'}`}
                title={acct?.display}
              >
                {acct?.identity ?? (choice.accounts === null ? '…' : 'not signed in')}
              </span>
            ) : (
              <span className="acct-chip" title={`Cockpit drives ${PROVIDER_LABEL[p]} over its ACP server`}>
                over ACP
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/** The account `.ns-opt` cell: a mono Select when several accounts exist, static text otherwise. */
export function AccountField({
  opts,
  account,
  loading,
  onChange
}: {
  opts: readonly AccountOption[]
  account: AccountOption | undefined
  /** while accounts are still loading, absence is unknown — not "signed out" */
  loading: boolean
  onChange: (key: string) => void
}): JSX.Element {
  return (
    <div className="ns-opt">
      {opts.length > 1 ? (
        <>
          {/* the Select trigger is a button — labelable, so label-for works */}
          <label className="ns-label" htmlFor="ns-account">Account</label>
          <Select
            id="ns-account"
            ariaLabel="Account"
            mono
            value={account?.key ?? ''}
            options={opts.map((o) => ({ value: o.key, label: o.display }))}
            onChange={onChange}
          />
        </>
      ) : (
        // A read-only value, so there is no control for label-for to point at — and
        // a div can't carry the name either: a generic role drops an
        // aria-labelledby, which reads as labelled in the source and is absent in
        // the tree. `output` is the element for a value the other controls decide,
        // and it is nameable, so the label sticks.
        <>
          <span className="ns-label" id="ns-account-label">Account</span>
          <output
            className="ns-account-single"
            aria-labelledby="ns-account-label"
            title={account?.display}
          >
            {account?.display ?? (loading ? '…' : 'not signed in')}
          </output>
        </>
      )}
    </div>
  )
}

/** The agent-option `.ns-opt` cells (model provider / model / thinking / codex sandbox). */
export function AgentOptionsFields({
  provider,
  o
}: {
  provider: SessionProvider
  o: AgentOptionsState
}): JSX.Element | null {
  // an agent driven over ACP picks its own model and thinking
  if (!isDrivable(provider)) return null
  return (
    <>
      {o.usableEndpoints.length > 0 && (
        <div className="ns-opt">
          <label className="ns-label" htmlFor="ns-endpoint">Model provider</label>
          <Select
            id="ns-endpoint"
            ariaLabel="Model provider"
            value={o.endpointId}
            options={[
              { value: '', label: 'default' },
              ...o.usableEndpoints.map((e) => ({ value: e.id, label: e.label, title: e.baseUrl }))
            ]}
            onChange={o.setEndpointId}
          />
        </div>
      )}
      <div className="ns-opt">
        <label className="ns-label" htmlFor="ns-model">Model</label>
        {o.catalog?.length === 0 ? (
          // nothing lists what this backend serves — the one place a model is typed
          <input
            id="ns-model"
            placeholder={o.modelMissing ? 'required' : 'default'}
            value={o.model}
            onChange={(e) => o.setModel(e.target.value)}
          />
        ) : (
          <Select
            id="ns-model"
            ariaLabel="Model"
            mono
            value={o.model}
            options={[
              {
                value: '',
                label: o.catalog === null ? 'loading models…' : o.modelMissing ? 'choose a model…' : 'default'
              },
              ...(o.catalog ?? []).map((m) => ({
                value: m.id,
                label: m.label,
                hint: m.label === m.id ? m.description : m.id,
                title: m.description
              }))
            ]}
            onChange={o.setModel}
          />
        )}
      </div>
      <div className="ns-opt">
        <label className="ns-label" htmlFor="ns-effort">Thinking</label>
        <Select
          id="ns-effort"
          ariaLabel="Thinking"
          value={o.effort}
          options={[
            { value: '', label: o.defaultEffort ? `default · ${o.defaultEffort}` : 'default' },
            ...o.efforts.map((e) => ({ value: e, label: e }))
          ]}
          onChange={o.setEffort}
        />
      </div>
      {provider === 'codex' && (
        <div className="ns-opt">
          <label className="ns-label" htmlFor="ns-sandbox">Sandbox</label>
          <Select
            id="ns-sandbox"
            ariaLabel="Sandbox"
            mono
            value={o.codexSandbox}
            options={[
              { value: '', label: 'default' },
              { value: 'read-only', label: 'read-only' },
              { value: 'workspace-write', label: 'workspace-write' },
              { value: 'danger-full-access', label: 'danger-full-access' }
            ]}
            onChange={(v) => o.setCodexSandbox(v as CodexSandbox | '')}
          />
        </div>
      )}
    </>
  )
}

/** The Permissions `.ns-opt` cell, over the shared `MODES` table. */
export function ModeField({
  mode,
  provider,
  onChange
}: {
  mode: PermissionMode
  provider: SessionProvider
  onChange: (m: PermissionMode) => void
}): JSX.Element {
  return (
    <div className="ns-opt">
      <label className="ns-label" htmlFor="ns-mode">Permissions</label>
      <Select
        id="ns-mode"
        ariaLabel="Permissions"
        value={mode}
        options={modeOptions(provider)}
        onChange={(v) => onChange(v as PermissionMode)}
      />
    </div>
  )
}

/** What the chosen mode lets this agent do, under the option grid — in danger color for Full access. */
export function ModeHint({ mode, provider }: { mode: PermissionMode; provider: SessionProvider }): JSX.Element {
  return <div className={mode === 'yolo' ? 'ns-hint danger' : 'ns-hint'}>{modeHint(mode, provider)}</div>
}

/** Endpoint hints shown under the option grid — why a provider is (un)available. */
export function AgentOptionsHints({
  provider,
  o
}: {
  provider: SessionProvider
  o: AgentOptionsState
}): JSX.Element | null {
  if (!isDrivable(provider)) {
    return (
      <div className="ns-hint">
        {PROVIDER_LABEL[provider]} runs over its ACP server, signed in as whoever it is — its model
        and account are its own settings.
      </div>
    )
  }
  return (
    <>
      {o.endpoint && (
        <div className="ns-hint">
          Runs on {o.endpoint.baseUrl}
          {o.catalog?.length === 0 &&
            (provider === 'copilot'
              ? ' — a model this provider serves is required.'
              : ' — set a model this provider serves.')}
        </div>
      )}
      {o.endpoints.length > 0 && o.usableEndpoints.length === 0 && (
        <div className="ns-hint">
          {provider === 'codex'
            ? 'Custom model providers can’t run Codex — it has no launch-time provider override.'
            : 'Claude can only use anthropic-type custom providers — none is configured.'}
        </div>
      )}
    </>
  )
}
