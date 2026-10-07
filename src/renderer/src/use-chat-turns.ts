import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChatEvent, ChatPermission, ChatRequest, PermissionMode, SessionMessage, TurnModeChange } from '../../shared/types'
import { api } from './api'
import { modeLabel } from './agent-choice'
import type { PendingPermission } from './chat-binding'
import { addChatMessage, addChatNotice, announceChat, endChatStream, streamChatText } from './chat-log'
import { ipcErrorText } from './ipc-error'
import { rejoinStream, type Rejoin } from './rejoin'

/**
 * What the open conversation is told by its turns. Pass stable functions (`useCallback`
 * over refs): the stream subscription is remade whenever one of them changes.
 */
type TurnHandlers = {
  /** What the agent is called in an announcement — the provider behind the chat */
  readonly speaker: () => string
  /** The turn named the provider's session it writes: a new session's first id, or the
   *  one claude forks for every resumed turn */
  readonly onSession: (nativeSessionId: string) => void
  /** The turn ended or was stopped: the log on disk is the conversation again */
  readonly onSettled: () => void
}

type ChatTurns = {
  /** The turn streaming into the open chat; null while it is idle */
  readonly activeTurn: string | null
  /** The same, as of now — for a handler that may run before the next render */
  readonly activeTurnRef: { readonly current: string | null }
  /** The questions the turn on screen is blocked on */
  readonly permissions: readonly PendingPermission[]
  readonly answerPermission: (ask: PendingPermission, optionId: string) => void
  /** Send a turn and adopt it as the open chat's; rejects as `sendChat` does */
  readonly run: (req: ChatRequest) => Promise<void>
  /**
   * A conversation is being opened: a turn of ours still running on it (`turnId`) is
   * rejoined — its stream and its Stop — rather than shown idle with Send open beside it.
   * Null leaves the chat idle.
   */
  readonly join: (turnId: string | null) => void
  /**
   * The opened session's log is on screen: a rejoined turn's stream is let in behind it.
   * False when no turn waits on the log.
   */
  readonly logLanded: (messages: readonly SessionMessage[]) => boolean
  /** Stop the turn on screen */
  readonly cancel: () => void
  /** Another permission mode was picked: the turn on screen runs the rest of its way in
   *  it where it can, and the transcript says which it did */
  readonly changeMode: (mode: PermissionMode) => void
}

/** What the transcript says of a mode picked while a turn runs, `agent` being who runs it. */
export function modeChangeNotice(mode: PermissionMode, change: TurnModeChange, agent: string): string {
  const label = modeLabel(mode)
  if (!change.live) return `${label} starts with your next message — ${agent} can’t change mode mid-turn.`
  if (change.allowed === 0) return `${label} from here on.`
  const n = change.allowed
  return `${label} from here on — allowed the ${n === 1 ? 'request' : `${n} requests`} waiting.`
}

/**
 * The open chat's turns: which one streams into it, the events that arrive for it (and
 * the ones that beat `sendChat`'s reply), a turn rejoined after its session was opened
 * again, and the permission questions every turn is blocked on.
 */
