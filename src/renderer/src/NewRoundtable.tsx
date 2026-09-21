import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type {
  AccountsSnapshot,
  AgentModel,
  ModelEndpoint,
  Provider,
  RepoGroup,
  RoundtableLimits,
  RoundtableMode,
  SignInState
} from '../../shared/types'
import { endpointSupports } from '../../shared/endpoints'
import { effortsFor } from '../../shared/agent-models'
import { signInHint } from '../../shared/agent-auth'
import {
  DEFAULT_ROUNDTABLE_LIMITS,
  duplicateSeats,
  ROUNDTABLE_MAX_SEATS,
  roundsAllowed,
  sanitizeRoundtableLimits
} from '../../shared/roundtable'
import { api } from './api'
import { accountOptions, AGENT_BLURB, savedAccount, type AccountOption } from './NewSession'
import { ProviderLogo, PROVIDER_LABEL } from './logos'
import { Select } from './Select'
import { SignInFix, useWatchUntil } from './SignInFix'

const PROVIDERS: Provider[] = ['claude', 'codex', 'copilot']
/** Round caps the form offers — the per-message ceiling may allow fewer, never more */
const ROUND_CHOICES = [1, 2, 3, 4, 5]
/** Ceiling presets — within ROUNDTABLE_LIMIT_RANGE, which main enforces */
export const MESSAGE_LIMITS = [4, 8, 12, 16, 24, 32, 64]
export const TABLE_LIMITS = [20, 40, 80, 160, 320, 0]
const LIMITS_KEY = 'cockpit:rt-limits'
const SEATS_KEY = 'cockpit:rt-seats'
const DEFAULT_SEATS: SeatDraft[] = [{ provider: 'claude' }, { provider: 'codex' }]

/** One seat being configured — every field is the seat's own, the agent included. */
type SeatDraft = {
  readonly provider: Provider
  readonly account?: string
  /** Custom model provider (ModelEndpoint.id); absent = the agent's own backend */
  readonly endpointId?: string
  /** Always one the picker offered — models are chosen, never typed */
  readonly model?: string
  /** Thinking level; absent = the model's default */
  readonly effort?: string
  /** Codex: the fast (priority) tier */
  readonly fast?: boolean
  /** Copilot: the long-context window */
  readonly longContext?: boolean
}

/** A ceiling's options: its presets plus whatever value is current, shown as itself. */
export function limitOptions(
  presets: readonly number[],
  current: number
): Array<{ value: string; label: string }> {
  // 0 means "no ceiling", so it sorts as the largest
  const rank = (n: number): number => (n === 0 ? Infinity : n)
  const values = presets.includes(current)
    ? presets
    : [...presets, current].sort((a, b) => rank(a) - rank(b))
  return values.map((n) => ({ value: String(n), label: n === 0 ? 'no ceiling' : `${n} turns` }))
}

/** The ceilings last chosen here — the next table starts from them. */
function savedLimits(): RoundtableLimits {
  try {
    const raw = window.localStorage.getItem(LIMITS_KEY)
    return sanitizeRoundtableLimits(raw ? JSON.parse(raw) : null)
  } catch {
    return DEFAULT_ROUNDTABLE_LIMITS
  }
}

/**
 * The seating last opened here, so the next table is one topic away. Stored drafts are
 * only a starting point: anything the lists no longer offer (a removed account, a model
 * gone from a catalog) resolves to its default when the form renders.
 */
function savedSeats(): SeatDraft[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(SEATS_KEY) ?? 'null')
    if (!Array.isArray(raw)) return DEFAULT_SEATS
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
    const seats = raw
      .filter((s) => s && PROVIDERS.includes(s.provider))
      .slice(0, ROUNDTABLE_MAX_SEATS)
      .map(
        (s): SeatDraft => ({
          provider: s.provider,
          account: str(s.account),
          endpointId: str(s.endpointId),
          model: str(s.model),
          effort: str(s.effort),
          fast: s.fast === true || undefined,
          longContext: s.longContext === true || undefined
        })
      )
    return seats.length >= 2 ? seats : DEFAULT_SEATS
  } catch {
    return DEFAULT_SEATS
  }
}

