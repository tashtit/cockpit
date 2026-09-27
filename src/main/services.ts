import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AcpAgent, AcpReadiness, BusySession, ChatRequest, PrStatus, SessionMeta, SessionProvider } from '../shared/types'
import { PUSH } from '../shared/contract'
import { BUILTIN_ACP_AGENTS, builtinAgentFor } from '../shared/acp'
import { AGENT_LABEL, isDrivable, SESSION_PROVIDERS } from '../shared/providers'
import { SessionIndexer } from './indexer'
import { TranscriptSearcher } from './transcript-search'
import { ChatManager } from './chat'
import { probeAcpAgent } from './acp'
import { loginPathReady } from './env'
import { mergeBusy } from './liveness-core'
import {
  adoptDetectedSources,
  attentionPrefs,
  listAcpAgents,
  listModelEndpoints,
  loadConfig,
  userDataDir,
  type AppConfig
} from './config'
import { surveyCleanup, type CleanupDeps } from './cleanup'
import { DEFAULT_STALE_DAYS, providerWorktreeHomes } from './cleanup-core'
import { CleanupReminder } from './cleanup-reminder'
import { RoundtableManager } from './roundtable'
import { setCopilotActiveUser } from './accounts'
import { getEndpointKey } from './secrets'
import { UpdateManager } from './updates'
import { AttentionDesk, electronSurface } from './attention'
import { tableOutcome } from './attention-core'
import { worktreesDir } from './workspace'
import { defaultConfigHome } from './paths'
import { TurnLedger } from './turn-ledger'
import { onWindowFocus, openAttentionTarget, sendToWin } from './window'

/**
 * Everything main runs, built once at startup and handed to the IPC handlers
 * (`ipc/`). Built in dependency order; the few callbacks that reach back to something
 * built later (the indexer's, the chat stream's) only ever run after startup finished.
 */
export type Services = {
  readonly indexer: SessionIndexer
  readonly transcripts: TranscriptSearcher
  readonly chat: ChatManager
  /** Side questions' turns: a manager of their own, so none reaches the busy board or the desk */
  readonly sideChat: ChatManager
  readonly tables: RoundtableManager
  readonly desk: AttentionDesk
  readonly reminder: CleanupReminder
  readonly updates: UpdateManager
  readonly ledger: TurnLedger
  /**
   * Every session with a turn in progress: the ones Cockpit spawned (ChatManager knows
   * exactly) and the ones the indexer sees mid-turn in their logs (a terminal, the
   * provider's own app). One set, one push — the renderer never learns which is which
   * unless it asks `source`.
   */
  readonly busySessions: () => BusySession[]
  /** Archived or deleted, here or in the provider's own app: nothing about it is news any more. */
  readonly forgetThrownAway: () => void
  /** The session whose row carries a pull request, if any (see `prCarrier`). */
  readonly prCarrier: (repoRoot: string, pr: PrStatus) => string | null
  /** A config replaced wholesale (a restore) only reaches the tree once the indexer is told. */
  readonly republishConfig: () => void
  /** What the cleanup scan and its actions read — the view's and the daily reminder's alike. */
  readonly cleanupDeps: () => CleanupDeps
  /**
   * The ACP agent a turn of this agent runs through when the person picked none — the one
   * answer to "can this agent be sent a turn" for an agent Cockpit otherwise only reads
   */
  readonly acpAgentFor: (provider: SessionProvider) => AcpAgent | undefined
  /** Which agents a session can be started or continued with; asking re-probes a missing built-in */
  readonly acpReadiness: (opts?: { readonly reprobe?: boolean }) => AcpReadiness
  /** Tell the window what `acpReadiness` now says — an ACP agent was added or removed */
  readonly pushAcpReadiness: () => void
}

/** The index's view of the config — applied at startup and again after a restore. */
function applyConfig(indexer: SessionIndexer, cfg: AppConfig): void {
  indexer.setArchived(cfg.archived ?? [])
  indexer.setHiddenRepos(cfg.hiddenRepos ?? [])
  indexer.setRepoOrder(cfg.repoOrder ?? [])
  indexer.setHistoryDays(cfg.historyDays ?? 0)
  indexer.setLineage(cfg.continuedFrom ?? {})
  indexer.setControl(cfg.sessionControl ?? {})
  void indexer.setSources(cfg.sources)
}

