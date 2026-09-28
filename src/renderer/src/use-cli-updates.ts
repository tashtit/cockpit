import { useRef, useState } from 'react'
import { runsHomebrew } from '../../shared/agent-cli'
import type { CliStatus, Provider } from '../../shared/types'
import { api } from './api'
import { ipcErrorText } from './ipc-error'
import { PROVIDER_LABEL } from './logos'
import { useWatchUntil } from './SignInFix'

/**
 * An agent CLI's update, handed to Terminal — the one flow Settings › Accounts and the
 * home's updates list both offer, kept here so the two can't drift apart.
 *
 * Opening Terminal is not the update: the person answers it there, and it lands
 * minutes later. So each opened update is remembered with the version the CLI had,
 * the row says to finish it in Terminal and offers "Open Terminal again", and while
 * anything is open the CLIs are asked again every few seconds (`useWatchUntil`) until
 * the version moves on. One Terminal per click, never two from a double click: two
 * `npm install -g` of one package at once can leave the CLI half-installed, and a
 * second `brew upgrade` only queues behind the first. "Open Terminal again" after the
 * first one opened stays a deliberate second click.
 */

/** An update opened in Terminal: the version the CLI had then, and the window it runs in —
 *  its own (`update:<provider>`), or the one window that updates several Homebrew CLIs */
export type OpenedUpdate = { readonly was: string | null; readonly run: string }

const TOGETHER_RUN = 'update:homebrew'

export type CliUpdates = {
  /** CLIs whose update was opened in Terminal, until their version moves on */
  readonly updating: Readonly<Record<string, OpenedUpdate>>
  /** CLIs whose channel is being refreshed, with what it offered then */
  readonly refreshing: Readonly<Record<string, string | null>>
  /** what opening Terminal failed with, in main's own words */
  readonly error: string | null
  /** Fold a fresh status list in: an update landed once the version moved on; a refresh, once the channel did */
  readonly settle: (next: readonly CliStatus[]) => void
  /** Open Terminal on one CLI's update; `was` is the version it has now. True once opened */
  readonly update: (provider: Provider, was: string | null) => Promise<boolean>
  /** One window for several Homebrew CLIs — one `brew update`, no turns to take */
  readonly updateTogether: (clis: readonly CliStatus[]) => Promise<boolean>
  /** Open Terminal on `brew update`, for a channel that lags the release */
  readonly refreshChannel: (cli: CliStatus) => Promise<boolean>
  /**
   * What a row with a Terminal window open says. Homebrew runs one at a time, so main
   * queues its windows on one lock; a row whose window shares that queue with another
   * says so, rather than leave a waiting window looking stuck. `clis` is what is known
   * about how each CLI updates — without it, every window is taken to run alone.
   */
  readonly inTerminal: (lead: string, p: Provider, clis: readonly CliStatus[] | null) => string
}

export type CliUpdatesOptions = {
  /** each answer the watch gets, for a view that shows the list itself */
  readonly onChecked?: (next: readonly CliStatus[]) => void
  /** an opened update or refresh landed — the view's own list is out of date now */
  readonly onLanded?: () => void
  /** the line a view shows when Terminal opened */
  readonly onStatus?: (s: string) => void
}

