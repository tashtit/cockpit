import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import type {
  AccountsSnapshot,
  Provider,
  RepoGroup,
  RoundtableMode
} from '../../shared/types'
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
const MAX_SEATS = 4

/** One seat being configured: provider fixed, account/model overridable. */
type SeatDraft = {
  readonly provider: Provider
  readonly account?: string
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
  onCancel
}: {
  repos: RepoGroup[]
  onCreated: (id: string) => void
  onCancel: () => void
}): JSX.Element {
  const [seats, setSeats] = useState<SeatDraft[]>([{ provider: 'claude' }, { provider: 'codex' }])
  const [repoKey, setRepoKey] = useState('')
  const [topic, setTopic] = useState('')
  const [tableMode, setTableMode] = useState<RoundtableMode>(
    () => (window.localStorage.getItem('cockpit:rt-table-mode') as RoundtableMode) ?? 'open'
  )
  const [maxRounds, setMaxRounds] = useState(3)
  const [accounts, setAccounts] = useState<AccountsSnapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const topicRef = useRef<HTMLTextAreaElement>(null)

  const selectable = useMemo(() => repos.filter((r) => r.root), [repos])
  const selected = selectable.find((r) => r.key === repoKey) ?? null

  useEffect(() => {
    topicRef.current?.focus()
    void api.getAccounts().then(setAccounts)
  }, [])

  const seatAccount = (seat: SeatDraft): AccountOption | undefined =>
    accountOptions(accounts, seat.provider).find((o) => o.key === seat.account) ??
    savedAccount(accounts, seat.provider)

  const addSeat = (p: Provider): void =>
    setSeats((s) => (s.length >= MAX_SEATS ? s : [...s, { provider: p }]))
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

  const start = async (): Promise<void> => {
    if (busy || !topic.trim() || seats.length < 2) return
    setError(null)
    setBusy(true)
    window.localStorage.setItem('cockpit:rt-table-mode', tableMode)
    try {
      const rt = await api.createRoundtable({
        topic: topic.trim(),
        repoRoot: selected?.root ?? null,
        mode: tableMode,
        maxRounds: tableMode === 'consensus' ? maxRounds : undefined,
        seats: seats.map((seat) => {
          const acct = seatAccount(seat)
          const model = seat.model?.trim()
          return {
            provider: seat.provider,
            configDir: acct?.configDir,
            copilotUser: acct?.copilotUser,
            accountLabel: acct?.display,
            model: model || undefined
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
                disabled={seats.length >= MAX_SEATS}
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
          Two to four seats. A provider can sit twice with different models — same mind,
          different depth. Every message reaches all seats at once; rounds are how they
          answer each other.
        </div>

        {seats.length > 0 && (
          <>
            <span className="ns-label" id="rt-seats-label">Seats</span>
            <div className="rt-seat-config" role="group" aria-labelledby="rt-seats-label">
              {seats.map((seat, i) => {
                const opts = accountOptions(accounts, seat.provider)
                const acct = seatAccount(seat)
                return (
                  <div key={i} className="rt-seat-cfg-row">
                    <span className={`plogo plogo-${seat.provider}`} aria-hidden="true">
                      <ProviderLogo p={seat.provider} size={13} />
                    </span>
                    <span className="rt-seat-cfg-name">{seatLabel(i)}</span>
                    {opts.length > 1 ? (
                      <Select
                        ariaLabel={`${seatLabel(i)} account`}
                        mono
                        value={acct?.key ?? ''}
                        options={opts.map((o) => ({ value: o.key, label: o.display }))}
                        onChange={(v) => patchSeat(i, { account: v })}
                      />
                    ) : (
                      <span className="rt-seat-cfg-acct" title={acct?.display}>
                        {acct?.identity ?? (accounts === null ? '…' : 'not signed in')}
                      </span>
                    )}
                    <input
                      aria-label={`${seatLabel(i)} model`}
                      list={`rt-models-${seat.provider}`}
                      placeholder="default model"
                      value={seat.model ?? ''}
                      onChange={(e) => patchSeat(i, { model: e.target.value })}
                    />
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
                value={String(maxRounds)}
                options={[2, 3, 4, 5].map((n) => ({
                  value: String(n),
                  label: `${n} rounds`,
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
            disabled={busy || !topic.trim() || seats.length < 2}
          >
            {busy ? 'Opening…' : 'Open roundtable'}
          </button>
        </div>
      </div>
    </main>
  )
}
