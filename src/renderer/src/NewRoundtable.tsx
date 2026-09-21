import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type {
  AccountsSnapshot,
  ModelEndpoint,
  Provider,
  RepoGroup,
  RoundtableLimits,
  RoundtableMode
} from '../../shared/types'
import { endpointSupports } from '../../shared/endpoints'
import {
  DEFAULT_ROUNDTABLE_LIMITS,
  duplicateSeats,
  roundsAllowed
} from '../../shared/roundtable'
import { api } from './api'
import {
  accountOptions,
  AGENT_BLURB,
  MODEL_SUGGESTIONS,
  savedAccount,
  type AccountOption
} from './NewSession'
import { ProviderLogo, PROVIDER_LABEL } from './logos'
import { Select } from './Select'

const PROVIDERS: Provider[] = ['claude', 'codex', 'copilot']
/** Round caps the form offers — the limits may allow fewer, never more */
const ROUND_CHOICES = [1, 2, 3, 4, 5]

/** One seat being configured: the agent is fixed, everything it runs on is the seat's own. */
type SeatDraft = {
  readonly provider: Provider
  readonly account?: string
  /** Custom model provider (ModelEndpoint.id); absent = the agent's own backend */
  readonly endpointId?: string
  readonly model?: string
}

/**
 * Roundtable creation: seat the table (a provider may sit twice with different
 * models), optionally ground it in a repo, pick the goal, open with the topic.
 * Discussion-only by design — there is no permission mode: seats read, never write.
 */