export function useChatTurns({ speaker, onSession, onSettled }: TurnHandlers): ChatTurns {
  const [activeTurn, setActiveTurn] = useState<string | null>(null)
  const activeTurnRef = useRef<string | null>(null)
  activeTurnRef.current = activeTurn
  /** Events can beat the sendChat() reply for fast-failing spawns — hold them briefly. */
  const pendingEventsRef = useRef<ChatEvent[]>([])
  /** The active turn was running before its session was opened: its stream waits on the
   *  log being read, then skips the rows the log already holds (rejoin.ts). */
  const rejoinRef = useRef<Rejoin | null>(null)
  /** Did this turn report an error? "finished" would be a lie if it did. */
  const turnFailedRef = useRef(false)

  /**
   * Permission questions an ACP or Claude turn is blocked on. Kept out of the transcript on
   * purpose: this is a thing that is true *now*, not a thing that happened, and the
   * agent does not move again until one of them is answered. Main keeps them too, and
   * hands them back to a window that rejoins the turn (see `beginTurn`).
   */
  const [permissions, setPermissions] = useState<PendingPermission[]>([])

  /**
   * A question a turn is now blocked on. A card belongs to the turn that asked: the chat
   * shows only the active turn's (`turnPermissions`), so an answer can never land in
   * another conversation's transcript, and one asked by a turn off screen waits for its
   * own chat — a rejoined turn must still find it. It goes when it is answered, when its
   * agent withdraws it, and when its turn ends or is stopped. Request ids are the agent's own counter, so only turn and id together name
   * one; a repeat replaces the earlier copy.
   */
  const askPermission = useCallback((ev: ChatPermission) => {
    setPermissions((list) => [
      ...list.filter((a) => a.turnId !== ev.turnId || a.requestId !== ev.requestId),
      {
        turnId: ev.turnId,
        requestId: ev.requestId,
        toolName: ev.toolName,
        preview: ev.preview ?? ev.detail,
        detail: ev.detail,
        options: ev.options,
        ...(ev.reason ? { reason: ev.reason } : {}),
        ...(ev.blockedPath ? { blockedPath: ev.blockedPath } : {}),
        ...(ev.sandboxBypass ? { sandboxBypass: true as const } : {})
      }
    ])
  }, [])

  /** A question its agent gave up on: nothing is left to answer, so its card goes. */
  const withdrawPermission = useCallback((turnId: string, requestId: string) => {
    setPermissions((list) => list.filter((a) => a.turnId !== turnId || a.requestId !== requestId))
  }, [])

  const answerPermission = useCallback((ask: PendingPermission, optionId: string) => {
    const label = ask.options.find((o) => o.optionId === optionId)?.name ?? optionId
    setPermissions((list) =>
      list.filter((a) => a.turnId !== ask.turnId || a.requestId !== ask.requestId)
    )
    void api.respondPermission(ask.turnId, ask.requestId, optionId)
    // the answer belongs in the transcript even though the question did not — it is
    // what the rest of the turn was conditioned on, and a reader should hear it once
    addChatNotice(`${label} — ${ask.preview}`)
  }, [])

  const applyEvent = useCallback(
    (ev: ChatEvent) => {
      if (ev.type === 'session') {
        onSession(ev.nativeSessionId)
      } else if (ev.type === 'text') {
        streamChatText(ev.text)
      } else if (ev.type === 'tool') {
        addChatMessage({
          role: 'assistant',
          kind: 'tool_call',
          toolName: ev.toolName,
          text: ev.detail,
          preview: ev.preview,
          // a question with options reaches the transcript as an answerable card
          ...(ev.asks ? { asks: ev.asks } : {}),
          // a plan, to-dos or an edit opens in the Work panel as it streams
          ...(ev.artifact ? { artifact: ev.artifact } : {})
        })
      } else if (ev.type === 'permission') {
        // the prompt is not a transcript row, but it must land after what came before it
        endChatStream({ keepText: true })
        askPermission(ev)
      } else if (ev.type === 'permission-withdrawn') {
        // the call was aborted: an answer clicked now would be recorded though nothing ran
        withdrawPermission(ev.turnId, ev.requestId)
      } else if (ev.type === 'error') {
        // said as it happens, even mid-turn: an error nobody hears is the bug
        turnFailedRef.current = true
        addChatNotice(ev.message, `${speaker()}: ${ev.message}`)
      } else if (ev.type === 'done') {
        endChatStream({ keepText: true })
        setActiveTurn(null)
        rejoinRef.current = null
        // the log on disk is the conversation again — a terminal turn after this
        // one shows up here as it lands
        onSettled()
        // the turn is over; anything it was still asking has been answered or abandoned
        setPermissions((list) => list.filter((a) => a.turnId !== ev.turnId))
        announceChat(
          turnFailedRef.current ? `${speaker()} finished with errors` : `${speaker()} finished`
        )
      }
    },
    [speaker, askPermission, withdrawPermission, onSession, onSettled]
  )

  useEffect(() => {
    return api.onChatEvent((ev: ChatEvent) => {
      if (ev.turnId !== activeTurnRef.current) {
        // a question is the one thing a turn off screen can't be allowed to lose: it
        // waits for its conversation, and goes when the turn does
        if (ev.type === 'permission') askPermission(ev)
        else if (ev.type === 'permission-withdrawn') withdrawPermission(ev.turnId, ev.requestId)
        else if (ev.type === 'done')
          setPermissions((list) => list.filter((a) => a.turnId !== ev.turnId))
        // spawn failures can emit before sendChat() resolves with the turn id
        if (activeTurnRef.current === null) {
          pendingEventsRef.current.push(ev)
          if (pendingEventsRef.current.length > 100) pendingEventsRef.current.shift()
        }
        return
      }
      const rejoin = rejoinRef.current
      for (const e of rejoin?.turnId === ev.turnId ? rejoin.offer(ev) : [ev]) applyEvent(e)
    })
  }, [applyEvent, askPermission, withdrawPermission])

  /**
   * Adopt a turn id and replay any events that arrived before we knew it.
   *
   * `rejoin` is a turn that was already running when its session was opened. Its rows
   * are in the log being read, so the replay keeps only what a log never holds (session
   * ids, permission questions, errors), and all of it waits on that read with whatever
   * streams in meanwhile (`logLanded`). One that ended while the window was away is left
   * alone: the log is the whole story.
   */
  const beginTurn = useCallback(
    (turnId: string, { rejoin = false }: { readonly rejoin?: boolean } = {}) => {
      const buffered = pendingEventsRef.current.filter((e) => e.turnId === turnId)
      pendingEventsRef.current = []
      const stillLive = !buffered.some((e) => e.type === 'done')
      if (rejoin && !stillLive) return
      activeTurnRef.current = turnId
      turnFailedRef.current = false
      rejoinRef.current = null
      setActiveTurn(stillLive ? turnId : null)
      if (rejoin) {
        const joined = rejoinStream(turnId)
        for (const ev of buffered) if (ev.type !== 'text' && ev.type !== 'tool') joined.offer(ev)
        rejoinRef.current = joined
        // the cards are this window's own state, and the stream says each question once:
        // after a reload they are gone while the turn still waits on them, so main hands
        // back what it is blocked on. Only while this is still the turn on screen — a
        // conversation left before the answer came asks again when it is opened again
        void api.getPendingPermissions(turnId).then(
          (asks) => {
            if (activeTurnRef.current === turnId) for (const ask of asks) askPermission(ask)
          },
          () => {}
        )
        return
      }
      announceChat(`${speaker()} is working…`)
      for (const ev of buffered) applyEvent(ev)
    },
    [applyEvent, askPermission, speaker]
  )

  const run = useCallback(
    async (req: ChatRequest): Promise<void> => {
      beginTurn(await api.sendChat(req))
    },
    [beginTurn]
  )

  const join = useCallback(
    (turnId: string | null) => {
      // synchronously: the previous conversation's turn must not stream into this one
      activeTurnRef.current = null
      rejoinRef.current = null
      setActiveTurn(null)
      if (turnId !== null) beginTurn(turnId, { rejoin: true })
    },
    [beginTurn]
  )

  const logLanded = useCallback(
    (messages: readonly SessionMessage[]): boolean => {
      const rejoin = rejoinRef.current
      if (!rejoin) return false
      // said now, not as the turn was adopted: putting the log on screen resets the line
      announceChat(`${speaker()} is working…`)
      for (const ev of rejoin.logRead(messages)) applyEvent(ev)
      return true
    },
    [applyEvent, speaker]
  )

  const changeMode = useCallback(
    (mode: PermissionMode) => {
      const turnId = activeTurnRef.current
      // idle, the mode simply goes with the next message
      if (turnId === null) return
      api.setTurnMode(turnId, mode).then(
        (change) => {
          if (activeTurnRef.current === turnId) addChatNotice(modeChangeNotice(mode, change, speaker()))
        },
        (err) => addChatNotice(`Couldn’t change the running turn’s mode: ${ipcErrorText(err)}`)
      )
    },
    [speaker]
  )

  const cancel = useCallback(() => {
    if (activeTurn) {
      void api.cancelChat(activeTurn)
      // the killed turn's terminal `done` no longer matches activeTurnRef, so do
      // its cleanup locally: stop the shimmer and drop any not-yet-flushed text
      setActiveTurn(null)
      rejoinRef.current = null
      setPermissions((list) => list.filter((a) => a.turnId !== activeTurn))
      endChatStream({ keepText: false })
      // as a turn's own end does: the log on disk is the conversation again, or the
      // transcript stops following it until the session is reopened
      onSettled()
      announceChat(`${speaker()} stopped`)
    }
  }, [activeTurn, speaker, onSettled])

  // the questions the turn on screen is blocked on; another conversation's turn keeps
  // its own, for when that conversation is opened and its turn rejoined
  const turnPermissions = useMemo(
    () => permissions.filter((p) => p.turnId === activeTurn),
    [permissions, activeTurn]
  )

  return {
    activeTurn,
    activeTurnRef,
    permissions: turnPermissions,
    answerPermission,
    run,
    join,
    logLanded,
    cancel,
    changeMode
  }
}