/**
 * Roundtable creation, topic first: what to discuss, then who discusses it — each seat
 * its own agent, model, thinking level, account, model provider and the knobs only its
 * CLI has (an exact repeat is allowed once confirmed) — then the goal, the project and
 * what the table may spend. The last seating comes back, so a repeat table is a topic
 * and ⌘↵. Discussion-only by design — there is no permission mode: seats read, never write.
 */
export function NewRoundtable({
  repos,
  onCreated,
  onCancel
}: {
  repos: RepoGroup[]
  onCreated: (id: string) => void
  onCancel: () => void
}): JSX.Element {
  const [seats, setSeats] = useState<SeatDraft[]>(savedSeats)
  const [repoKey, setRepoKey] = useState('')
  const [topic, setTopic] = useState('')
  const [tableMode, setTableMode] = useState<RoundtableMode>(
    () => (window.localStorage.getItem('cockpit:rt-table-mode') as RoundtableMode) ?? 'open'
  )
  const [maxRounds, setMaxRounds] = useState(3)
  const [limits, setLimits] = useState<RoundtableLimits>(savedLimits)
  const [dupConfirmed, setDupConfirmed] = useState(false)
  const [accounts, setAccounts] = useState<AccountsSnapshot | null>(null)
  const [endpoints, setEndpoints] = useState<ModelEndpoint[]>([])
  /** Live model listings per provider id — cached `endpoint.models` until the fetch lands */
  const [endpointModels, setEndpointModels] = useState<Record<string, string[]>>({})
  /** Every model each agent offers, per config home (`agentKey`) — main reads the CLIs' own lists */
  const [agentModels, setAgentModels] = useState<Record<string, AgentModel[]>>({})
  /** Whether each agent is signed in, per config home (`agentKey`) — asked of the CLI */
  const [signIns, setSignIns] = useState<Record<string, SignInState | 'checking'>>({})
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
  }, [])

  // ask each chosen provider what it serves, once; the cached list covers the meantime
  const chosenEndpoints = [...new Set(seats.map((s) => s.endpointId ?? ''))].filter(Boolean)
  useEffect(() => {
    for (const id of chosenEndpoints) {
      if (endpointModels[id]) continue
      void api
        .listEndpointModels?.(id)
        .then((m) => m.length > 0 && setEndpointModels((prev) => ({ ...prev, [id]: m })))
        .catch(() => {}) // unreachable provider → its cached list still shows
    }
  }, [chosenEndpoints.join('\n')])

  const seatAccount = (seat: SeatDraft): AccountOption | undefined =>
    accountOptions(accounts, seat.provider).find((o) => o.key === seat.account) ??
    savedAccount(accounts, seat.provider)
  const agentKey = (seat: SeatDraft): string =>
    `${seat.provider}|${seatAccount(seat)?.configDir ?? ''}`
  // one listing per agent and account home the table uses, fetched once
  const agentKeys = [...new Set(seats.map(agentKey))]
  useEffect(() => {
    for (const key of agentKeys) {
      if (agentModels[key]) continue
      const [provider, configDir] = key.split('|') as [Provider, string]
      void api
        .listAgentModels?.(provider, configDir || undefined)
        .then((m) => setAgentModels((prev) => ({ ...prev, [key]: m })))
        .catch(() => setAgentModels((prev) => ({ ...prev, [key]: [] })))
    }
  }, [agentKeys.join('\n')])

  /** Ask the CLI whether it is signed in under this agent and home; Recheck asks again. */
  const checkSignIn = (key: string): void => {
    const [provider, configDir] = key.split('|') as [Provider, string]
    setSignIns((prev) => ({ ...prev, [key]: 'checking' }))
    void api
      .signInState?.(provider, configDir || undefined)
      .then((state) => setSignIns((prev) => ({ ...prev, [key]: state })))
      .catch(() => setSignIns((prev) => ({ ...prev, [key]: 'unknown' })))
  }
  // every seat's agent and home, plus each agent's default — so the add pills can say
  // a CLI is signed out before a seat is ever added. Waits for the accounts, since a
  // seat's home comes from them.
  const signInKeys = accounts
    ? [...new Set([...agentKeys, ...PROVIDERS.map((p) => agentKey({ provider: p }))])]
    : []
  useEffect(() => {
    for (const key of signInKeys) if (!(key in signIns)) checkSignIn(key)
  }, [signInKeys.join('\n')])
  /** Homes whose sign-in was opened in Terminal and hasn't landed yet */
  const [signingIn, setSigningIn] = useState<readonly string[]>([])
  const openSignIn = async (seat: SeatDraft): Promise<void> => {
    const key = agentKey(seat)
    setError(null)
    try {
      await api.openSignIn(seat.provider, seatAccount(seat)?.configDir)
      setSigningIn((k) => (k.includes(key) ? k : [...k, key]))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }
  // watch the homes being signed in until each reads signed in — then stop asking
  useWatchUntil(signingIn.length > 0, () => {
    for (const key of signingIn) if (signIns[key] !== 'checking') checkSignIn(key)
  })
  useEffect(() => {
    const done = signingIn.filter((key) => signIns[key] === 'signed-in')
    if (done.length > 0) setSigningIn((k) => k.filter((key) => !done.includes(key)))
  }, [signIns])
  const signedOut = (seat: SeatDraft): boolean => signIns[agentKey(seat)] === 'signed-out'
  const missing = (seat: SeatDraft): boolean => signIns[agentKey(seat)] === 'missing'
  /** A seat that can't run as it stands — never opened with (main re-checks at open) */
  const broken = (seat: SeatDraft): boolean => signedOut(seat) || missing(seat)
  const checking = seats.some((seat) => signIns[agentKey(seat)] === 'checking')

  const seatEndpoint = (seat: SeatDraft): ModelEndpoint | undefined =>
    endpoints.find((e) => e.id === seat.endpointId && endpointSupports(seat.provider, e))
  /** Everything the model picker lists: the custom provider's catalog, else every model
   *  the agent offers under the seat's account; null while that listing is loading. */
  const seatCatalog = (seat: SeatDraft): AgentModel[] | null => {
    const ep = seatEndpoint(seat)
    if (ep) return (endpointModels[ep.id] ?? ep.models ?? []).map((id) => ({ id, label: id }))
    return agentModels[agentKey(seat)] ?? null
  }
  /** The model this seat would run — only ever one its current list offers. */
  const seatModel = (seat: SeatDraft): string => {
    const model = seat.model ?? ''
    return seatCatalog(seat)?.some((m) => m.id === model) ? model : ''
  }
  const seatModelInfo = (seat: SeatDraft): AgentModel | undefined =>
    seatCatalog(seat)?.find((m) => m.id === seatModel(seat))
  /** Thinking levels on offer: the chosen model's own, else the agent's. */
  const seatEfforts = (seat: SeatDraft): readonly string[] =>
    effortsFor(seat.provider, seatModelInfo(seat))
  /** The level this seat would run — one its model takes, or the default. */
  const seatEffort = (seat: SeatDraft): string =>
    seat.effort && seatEfforts(seat).includes(seat.effort) ? seat.effort : ''
  /** Codex's fast tier, where the chosen model (or, on the default, any model) has it. */
  const fastOffered = (seat: SeatDraft): boolean => {
    if (seat.provider !== 'codex' || seatEndpoint(seat)) return false
    const info = seatModelInfo(seat)
    return info ? info.fast === true : (seatCatalog(seat) ?? []).some((m) => m.fast)
  }
  /** Copilot never learns a custom provider's catalog on its own — it needs a model. */
  const modelMissing = (seat: SeatDraft): boolean =>
    seat.provider === 'copilot' && !!seatEndpoint(seat) && !seatModel(seat)

  const addSeat = (p: Provider): void =>
    setSeats((s) => (s.length >= ROUNDTABLE_MAX_SEATS ? s : [...s, { provider: p }]))
  /** A second seat set up exactly like this one, right after it — a deliberate twin. */
  const copySeat = (index: number): void =>
    setSeats((s) =>
      s.length >= ROUNDTABLE_MAX_SEATS ? s : [...s.slice(0, index + 1), s[index], ...s.slice(index + 1)]
    )
  const removeSeat = (index: number): void => setSeats((s) => s.filter((_, i) => i !== index))
  const patchSeat = (index: number, patch: Partial<SeatDraft>): void =>
    setSeats((s) => s.map((seat, i) => (i === index ? { ...seat, ...patch } : seat)))
  /** A different agent keeps nothing: accounts, providers, models and levels are all per agent. */
  const switchAgent = (index: number, p: Provider): void =>
    setSeats((s) => s.map((seat, i) => (i === index ? { provider: p } : seat)))

  /** "Claude", or "Claude #2" when the agent sits more than once — mirrors the view's naming. */
  const seatLabel = (index: number): string => {
    const seat = seats[index]
    const twins = seats.filter((s) => s.provider === seat.provider)
    if (twins.length <= 1) return PROVIDER_LABEL[seat.provider]
    const ordinal = seats.slice(0, index + 1).filter((s) => s.provider === seat.provider).length
    return `${PROVIDER_LABEL[seat.provider]} #${ordinal}`
  }

  /** What the seat will actually run, as sent — defaults resolved, stale choices dropped. */
  const resolved = (seat: SeatDraft) => {
    const acct = seatAccount(seat)
    return {
      provider: seat.provider,
      configDir: acct?.configDir,
      copilotUser: acct?.copilotUser,
      accountLabel: acct?.display,
      model: seatModel(seat) || undefined,
      modelEndpoint: seatEndpoint(seat)?.id,
      effort: seatEffort(seat) || undefined,
      fast: (fastOffered(seat) && seat.fast) || undefined,
      longContext: (seat.provider === 'copilot' && seat.longContext) || undefined
    }
  }

  // a seat that repeats an earlier one exactly — allowed, once confirmed as deliberate
  const duplicates = duplicateSeats(
    seats.map((seat) => {
      const r = resolved(seat)
      return [r.provider, seatAccount(seat)?.key ?? '', r.modelEndpoint, r.model, r.effort, r.fast, r.longContext].join('|')
    })
  )
  const dupCount = duplicates.filter(Boolean).length
  // what one message may cost: a wave is a turn per seat, and a consensus table keeps
  // spending rounds on its own, so its cap is held to the per-message ceiling
  const roundChoices = ROUND_CHOICES.filter((n) => n <= roundsAllowed(limits, seats.length))
  const rounds = Math.min(maxRounds, roundChoices[roundChoices.length - 1] ?? 1)
  const turnsPerMessage = seats.length * (tableMode === 'consensus' ? rounds : 1)
  const messagesAffordable =
    limits.maxTurnsPerTable === 0
      ? null
      : Math.floor(limits.maxTurnsPerTable / Math.max(1, turnsPerMessage))
  const brokenSeats = seats.map((seat, i) => (broken(seat) ? i : -1)).filter((i) => i >= 0)
  const blocked =
    seats.length < 2 ||
    seats.some(modelMissing) ||
    (dupCount > 0 && !dupConfirmed) ||
    brokenSeats.length > 0 ||
    checking

  const start = async (): Promise<void> => {
    if (busy || !topic.trim() || blocked) return
    setError(null)
    setBusy(true)
    try {
      window.localStorage.setItem('cockpit:rt-table-mode', tableMode)
      window.localStorage.setItem(LIMITS_KEY, JSON.stringify(limits))
      window.localStorage.setItem(SEATS_KEY, JSON.stringify(seats))
    } catch {
      /* storage refused — the table still opens, it just isn't remembered */
    }
    try {
      const rt = await api.createRoundtable({
        topic: topic.trim(),
        repoRoot: selected?.root ?? null,
        mode: tableMode,
        maxRounds: tableMode === 'consensus' ? rounds : undefined,
        limits,
        seats: seats.map(resolved)
      })
      onCreated(rt.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  /** The seat's name without the agent — its ordinal, when the agent sits twice. */
  const ordinal = (index: number): string => seatLabel(index).slice(PROVIDER_LABEL[seats[index].provider].length).trim()
  const seatWord = seats.length === 1 ? 'seat' : 'seats'

  return (
    <main className="chat new-session-view">
      <div className="ns-card">
        <div className="ns-head">
          <h2>New roundtable</h2>
          <span className="ns-repo">several minds, one discussion</span>
        </div>

        {/* the topic first, like New session's task: it is why the form is open — who
            discusses it and how are its settings, and they come back from last time */}
        <label className="ns-label" htmlFor="rt-topic">Topic</label>
        <textarea
          id="rt-topic"
          ref={topicRef}
          rows={3}
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

        {/* the seats are the hero: their header carries the add pills, so adding one is
            where you are already looking — no second agent picker above them */}
        <div className="rt-seats-head">
          <span className="ns-label" id="rt-seats-label">
            Seats · {seats.length}
          </span>
          <div className="rt-add-seats" role="group" aria-label="Add seats">
            {PROVIDERS.map((p) => {
              // said on the pill, before a seat exists: this CLI can't answer as it stands
              const state = signIns[agentKey({ provider: p })]
              const out = state === 'signed-out' || state === 'missing'
              return (
                <button
                  key={p}
                  className={`fb-add${out ? ' signed-out' : ''}`}
                  aria-label={`Add ${PROVIDER_LABEL[p]} seat${out ? ` (${state === 'missing' ? 'not installed' : 'signed out'})` : ''}`}
                  title={
                    state === 'missing'
                      ? `${PROVIDER_LABEL[p]} isn't installed on this Mac`
                      : out
                        ? `${PROVIDER_LABEL[p]} isn't signed in — ${signInHint(p)}`
                        : `${AGENT_BLURB[p]} — add a seat`
                  }
                  disabled={seats.length >= ROUNDTABLE_MAX_SEATS}
                  onClick={() => addSeat(p)}
                >
                  <span aria-hidden="true">+</span>
                  <span className={`plogo plogo-${p}`} aria-hidden="true">
                    <ProviderLogo p={p} size={12} />
                  </span>
                  {PROVIDER_LABEL[p]}
                  {out && (
                    <span className="rt-add-out" aria-hidden="true">
                      {state === 'missing' ? 'not installed' : 'signed out'}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>
        <div className="rt-seat-config" role="group" aria-labelledby="rt-seats-label">
          {seats.map((seat, i) => {
            const opts = accountOptions(accounts, seat.provider)
            const acct = seatAccount(seat)
            const usable = endpoints.filter((e) => endpointSupports(seat.provider, e))
            const ep = seatEndpoint(seat)
            const catalog = seatCatalog(seat)
            const info = seatModelInfo(seat)
            const name = seatLabel(i)
            const id = `rt-seat-${i}`
            const defaultEffort = info?.defaultEffort
            return (
              <div
                key={i}
                className={`rt-seat-card tint-${seat.provider}${duplicates[i] || broken(seat) ? ' duplicate' : ''}`}
                role="group"
                aria-label={`${name} seat`}
              >
                <div className="rt-seat-card-head">
                  <span className={`plogo plogo-${seat.provider}`} aria-hidden="true">
                    <ProviderLogo p={seat.provider} size={13} />
                  </span>
                  {/* the seat's agent is its title, and changeable in place */}
                  <Select
                    className="rt-seat-agent"
                    quiet
                    ariaLabel={`${name} agent`}
                    value={seat.provider}
                    options={PROVIDERS.map((p) => ({ value: p, label: PROVIDER_LABEL[p] }))}
                    onChange={(v) => switchAgent(i, v as Provider)}
                  />
                  {ordinal(i) && <span className="rt-seat-ordinal">{ordinal(i)}</span>}
                  {signedOut(seat) && <span className="acct-chip missing">signed out</span>}
                  {missing(seat) && <span className="acct-chip missing">not installed</span>}
                  {duplicates[i] && (
                    // the warn chip: allowed, and worth a second look
                    <span className="acct-chip missing" title="Set up exactly like an earlier seat">
                      duplicate
                    </span>
                  )}
                  <span className="rt-seat-card-actions">
                    {/* the one switch only this agent's CLI has — a checkbox, since it is on or off */}
                    {fastOffered(seat) && (
                      <label className="rt-seat-flag" title="Priority tier: about twice the speed, and twice the usage">
                        <input
                          type="checkbox"
                          checked={seat.fast === true}
                          onChange={(e) => patchSeat(i, { fast: e.currentTarget.checked || undefined })}
                        />
                        <span>fast</span>
                        <span className="rt-seat-flag-note">~2× usage</span>
                      </label>
                    )}
                    {seat.provider === 'copilot' && (
                      <label className="rt-seat-flag" title="The long-context window tier">
                        <input
                          type="checkbox"
                          checked={seat.longContext === true}
                          onChange={(e) =>
                            patchSeat(i, { longContext: e.currentTarget.checked || undefined })
                          }
                        />
                        <span>long context</span>
                      </label>
                    )}
                    <button
                      className="btn-ghost small"
                      aria-label={`Copy ${name} seat`}
                      title="Add another seat set up exactly like this one"
                      disabled={seats.length >= ROUNDTABLE_MAX_SEATS}
                      onClick={() => copySeat(i)}
                    >
                      Copy
                    </button>
                    <button
                      className="icon-btn small"
                      aria-label={`Remove ${name} seat`}
                      title="Remove seat"
                      onClick={() => removeSeat(i)}
                    >
                      ✕
                    </button>
                  </span>
                </div>
                {/* how it thinks, then where it runs — one row on a desktop card */}
                <div className="rt-seat-grid">
                  <div className="ns-opt">
                    <label className="ns-label" htmlFor={`${id}-model`}>Model</label>
                    <Select
                      id={`${id}-model`}
                      ariaLabel={`${name} model`}
                      mono
                      value={seatModel(seat)}
                      options={[
                        {
                          value: '',
                          label:
                            catalog === null
                              ? 'loading models…'
                              : modelMissing(seat)
                                ? 'choose a model…'
                                : 'default model'
                        },
                        ...(catalog ?? []).map((m) => ({
                          value: m.id,
                          label: m.label,
                          hint: m.label === m.id ? m.description : m.id,
                          title: m.description
                        }))
                      ]}
                      onChange={(v) => patchSeat(i, { model: v })}
                    />
                  </div>
                  <div className="ns-opt">
                    <label className="ns-label" htmlFor={`${id}-effort`}>Thinking</label>
                    <Select
                      id={`${id}-effort`}
                      ariaLabel={`${name} thinking`}
                      value={seatEffort(seat)}
                      options={[
                        { value: '', label: defaultEffort ? `default · ${defaultEffort}` : 'default' },
                        ...seatEfforts(seat).map((e) => ({ value: e, label: e }))
                      ]}
                      onChange={(v) => patchSeat(i, { effort: v || undefined })}
                    />
                  </div>
                  <div className="ns-opt">
                    {opts.length > 1 ? (
                      <>
                        <label className="ns-label" htmlFor={`${id}-account`}>Account</label>
                        <Select
                          id={`${id}-account`}
                          ariaLabel={`${name} account`}
                          mono
                          value={acct?.key ?? ''}
                          options={opts.map((o) => ({ value: o.key, label: o.display }))}
                          onChange={(v) => patchSeat(i, { account: v })}
                        />
                      </>
                    ) : (
                      <>
                        <span className="ns-label" id={`${id}-account-label`}>Account</span>
                        <output
                          className="rt-seat-cfg-acct ns-account-single"
                          aria-labelledby={`${id}-account-label`}
                          title={acct?.display}
                        >
                          {acct?.identity ?? (accounts === null ? '…' : 'not signed in')}
                        </output>
                      </>
                    )}
                  </div>
                  <div className="ns-opt">
                    {usable.length > 0 ? (
                      <>
                        <label className="ns-label" htmlFor={`${id}-endpoint`}>Model provider</label>
                        <Select
                          id={`${id}-endpoint`}
                          ariaLabel={`${name} model provider`}
                          value={ep?.id ?? ''}
                          options={[
                            { value: '', label: `${PROVIDER_LABEL[seat.provider]} (own)` },
                            ...usable.map((e) => ({ value: e.id, label: e.label, title: e.baseUrl }))
                          ]}
                          onChange={(v) => patchSeat(i, { endpointId: v || undefined, model: '' })}
                        />
                      </>
                    ) : (
                      // the column is always there, so the choice is visible even before
                      // there is anything else to choose
                      <>
                        <span className="ns-label" id={`${id}-endpoint-label`}>Model provider</span>
                        <output
                          className="rt-seat-cfg-acct ns-account-single"
                          aria-labelledby={`${id}-endpoint-label`}
                          title={
                            seat.provider === 'codex'
                              ? 'Custom model providers can’t run Codex — it has no launch-time provider override.'
                              : endpoints.length === 0
                                ? 'Add a custom model provider in Settings › Providers to run this seat on it.'
                                : 'Claude can only use anthropic-type custom providers — none is configured.'
                          }
                        >
                          {PROVIDER_LABEL[seat.provider]} (own)
                        </output>
                      </>
                    )}
                  </div>
                </div>
                {missing(seat) && (
                  <div className="rt-seat-signin" role="alert">
                    Cockpit can’t find the <code className="signin-cmd">{seat.provider}</code> command
                    on this Mac, so this seat can’t run. Install {PROVIDER_LABEL[seat.provider]}’s CLI,
                    then{' '}
                    <button className="link-btn" onClick={() => checkSignIn(agentKey(seat))}>
                      Recheck
                    </button>
                  </div>
                )}
                {signedOut(seat) && (
                  <div className="rt-seat-signin" role="alert">
                    {PROVIDER_LABEL[seat.provider]} isn’t signed in
                    {acct?.identity ? ` as ${acct.identity}` : ''} on this Mac, so this seat would fail
                    every turn.
                    {seat.provider === 'claude' &&
                      ' The Claude app keeps its own sign-in — it doesn’t carry over to the CLI Cockpit runs.'}{' '}
                    {signingIn.includes(agentKey(seat)) ? (
                      'Finish signing in in the Terminal window — this seat clears by itself when you’re done.'
                    ) : (
                      <SignInFix provider={seat.provider} configHome={acct?.configDir} />
                    )}
                    <span className="rt-seat-signin-actions">
                      <button className="btn-ghost small" onClick={() => void openSignIn(seat)}>
                        {signingIn.includes(agentKey(seat)) ? 'Open Terminal again' : 'Sign in…'}
                      </button>
                      <button
                        className="link-btn"
                        disabled={signIns[agentKey(seat)] === 'checking'}
                        onClick={() => checkSignIn(agentKey(seat))}
                      >
                        {signIns[agentKey(seat)] === 'checking' ? 'Checking…' : 'Recheck'}
                      </button>
                    </span>
                  </div>
                )}
              </div>
            )
          })}
        </div>
        <div className="ns-hint">
          Two to {ROUNDTABLE_MAX_SEATS} seats. The same agent can sit more than once — at a different
          depth, or as a copy for a second sample.
        </div>

        {dupCount > 0 && (
          <div className="rt-dup-confirm">
            <label>
              <input
                type="checkbox"
                checked={dupConfirmed}
                onChange={(e) => setDupConfirmed(e.currentTarget.checked)}
              />
              <span>
                Seat {dupCount === 1 ? 'the duplicate' : `${dupCount} duplicates`} on purpose
              </span>
            </label>
            <span className="ns-hint">
              A duplicate is set up exactly like an earlier seat — another sample of one mind, at
              the full cost of a seat every round. Change its model or thinking level to make it a
              different voice.
            </span>
          </div>
        )}
        {seats.some(modelMissing) && (
          <div className="ns-hint">
            A Copilot seat on a custom model provider needs a model that provider serves
            {seats.some((s) => modelMissing(s) && seatCatalog(s)?.length === 0)
              ? ' — this one lists no models, so it can’t seat Copilot.'
              : '.'}
          </div>
        )}

        <span className="ns-label" id="rt-table-label">The table</span>
        <div className="ns-options" role="group" aria-labelledby="rt-table-label">
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

        <span className="ns-label" id="rt-limits-label">Roundtable spending limits</span>
        <div className="ns-options" role="group" aria-labelledby="rt-limits-label">
          <div className="ns-opt">
            <label className="ns-label" htmlFor="rt-limit-message">Agent turns per message</label>
            <Select
              id="rt-limit-message"
              ariaLabel="Agent turns per message"
              value={String(limits.maxTurnsPerMessage)}
              options={limitOptions(MESSAGE_LIMITS, limits.maxTurnsPerMessage)}
              onChange={(v) => setLimits((l) => ({ ...l, maxTurnsPerMessage: Number(v) }))}
            />
          </div>
          <div className="ns-opt">
            <label className="ns-label" htmlFor="rt-limit-table">Agent turns for the table</label>
            <Select
              id="rt-limit-table"
              ariaLabel="Agent turns for the table"
              value={String(limits.maxTurnsPerTable)}
              options={limitOptions(TABLE_LIMITS, limits.maxTurnsPerTable)}
              onChange={(v) => setLimits((l) => ({ ...l, maxTurnsPerTable: Number(v) }))}
            />
          </div>
        </div>
        {/* the bill, before it is run up: every seat's reply is a full agent turn */}
        <div className="ns-hint">
          {tableMode === 'consensus'
            ? `Each message costs up to ${turnsPerMessage} agent turns — ${seats.length} seats × ${rounds} ${rounds === 1 ? 'round' : 'rounds'}, fewer if they agree sooner.`
            : `Each message, and each extra round, costs ${turnsPerMessage} agent turns — one per seat.`}{' '}
          {messagesAffordable === null
            ? 'No ceiling for the whole table.'
            : `The table stops at ${limits.maxTurnsPerTable} turns — about ${messagesAffordable} ${messagesAffordable === 1 ? 'message' : 'messages'} at this size — and you can raise it from the table.`}
        </div>

        {error && <div className="new-error" role="alert">{error}</div>}

        {/* pinned to the bottom of the view: however many seats, the bill and the way
            to open the table are always in sight */}
        <div className="ns-actions rt-footer">
          <span className={`rt-footer-bill${brokenSeats.length > 0 ? ' blocked' : ''}`} aria-live="polite">
            {brokenSeats.length > 0 ? (
              <>
                {brokenSeats.map((i) => seatLabel(i)).join(', ')} can’t run —{' '}
                {brokenSeats.length === 1 ? 'fix it' : 'fix them'} to open the table
              </>
            ) : checking ? (
              'Checking the seats can run…'
            ) : (
              <>
                {seats.length} {seatWord} · {tableMode === 'consensus' ? 'up to ' : ''}
                {turnsPerMessage} agent turns a message
              </>
            )}
          </span>
          {/* the keys wrap as one: a narrow card puts the bill above them, never Open alone */}
          <span className="rt-footer-keys">
            <button className="btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
            <button
              className="btn-primary"
              onClick={() => void start()}
              disabled={busy || !topic.trim() || blocked}
              title="⌘↵ from the topic"
            >
              {busy ? 'Opening…' : 'Open roundtable'}
            </button>
          </span>
        </div>
      </div>
    </main>
  )
}