export function NewRoundtable({
  repos,
  onCreated,
  onCancel,
  onOpenLimits
}: {
  repos: RepoGroup[]
  onCreated: (id: string) => void
  onCancel: () => void
  /** Opens Settings › Limits — where the ceilings this form obeys are set */
  onOpenLimits?: () => void
}): JSX.Element {
  const [seats, setSeats] = useState<SeatDraft[]>([{ provider: 'claude' }, { provider: 'codex' }])
  const [repoKey, setRepoKey] = useState('')
  const [topic, setTopic] = useState('')
  const [tableMode, setTableMode] = useState<RoundtableMode>(
    () => (window.localStorage.getItem('cockpit:rt-table-mode') as RoundtableMode) ?? 'open'
  )
  const [maxRounds, setMaxRounds] = useState(3)
  const [accounts, setAccounts] = useState<AccountsSnapshot | null>(null)
  /** What a table may spend; the defaults until main answers (it re-checks anyway) */
  const [limits, setLimits] = useState<RoundtableLimits>(DEFAULT_ROUNDTABLE_LIMITS)
  const [endpoints, setEndpoints] = useState<ModelEndpoint[]>([])
  /** Live model listings per provider id — cached `endpoint.models` until the fetch lands */
  const [endpointModels, setEndpointModels] = useState<Record<string, string[]>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const topicRef = useRef<HTMLTextAreaElement>(null)

  const selectable = useMemo(() => repos.filter((r) => r.root), [repos])
  const selected = selectable.find((r) => r.key === repoKey) ?? null

  useEffect(() => {
    topicRef.current?.focus()
    void api.getAccounts().then(setAccounts)
    // optional call: a preload from before this method must not crash the form (dev HMR)
    void api.getModelEndpoints?.().then(setEndpoints)
    void api.getRoundtableLimits?.().then(setLimits)
  }, [])

  // ask each chosen provider what it serves, once; the cached list covers the meantime
  const chosenEndpoints = [...new Set(seats.map((s) => s.endpointId ?? ''))].filter(Boolean)
  useEffect(() => {
    for (const id of chosenEndpoints) {
      if (endpointModels[id]) continue
      void api
        .listEndpointModels?.(id)
        .then((m) => m.length > 0 && setEndpointModels((prev) => ({ ...prev, [id]: m })))
        .catch(() => {}) // unreachable provider → free-text model entry still works
    }
  }, [chosenEndpoints.join('\n')])

  const seatEndpoint = (seat: SeatDraft): ModelEndpoint | undefined =>
    endpoints.find((e) => e.id === seat.endpointId && endpointSupports(seat.provider, e))
  const seatModels = (seat: SeatDraft): string[] => {
    const ep = seatEndpoint(seat)
    return ep ? (endpointModels[ep.id] ?? ep.models ?? []) : []
  }
  /** The model this seat would run: a catalog, once known, outranks a typed name it
   *  does not serve — the picker would show "choose…" while the stale value ran. */
  const seatModel = (seat: SeatDraft): string => {
    const model = seat.model?.trim() ?? ''
    const catalog = seatModels(seat)
    return catalog.length > 0 && !catalog.includes(model) ? '' : model
  }
  /** Copilot never learns a custom provider's catalog on its own — it needs a model. */
  const modelMissing = (seat: SeatDraft): boolean =>
    seat.provider === 'copilot' && !!seatEndpoint(seat) && !seatModel(seat)

  const seatAccount = (seat: SeatDraft): AccountOption | undefined =>
    accountOptions(accounts, seat.provider).find((o) => o.key === seat.account) ??
    savedAccount(accounts, seat.provider)

  const addSeat = (p: Provider): void =>
    setSeats((s) => (s.length >= limits.maxSeats ? s : [...s, { provider: p }]))
  const removeSeat = (index: number): void => setSeats((s) => s.filter((_, i) => i !== index))
  const patchSeat = (index: number, patch: Partial<SeatDraft>): void =>
    setSeats((s) => s.map((seat, i) => (i === index ? { ...seat, ...patch } : seat)))

  /** "Claude", or "Claude #2" when the provider sits twice — mirrors the view's naming. */
  const seatLabel = (index: number): string => {
    const seat = seats[index]
    const twins = seats.filter((s) => s.provider === seat.provider)
    if (twins.length <= 1) return PROVIDER_LABEL[seat.provider]
    const ordinal = seats.slice(0, index + 1).filter((s) => s.provider === seat.provider).length
    return `${PROVIDER_LABEL[seat.provider]} #${ordinal}`
  }

  // a seat that repeats an earlier one exactly — allowed, but marked so it is a choice
  const duplicates = duplicateSeats(
    seats.map((seat) =>
      [seat.provider, seatAccount(seat)?.key ?? '', seatEndpoint(seat)?.id ?? '', seatModel(seat)].join('|')
    )
  )
  const overSeated = seats.length > limits.maxSeats
  // what one message may cost: a wave is a turn per seat, and a consensus table keeps
  // spending rounds on its own, so its cap is held to the per-message ceiling
  const roundChoices = ROUND_CHOICES.filter((n) => n <= roundsAllowed(limits, seats.length))
  const rounds = Math.min(maxRounds, roundChoices[roundChoices.length - 1] ?? 1)
  const turnsPerMessage = seats.length * (tableMode === 'consensus' ? rounds : 1)
  const blocked = seats.length < 2 || overSeated || seats.some(modelMissing)

  const start = async (): Promise<void> => {
    if (busy || !topic.trim() || blocked) return
    setError(null)
    setBusy(true)
    window.localStorage.setItem('cockpit:rt-table-mode', tableMode)
    try {
      const rt = await api.createRoundtable({
        topic: topic.trim(),
        repoRoot: selected?.root ?? null,
        mode: tableMode,
        maxRounds: tableMode === 'consensus' ? rounds : undefined,
        seats: seats.map((seat) => {
          const acct = seatAccount(seat)
          const model = seatModel(seat)
          return {
            provider: seat.provider,
            configDir: acct?.configDir,
            copilotUser: acct?.copilotUser,
            accountLabel: acct?.display,
            model: model || undefined,
            modelEndpoint: seatEndpoint(seat)?.id
          }
        })
      })
      onCreated(rt.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <main className="chat new-session-view">
      <div className="ns-card">
        <div className="ns-head">
          <h2>New roundtable</h2>
          <span className="ns-repo">several minds, one discussion</span>
        </div>

        <label className="ns-label">Seat the table</label>
        <div className="ns-providers" role="group" aria-label="Add seats">
          {PROVIDERS.map((p) => {
            const count = seats.filter((s) => s.provider === p).length
            return (
              <button
                key={p}
                aria-label={`Add ${PROVIDER_LABEL[p]} seat`}
                className={`ns-provider ns-${p} ${count > 0 ? 'active' : ''}`}
                disabled={seats.length >= limits.maxSeats}
                onClick={() => addSeat(p)}
              >
                <ProviderLogo p={p} size={20} />
                <span className="ns-provider-name">{PROVIDER_LABEL[p]}</span>
                <span className="ns-provider-blurb">{AGENT_BLURB[p]}</span>
                <span className={`acct-chip${count > 0 ? '' : ' missing'}`}>
                  {count === 0 ? 'add seat' : count === 1 ? 'seated' : `${count} seats`}
                </span>
              </button>
            )
          })}
        </div>
        <div className="ns-hint">
          Two to {limits.maxSeats} seats, each with its own account, model provider and
          model. An agent can sit more than once — same mind, different depth. Every message
          reaches all seats at once; rounds are how they answer each other.
        </div>

        {seats.length > 0 && (
          <>
            <span className="ns-label" id="rt-seats-label">Seats</span>
            <div className="rt-seat-config" role="group" aria-labelledby="rt-seats-label">
              {seats.map((seat, i) => {
                const opts = accountOptions(accounts, seat.provider)
                const acct = seatAccount(seat)
                const usable = endpoints.filter((e) => endpointSupports(seat.provider, e))
                const catalog = seatModels(seat)
                return (
                  <div key={i} className="rt-seat-cfg-row">
                    <span className={`plogo plogo-${seat.provider}`} aria-hidden="true">
                      <ProviderLogo p={seat.provider} size={13} />
                    </span>
                    {/* the mark rides under the name, so a marked row keeps its columns */}
                    <span className="rt-seat-cfg-name">
                      {seatLabel(i)}
                      {duplicates[i] && (
                        // the warn chip: allowed, and worth a second look
                        <span
                          className="acct-chip missing"
                          title="Same agent, account, model provider and model as an earlier seat"
                        >
                          duplicate
                        </span>
                      )}
                    </span>
                    {opts.length > 1 ? (
                      <Select
                        ariaLabel={`${seatLabel(i)} account`}
                        mono
                        value={acct?.key ?? ''}
                        options={opts.map((o) => ({ value: o.key, label: o.display }))}
                        onChange={(v) => patchSeat(i, { account: v })}
                      />
                    ) : (
                      <span className="rt-seat-cfg-acct ns-account-single" title={acct?.display}>
                        {acct?.identity ?? (accounts === null ? '…' : 'not signed in')}
                      </span>
                    )}
                    {/* every row keeps the same columns: an agent no custom provider
                        can run shows the one backend it has, inert */}
                    {usable.length > 0 ? (
                      <Select
                        ariaLabel={`${seatLabel(i)} model provider`}
                        value={seatEndpoint(seat)?.id ?? ''}
                        options={[
                          { value: '', label: 'default provider' },
                          ...usable.map((e) => ({ value: e.id, label: e.label, title: e.baseUrl }))
                        ]}
                        onChange={(v) => patchSeat(i, { endpointId: v || undefined, model: '' })}
                      />
                    ) : (
                      endpoints.length > 0 && (
                        <span
                          className="rt-seat-cfg-acct ns-account-single"
                          title={
                            seat.provider === 'codex'
                              ? 'Custom model providers can’t run Codex — it has no launch-time provider override.'
                              : 'Claude can only use anthropic-type custom providers — none is configured.'
                          }
                        >
                          default provider
                        </span>
                      )
                    )}
                    {catalog.length > 0 ? (
                      // the provider told us what it serves — pick from its own catalog
                      <Select
                        ariaLabel={`${seatLabel(i)} model`}
                        mono
                        value={seatModel(seat)}
                        options={[
                          {
                            value: '',
                            label: seat.provider === 'copilot' ? 'choose a model…' : 'default model'
                          },
                          ...catalog.map((m) => ({ value: m, label: m }))
                        ]}
                        onChange={(v) => patchSeat(i, { model: v })}
                      />
                    ) : (
                      <input
                        aria-label={`${seatLabel(i)} model`}
                        // the suggestions name the agent's own backend's models
                        list={seatEndpoint(seat) ? undefined : `rt-models-${seat.provider}`}
                        placeholder={modelMissing(seat) ? 'model required' : 'default model'}
                        value={seat.model ?? ''}
                        onChange={(e) => patchSeat(i, { model: e.target.value })}
                      />
                    )}
                    <button
                      className="icon-btn small"
                      aria-label={`Remove ${seatLabel(i)} seat`}
                      title="Remove seat"
                      onClick={() => removeSeat(i)}
                    >
                      ✕
                    </button>
                  </div>
                )
              })}
              {PROVIDERS.map((p) => (
                <datalist key={p} id={`rt-models-${p}`}>
                  {MODEL_SUGGESTIONS[p].map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              ))}
            </div>
          </>
        )}

        {duplicates.some(Boolean) && (
          <div className="ns-hint">
            A duplicate seat runs the same agent on the same model as an earlier one — a second
            sample of one mind, at the full cost of a seat. Change its model to make it a
            different voice, or keep it if that is the point.
          </div>
        )}
        {seats.some(modelMissing) && (
          <div className="ns-hint">
            A Copilot seat on a custom model provider needs a model that provider serves.
          </div>
        )}

        <div className="ns-options">
          <div className="ns-opt">
            <label className="ns-label" htmlFor="rt-goal">Goal</label>
            <Select
              id="rt-goal"
              ariaLabel="Goal"
              value={tableMode}
              options={[
                { value: 'open', label: 'Free discussion', title: 'rounds run when you say so' },
                {
                  value: 'consensus',
                  label: 'Reach an understanding',
                  title: "auto-rounds until every seat agrees — closes with each seat's own line, side by side"
                }
              ]}
              onChange={(v) => setTableMode(v as RoundtableMode)}
            />
          </div>
          {tableMode === 'consensus' && (
            <div className="ns-opt">
              <label className="ns-label" htmlFor="rt-rounds">Round cap</label>
              <Select
                id="rt-rounds"
                ariaLabel="Round cap"
                value={String(rounds)}
                options={roundChoices.map((n) => ({
                  value: String(n),
                  label: n === 1 ? '1 round' : `${n} rounds`,
                  title: 'auto discussion rounds per message before the table must conclude'
                }))}
                onChange={(v) => setMaxRounds(Number(v))}
              />
            </div>
          )}
          <div className="ns-opt">
            <label className="ns-label" htmlFor="rt-repo">Project</label>
            <Select
              id="rt-repo"
              ariaLabel="Project"
              value={selected?.key ?? ''}
              options={[
                { value: '', label: 'no repository — pure discussion' },
                ...selectable.map((r) => ({ value: r.key, label: r.fullName ?? r.name }))
              ]}
              onChange={setRepoKey}
            />
          </div>
        </div>
        <div className="ns-hint">
          {selected
            ? 'Seats read the project from an isolated worktree — a roundtable decides, it never edits. Ship the outcome with a normal session.'
            : 'No codebase attached — the table runs in a scratch room.'}
        </div>

        {/* the bill, before it is run up: every seat's reply is a full agent turn */}
        <div className="ns-hint">
          {tableMode === 'consensus'
            ? `Each message costs up to ${turnsPerMessage} agent turns — ${seats.length} seats × ${rounds} ${rounds === 1 ? 'round' : 'rounds'}, fewer if they agree sooner.`
            : `Each message, and each extra round, costs ${turnsPerMessage} agent turns — one per seat.`}{' '}
          {overSeated
            ? `The limit is ${limits.maxSeats} seats. `
            : `Limits: ${limits.maxSeats} seats, ${limits.maxTurnsPerMessage} turns a message, ${
                limits.maxTurnsPerTable === 0 ? 'no ceiling' : `${limits.maxTurnsPerTable} turns`
              } a table. `}
          {onOpenLimits && (
            <button className="link-btn" onClick={onOpenLimits}>Change limits</button>
          )}
        </div>

        <label className="ns-label" htmlFor="rt-topic">Topic</label>
        <textarea
          id="rt-topic"
          ref={topicRef}
          rows={4}
          placeholder={
            tableMode === 'consensus'
              ? 'What should they reach an understanding on?'
              : 'What should they hash out?'
          }
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void start()
          }}
        />

        {error && <div className="new-error" role="alert">{error}</div>}

        <div className="ns-actions">
          <button className="btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button
            className="btn-primary"
            onClick={() => void start()}
            disabled={busy || !topic.trim() || blocked}
          >
            {busy ? 'Opening…' : 'Open roundtable'}
          </button>
        </div>
      </div>
    </main>
  )
}
