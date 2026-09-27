import { ipcMain } from 'electron'
import type { NewRoundtableRequest } from '../../shared/types'
import { CH, PUSH } from '../../shared/contract'
import { signInHint } from '../../shared/agent-auth'
import { AGENT_NAME } from '../../shared/providers'
import { ROUNDTABLE_MAX_SEATS, roundsAllowed, sanitizeRoundtableLimits } from '../../shared/roundtable'
import { branchPrefix, listModelEndpoints, setRoundtableArchived } from '../config'
import { signInState } from '../agent-auth'
import { createWorkspace } from '../workspace'
import type { SeatInit, TablePlace } from '../roundtable'
import { clampRounds, seatOptions } from '../roundtable-core'
import type { Services } from '../services'
import { sendToWin } from '../window'
import { asProvider, assertKnownConfigDir, assertKnownRepoRoot } from './guards'

/** The addressed seats are renderer input — the manager keeps only real seat indexes. */
function seatList(raw: unknown): number[] | undefined {
  return raw === undefined || raw === null ? undefined : Array.isArray(raw) ? raw.map(Number) : []
}

/** Roundtables: several agents, one shared discussion. */
export function registerRoundtableHandlers(s: Services): void {
  const { tables } = s

  ipcMain.handle(CH.roundtableList, () => tables.list())
  ipcMain.handle(CH.roundtableGet, (_e, id: string) => tables.get(String(id)))
  ipcMain.handle(CH.roundtableArchive, (_e, id: string, archived: boolean) => {
    // a running table would keep its board row while the tree hid it — stop it first
    if (Boolean(archived) && tables.isRunning(String(id))) {
      throw new Error('That roundtable is mid-round. Stop it first.')
    }
    tables.setArchived(setRoundtableArchived(String(id), Boolean(archived)))
    s.forgetThrownAway()
    // the tree, the board and the palette all read the table list on an index update
    sendToWin(PUSH.indexUpdated)
  })
  ipcMain.handle(CH.roundtableCreate, async (_e, req: NewRoundtableRequest) => {
    const topic = String(req?.topic ?? '').trim()
    if (!topic) throw new Error('A topic is required.')
    if (topic.length > 20_000) throw new Error('Topic is too long.')
    // seats are renderer input: known providers only (a provider may repeat with a
    // different model), and any config home re-validated against main-derived
    // sources before a CLI runs on it. Discussion-only — no permission mode exists.
    const seats: SeatInit[] = []
    for (const raw of Array.isArray(req?.seats) ? req.seats : []) {
      const provider = asProvider(raw?.provider)
      seats.push({
        provider,
        configDir:
          raw.configDir === undefined ? undefined : assertKnownConfigDir(raw.configDir, provider),
        copilotUser: raw.copilotUser === undefined ? undefined : String(raw.copilotUser),
        accountLabel:
          raw.accountLabel === undefined ? undefined : String(raw.accountLabel).slice(0, 200),
        // model and model provider are per seat, judged against the configured list
        options: seatOptions(provider, raw, listModelEndpoints())
      })
    }
    const limits = sanitizeRoundtableLimits(req?.limits)
    if (seats.length < 2) throw new Error('Pick at least two seats for a roundtable.')
    if (seats.length > ROUNDTABLE_MAX_SEATS) {
      throw new Error(`A table seats at most ${ROUNDTABLE_MAX_SEATS}.`)
    }
    // consensus knobs are renderer input: whitelist the mode, clamp the round cap to
    // what one message may spend with this many seats
    const tableMode = req?.mode === 'consensus' ? 'consensus' : 'open'
    const maxRounds = Math.min(clampRounds(req?.maxRounds), roundsAllowed(limits, seats.length))
    // a seat whose CLI is signed out would fail every turn while the others spent
    // theirs answering it — refuse before anything runs, with the command that fixes it
    const homes = [...new Map(seats.map((seat) => [`${seat.provider}|${seat.configDir ?? ''}`, seat])).values()]
    const states = await Promise.all(homes.map((seat) => signInState(seat.provider, seat.configDir)))
    const broken = homes
      .map((seat, i) => ({ seat, state: states[i] }))
      .filter(({ state }) => state === 'signed-out' || state === 'missing')
    if (broken.length > 0) {
      throw new Error(
        broken
          .map(({ seat, state }) =>
            state === 'missing'
              ? `${AGENT_NAME[seat.provider]} isn't installed — Cockpit can't find its \`${seat.provider}\` command.`
              : `${AGENT_NAME[seat.provider]} isn't signed in${seat.accountLabel ? ` (${seat.accountLabel})` : ''}. ${signInHint(seat.provider, seat.configDir)}`
          )
          .join('\n')
      )
    }
    let place: TablePlace | null = null
    if (req.repoRoot !== null && req.repoRoot !== undefined) {
      const root = assertKnownRepoRoot(s.indexer, req.repoRoot)
      const ws = await createWorkspace(root, `table ${topic.slice(0, 30)}`, { prefix: branchPrefix() })
      place = { cwd: ws.cwd, branch: ws.branch, repoRoot: root }
    }
    return tables.create({ topic, seats, mode: tableMode, maxRounds, limits }, place)
  })
  // limits are renderer input: every field clamped to its range
  ipcMain.handle(CH.roundtableSetLimits, (_e, id: string, limits: unknown, maxRounds: unknown) =>
    tables.setLimits(
      String(id),
      sanitizeRoundtableLimits(limits),
      typeof maxRounds === 'number' ? maxRounds : undefined
    )
  )
  ipcMain.handle(CH.roundtableSend, (_e, id: string, text: string, opts: unknown) => {
    const o = (opts && typeof opts === 'object' ? opts : {}) as Record<string, unknown>
    return tables.sendMessage(String(id), String(text), {
      seats: seatList(o['seats']),
      whenBusy: o['whenBusy'] === 'interrupt' ? 'interrupt' : 'queue'
    })
  })
  ipcMain.handle(CH.roundtableSkip, (_e, id: string, seat: unknown) =>
    tables.skipSeat(String(id), Number(seat))
  )
  ipcMain.handle(CH.roundtableUnqueue, (_e, id: string) => tables.unqueue(String(id)))
  ipcMain.handle(CH.roundtableContinue, (_e, id: string, seats: unknown) =>
    tables.continueRound(String(id), seatList(seats))
  )
  ipcMain.handle(CH.roundtableStop, (_e, id: string) => tables.stop(String(id)))
}