export function useCliUpdates(opts: CliUpdatesOptions = {}): CliUpdates {
  const [updating, setUpdating] = useState<Readonly<Record<string, OpenedUpdate>>>({})
  const [refreshing, setRefreshing] = useState<Readonly<Record<string, string | null>>>({})
  const [error, setError] = useState<string | null>(null)
  // read fresh by the watch and by `settle`, which outlive the render that made them
  const pending = useRef({ updating, refreshing })
  pending.current = { updating, refreshing }
  const latest = useRef(opts)
  latest.current = opts

  const settle = (next: readonly CliStatus[]): void => {
    const { updating: u, refreshing: r } = pending.current
    const keptUpdates = Object.entries(u).filter(([p, o]) => next.find((c) => c.provider === p)?.version === o.was)
    const keptRefreshes = Object.entries(r).filter(([p, was]) => next.find((c) => c.provider === p)?.latest === was)
    const landed =
      keptUpdates.length < Object.keys(u).length || keptRefreshes.length < Object.keys(r).length
    if (!landed) return
    setUpdating(Object.fromEntries(keptUpdates))
    setRefreshing(Object.fromEntries(keptRefreshes))
    latest.current.onLanded?.()
  }

  // Homebrew's own answer is re-read every minute, so a plain ask picks a refresh up
  useWatchUntil(
    Object.keys(updating).length + Object.keys(refreshing).length > 0,
    () =>
      void api
        .listCliStatus(false)
        .then((next) => {
          latest.current.onChecked?.(next)
          settle(next)
        })
        .catch(() => {}),
    { everyMs: 5_000, forMs: 10 * 60_000 }
  )

  const opening = useRef(new Set<string>())
  const once = async (key: string, open: () => Promise<void>): Promise<boolean> => {
    if (opening.current.has(key)) return false
    opening.current.add(key)
    setError(null)
    try {
      await open()
      return true
    } catch (err) {
      setError(ipcErrorText(err))
      return false
    } finally {
      opening.current.delete(key)
    }
  }

  const update = (provider: Provider, was: string | null): Promise<boolean> =>
    once(`update:${provider}`, async () => {
      await api.openCliUpdate(provider)
      setUpdating((u) => ({ ...u, [provider]: { was, run: `update:${provider}` } }))
      latest.current.onStatus?.(`Opened Terminal to update ${PROVIDER_LABEL[provider]}`)
    })

  const updateTogether = (clis: readonly CliStatus[]): Promise<boolean> =>
    once(TOGETHER_RUN, async () => {
      await api.openCliUpdateHomebrew(clis.map((c) => c.provider))
      setUpdating((u) => ({
        ...u,
        ...Object.fromEntries(clis.map((c) => [c.provider, { was: c.version, run: TOGETHER_RUN }]))
      }))
      latest.current.onStatus?.(`Opened Terminal to update ${clis.map((c) => PROVIDER_LABEL[c.provider]).join(' and ')}`)
    })

  const refreshChannel = (c: CliStatus): Promise<boolean> =>
    once(`refresh:${c.provider}`, async () => {
      await api.openCliChannelRefresh(c.provider)
      setRefreshing((r) => ({ ...r, [c.provider]: c.latest }))
      latest.current.onStatus?.(`Opened Terminal to refresh what ${c.channel ?? 'the channel'} knows`)
    })

  const inTerminal = (lead: string, p: Provider, clis: readonly CliStatus[] | null): string => {
    const brewRuns = new Map<string, Provider[]>()
    const joinRun = (run: string, who: Provider): void => {
      brewRuns.set(run, [...(brewRuns.get(run) ?? []), who])
    }
    for (const c of clis ?? []) {
      if (refreshing[c.provider] !== undefined) joinRun(`refresh:${c.provider}`, c.provider)
      const opened = updating[c.provider]
      if (opened && c.updateCommand !== null && runsHomebrew(c.updateCommand)) joinRun(opened.run, c.provider)
    }
    // the rows one window updates together take no turns
    const runs = [...brewRuns.values()]
    const others = runs.some((r) => r.includes(p)) ? [...new Set(runs.filter((r) => !r.includes(p)).flat())] : []
    if (others.length === 0) return `${lead} — this row updates by itself.`
    const names = others.map((o) => `${PROVIDER_LABEL[o]}’s`).join(' and ')
    return `${lead} — it takes turns with ${names}, since Homebrew runs one at a time. This row updates by itself.`
  }

  return { updating, refreshing, error, settle, update, updateTogether, refreshChannel, inTerminal }
}