/** Copilot multi-account: a turn runs as the user it names, activated before it spawns. */
export function activateCopilotUser(req: Pick<ChatRequest, 'provider' | 'configDir' | 'copilotUser'>): void {
  if (req.provider === 'copilot' && req.copilotUser) {
    setCopilotActiveUser(req.configDir ?? defaultConfigHome('copilot'), req.copilotUser)
  }
}

export function startServices(): Services {
  // late-bound: the indexer and the chat stream call back into these, which are built after them
  let chat: ChatManager | null = null
  let tables: RoundtableManager | null = null
  let desk: AttentionDesk | null = null

  const busySessions = (): BusySession[] =>
    mergeBusy(chat?.busySessions() ?? [], indexer.liveSessions())
  const pushBusy = (): void => sendToWin(PUSH.busySessions, busySessions())

  /**
   * The session whose row carries a pull request: the newest one working on the PR's
   * head branch in that repo (linked worktrees group under the main root, so a session
   * in a worktree matches its repo). Seats belong to their table, never to a PR; a
   * branch no session is on has no row, and the PR waits until one appears.
   */
  const prCarrier = (repoRoot: string, pr: PrStatus): string | null => {
    if (!pr.headRefName) return null
    const match = indexer
      .allSessions()
      .filter(
        (s) =>
          s.repo?.root === repoRoot &&
          s.gitBranch === pr.headRefName &&
          !(s.cwd !== null && tables?.tableIdForCwd(s.cwd))
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)[0]
    return match?.id ?? null
  }

  /** Copilot never names its session: once the index has it, an id-less landing becomes that session. */
  const resolveAttention = (): void => {
    let copilot: SessionMeta[] | null = null
    desk?.resolve((u) => {
      if (u.provider !== 'copilot' || !u.cwd) return null
      const cwd = resolve(u.cwd)
      copilot ??= indexer.allSessions().filter((s) => s.provider === 'copilot' && s.cwd)
      const match = copilot
        .filter((s) => resolve(s.cwd as string) === cwd && s.startedAt >= u.startedAt - 60_000)
        .sort((a, b) => a.startedAt - b.startedAt)[0]
      return match?.id ?? null
    })
  }

  const forgetThrownAway = (): void => {
    desk?.forget({
      session: (id) => indexer.thrownAway(id),
      table: (id) => tables?.isArchived(id) ?? false
    })
  }

  const indexer = new SessionIndexer(
    () => {
      ledger.resolveCopilotHandoffs()
      resolveAttention()
      forgetThrownAway()
      sendToWin(PUSH.indexUpdated)
    },
    {
      cacheFile: join(userDataDir(), 'index-cache.json'),
      cockpitWorktrees: worktreesDir(),
      onLiveChange: () => pushBusy(),
      // a turn in a terminal or the provider's own app ended, or stopped to ask — news
      // the way a spawned turn's ending is; a seat's turn is its table's business
      onLiveTurn: (ev) => {
        if (ev.cwd !== null && tables?.tableIdForCwd(ev.cwd)) return
        desk?.observedTurn(ev)
      }
    }
  )
  // the first turn of an agent Cockpit only reads may write into a home that did not
  // exist at launch — adopted the way launch adopts one, so the session it wrote is listed
  const ledger = new TurnLedger(indexer, {
    onReadOnlyTurnDone: () => {
      const known = loadConfig().sources.length
      const cfg = adoptDetectedSources()
      if (cfg.sources.length !== known) void indexer.setSources(cfg.sources)
    }
  })
  // candidate files come only from the indexer — the renderer never names a path
  const transcripts = new TranscriptSearcher(indexer)
  // an agent installed, or an editor that gained Cline, since the last launch is indexed
  // from this one on — a source the person removed is never added back
  applyConfig(indexer, adoptDetectedSources())

  const republishConfig = (): void => {
    applyConfig(indexer, loadConfig())
    sendToWin(PUSH.indexUpdated)
  }

  // app updates from GitHub Releases — the manager refuses everything but an installed
  // macOS build, so dev runs and e2e never reach the network
  const updates = new UpdateManager((state) => sendToWin(PUSH.updateState, state))

  /*
   * Attention: a notification, a sound and the Dock badge when a turn ends unseen.
   * attention-core decides, the desk carries it out; the renderer reports what is on
   * screen and the window's focus events say whether anyone is in front of it.
   */
  const theDesk = new AttentionDesk({
    file: join(userDataDir(), 'attention.json'),
    surface: electronSurface(),
    prefs: attentionPrefs(),
    titleFor: (u) => (u.id ? (indexer.getSession(u.id)?.title ?? null) : null),
    onLandings: (landings) => sendToWin(PUSH.landings, landings),
    onCleanup: (notice) => sendToWin(PUSH.cleanupNotice, notice),
    onOpen: openAttentionTarget
  })
  desk = theDesk
  onWindowFocus((focused) => theDesk.setWindowFocused(focused))
  // a question saved as waiting may have been answered while Cockpit was closed — once the
  // first scan knows each session's log, the desk re-reads those tails and keeps what still asks
  void indexer.whenScanned().then(() => theDesk.recheckAsks((id) => indexer.getSession(id)))

  /**
   * Built-in ACP agents this machine's CLIs turned out to support, by id — probed in the
   * background at startup, and again for any still missing when the window asks, at most
   * once a minute, so a CLI installed while Cockpit runs is picked up without a restart.
   *
   * The handshake is the only honest test — a `--acp` flag in `--help` says the flag
   * parses, not that the protocol answers. It costs one process launch per agent and
   * creates no session. Until a probe lands, Copilot's turns take its CLI path, and an
   * agent Cockpit otherwise only reads stays read-only: the worst case of a slow or
   * missing CLI is the behaviour Cockpit had before ACP existed.
   */
  const acpReady = new Set<string>()
  const acpProbing = new Set<string>()
  let acpProbedAt = 0
  const acpAgentFor = (provider: SessionProvider): AcpAgent | undefined => {
    // one the person defined for this agent is a deliberate choice and wins over the built-in
    const defined = listAcpAgents().find((a) => a.provider === provider)
    if (defined) return defined
    const builtin = builtinAgentFor(provider)
    return builtin && acpReady.has(builtin.id) ? builtin : undefined
  }
  const currentAcpReadiness = (): AcpReadiness => ({
    drivable: SESSION_PROVIDERS.filter((p) => isDrivable(p) || acpAgentFor(p) !== undefined),
    builtinsReady: BUILTIN_ACP_AGENTS.filter((a) => acpReady.has(a.id)).map((a) => a.id)
  })
  const pushAcpReadiness = (): void => sendToWin(PUSH.acpReadiness, currentAcpReadiness())
  const probeAcpBuiltins = (): void => {
    acpProbedAt = Date.now()
    for (const builtin of BUILTIN_ACP_AGENTS) {
      if (acpReady.has(builtin.id) || acpProbing.has(builtin.id)) continue
      acpProbing.add(builtin.id)
      // after the login shell's PATH: an npm-installed CLI is on no other
      void loginPathReady()
        .then(() => probeAcpAgent(builtin, homedir()))
        .then((probe) => {
          if (!probe.ok) return
          acpReady.add(builtin.id)
          pushAcpReadiness()
        })
        .finally(() => acpProbing.delete(builtin.id))
    }
  }
  const acpReadiness = (opts: { readonly reprobe?: boolean } = {}): AcpReadiness => {
    if (opts.reprobe && Date.now() - acpProbedAt > 60_000) probeAcpBuiltins()
    return currentAcpReadiness()
  }
  probeAcpBuiltins()

  const theChat = new ChatManager(
    (ev) => {
      // roundtable turns stream on their own channel — never as plain chat events
      if (tables?.handleChatEvent(ev)) return
      ledger.chatEvent(ev)
      theDesk.chatEvent(ev)
      sendToWin(PUSH.chatEvent, ev)
    },
    {
      onBusyChange: () => pushBusy(),
      // a seat's turn has no chat to put a permission question in: it keeps the refusal
      // a headless CLI gives anything it would have asked
      asksPermissions: (req) => !tables?.tableIdForCwd(req.cwd),
      resolveAcpAgent: (req) => {
        const chosen = req.options?.acpAgent
        if (chosen && chosen !== 'auto') {
          const agent = [...listAcpAgents(), ...BUILTIN_ACP_AGENTS].find((a) => a.id === chosen)
          // refusing loudly beats silently running the provider's own CLI instead: the
          // user picked a specific agent, and a different one is a different answer
          if (!agent) throw new Error('That ACP agent is no longer configured — re-add it in Settings.')
          if (agent.provider !== req.provider) {
            throw new Error(`"${agent.label}" drives ${AGENT_LABEL[agent.provider]}, not ${AGENT_LABEL[req.provider]}.`)
          }
          return agent
        }
        return acpAgentFor(req.provider)
      },
      onTurnStart: (turnId, req) => {
        // a seat's turn is its table's business — the table lands once, as a whole
        if (tables?.tableIdForCwd(req.cwd)) return
        theDesk.turnStarted({
          turnId,
          provider: req.provider,
          cwd: req.cwd,
          prompt: req.prompt,
          resumeNativeId: req.resumeNativeId
        })
      },
      onTurnCancel: (turnId) => theDesk.turnCancelled(turnId),
      resolveEndpoint: (id) => listModelEndpoints().find((e) => e.id === id),
      resolveKey: (ep) => getEndpointKey(ep.id)
    }
  )
  chat = theChat

  // side chat: questions asked of a throwaway copy of a session. A ChatManager of its
  // own, so a side turn never marks its session busy, never lands on the attention desk
  // and never streams into the chat; one side question runs per session at a time
  const sideChat = new ChatManager((ev) => sendToWin(PUSH.sideChatEvent, ev), {
    resolveEndpoint: (id) => listModelEndpoints().find((e) => e.id === id),
    resolveKey: (ep) => getEndpointKey(ep.id)
  })

  // roundtables: several agents, one shared discussion, driven through the same
  // ChatManager (its emit hands their stream events to the manager above)
  const roundtableRoot = join(userDataDir(), 'roundtables')
  const theTables = new RoundtableManager(roundtableRoot, {
    sendTurn: (req) => {
      // a seat runs as the user it was seated with — the same activation chat:send does.
      // A throw here is that seat's failed turn (the manager records it), never a turn
      // quietly run as somebody else.
      activateCopilotUser(req)
      return theChat.send(req)
    },
    cancelTurn: (turnId) => theChat.cancel(turnId),
    emit: (ev) => {
      sendToWin(PUSH.roundtableEvent, ev)
      // a table's run ending is news the way a turn's is — unless the user stopped it
      if (ev.type !== 'round' || ev.running || ev.stopped) return
      try {
        const t = theTables.get(ev.id)
        theDesk.tableEnded({ id: t.id, title: t.title, outcome: tableOutcome(t) })
      } catch {
        /* the table is gone */
      }
    }
  })
  tables = theTables
  theTables.setArchived(loadConfig().archivedRoundtables ?? [])
  // seat-sessions (anything whose cwd is a table's room/worktree) leave the normal
  // session listings and page only under their table
  indexer.setRoundtableResolver((cwd) => theTables.tableIdForCwd(cwd))

  /*
   * Cleanup: the cross-agent, cross-repo view of what has gone stale. Every input
   * it acts on is main-derived — session ids are re-looked-up in the index and
   * their files re-checked against the configured sources, and worktree paths are
   * re-derived from git before a single one is removed (see cleanup.ts).
   */
  const cleanupDeps = (): CleanupDeps => ({
    sessions: () => indexer.cleanupSessions(),
    repoRoots: () => [...indexer.knownRepoRoots()],
    cockpitWorktreeRoot: worktreesDir(),
    busyIds: () => new Set(busySessions().map((b) => b.id)),
    tableForCwd: (cwd) => theTables.tableIdForCwd(cwd) ?? null,
    sourceDirs: () => loadConfig().sources.map((s) => s.path),
    // Codex and Copilot cut theirs under their config homes; Claude Code's sit inside each repo
    worktreeHomes: () => providerWorktreeHomes(loadConfig().sources),
    selfPid: process.pid,
    tables: () => theTables.forCleanup(),
    seatSessions: () => indexer.roundtableSessions(),
    roundtableRoot,
    forgetTable: (id) => theTables.forget(id)
  })
  /*
   * Once a day, the same scan in the background. When something new is ready to clean
   * (at most weekly — cleanup-reminder-core.ts), the attention desk marks Cleanup in the
   * sidebar and says so. The view's own scans count as the person looking.
   */
  const reminder = new CleanupReminder({
    file: join(userDataDir(), 'cleanup-reminder.json'),
    survey: async () =>
      (await surveyCleanup(cleanupDeps(), loadConfig().staleDays ?? DEFAULT_STALE_DAYS)).ready,
    enabled: () => theDesk.currentPrefs.cleanup,
    remind: (notice) => theDesk.cleanupReady(notice)
  })
  void indexer.whenScanned().then(() => reminder.start())

  return {
    indexer,
    transcripts,
    chat: theChat,
    sideChat,
    tables: theTables,
    desk: theDesk,
    reminder,
    updates,
    ledger,
    busySessions,
    forgetThrownAway,
    prCarrier,
    republishConfig,
    cleanupDeps,
    acpAgentFor,
    acpReadiness,
    pushAcpReadiness
  }
}
