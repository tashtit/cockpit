import { ipcMain } from 'electron'
import { join } from 'node:path'
import type { ChatRequest, SideChatRequest } from '../../shared/types'
import { CH } from '../../shared/contract'
import { AGENT_NAME, isDrivable, isSessionProvider } from '../../shared/providers'
import { noAcpAgent } from '../chat'
import { sessionControlFor, sessionEndpointFor, userDataDir } from '../config'
import { assertChatImages, saveChatImage } from '../chat-images'
import { holderOf } from '../session-control-core'
import { sideTurnRequest } from '../side-chat'
import { activateCopilotUser, type Services } from '../services'
import { assertKnownConfigDir, assertKnownCwd } from './guards'

/** Where pasted chat images live — the only root chat:send accepts image paths from. */
function chatImagesDir(): string {
  return join(userDataDir(), 'chat-images')
}

/** A conversation's turns: sending one, stopping it, answering its permission prompts; side questions. */
export function registerChatHandlers(s: Services): void {
  const { indexer, chat, tables } = s

  ipcMain.handle(CH.chatSaveImage, (_e, data: Uint8Array, mime: string) =>
    saveChatImage(chatImagesDir(), data, mime)
  )
  ipcMain.handle(CH.chatSend, (_e, req: ChatRequest) => {
    // the agent is renderer input like the rest: a CLI Cockpit runs, or an agent it
    // otherwise only reads once an ACP agent answers for it
    if (!isSessionProvider(req.provider)) throw new Error('unknown agent')
    if (!isDrivable(req.provider)) {
      if (!s.acpAgentFor(req.provider) && !req.options?.acpAgent) throw new Error(noAcpAgent(req.provider))
      // an account's config home, a Copilot user and a custom model provider are all a
      // headless CLI's knobs — none of them reaches an agent Cockpit drives over ACP
      const { model: _model, modelEndpoint: _endpoint, ...options } = req.options ?? {}
      req = { ...req, configDir: undefined, copilotUser: undefined, options }
    }
    // pasted-image paths are renderer input — only accept files chat:save-image wrote;
    // a seat's research allowance is the roundtable manager's alone to give, and a copy
    // that saves nothing is side chat's (a chat turn is the session, and is kept)
    {
      const { images: rawImages, research: _research, sideFork: _sideFork, ...rest } = req
      const images = assertChatImages(chatImagesDir(), rawImages)
      req = images ? { ...rest, images } : rest
    }
    // the working directory and config home are renderer input too — both must
    // come from app-derived state before a provider CLI is spawned against them
    req = {
      ...req,
      cwd: assertKnownCwd(indexer, req.cwd),
      configDir:
        req.configDir === undefined || !isDrivable(req.provider)
          ? undefined
          : assertKnownConfigDir(req.configDir, req.provider)
    }
    // a resumed BYOK session keeps the endpoint it was started with
    if (req.resumeNativeId && !req.options?.modelEndpoint) {
      const inherited = sessionEndpointFor(`${req.provider}:${req.resumeNativeId}`)
      if (inherited) req = { ...req, options: { ...req.options, modelEndpoint: inherited } }
    }
    // the handoff source is renderer input — only accept sessions the index knows
    if (req.handoffFrom !== undefined) {
      const src = String(req.handoffFrom)
      const source = src.length > 256 ? null : indexer.getSession(src)
      if (!source) throw new Error(`unknown handoff source: ${src.slice(0, 80)}`)
      // a seat-session is a table's internal, not a conversation of the user's —
      // handing off from one would seed a writable session with relay scaffolding
      if (source.cwd && tables.tableIdForCwd(source.cwd)) {
        throw new Error('Roundtable seat sessions cannot be handed off — start from the table.')
      }
      req = { ...req, handoffFrom: src }
    }
    // roundtable rooms are driven only by their table's round loop — a seat-session
    // opened from the debug list is read-only for now
    if (tables.tableIdForCwd(req.cwd)) {
      throw new Error('This session belongs to a roundtable — talk to it at the table instead.')
    }
    // a session with its agent is the person's to take over first — sending from here
    // would resume it under whatever still drives it, without anyone having said so
    const resumed = req.resumeNativeId ? `${req.provider}:${req.resumeNativeId}` : null
    const recorded = resumed ? sessionControlFor(resumed) : undefined
    if (resumed) {
      const holder = indexer.getSession(resumed)?.control?.holder ?? (recorded && holderOf(recorded.how))
      if (holder === 'agent') {
        throw new Error(`This session is with ${AGENT_NAME[req.provider]} — take it over to send from Cockpit.`)
      }
    }
    // a session already mid-turn gets no second CLI — refused before anything below
    // switches the active Copilot user for a turn that will never run
    chat.assertNotRunning(req)
    activateCopilotUser(req)
    const turnId = chat.send(req)
    s.ledger.started(turnId, req, { resumed, recorded })
    return turnId
  })
  ipcMain.handle(CH.chatCancel, (_e, turnId: string) => chat.cancel(turnId))
  ipcMain.handle(
    CH.chatRespondPermission,
    (_e, turnId: string, requestId: string, optionId: string) =>
      // ids come back from an event Cockpit itself emitted; the turn validates them
      // against what it actually asked, so a stale or invented answer is dropped
      chat.respondPermission(String(turnId), String(requestId), String(optionId))
  )
  ipcMain.handle(CH.chatPendingPermissions, (_e, turnId: string) => chat.pendingPermissions(String(turnId)))

  // side chat: questions asked of a throwaway copy of a session, on a ChatManager of its own
  ipcMain.handle(CH.sideChatAsk, (_e, raw: SideChatRequest) => {
    let req = sideTurnRequest(raw)
    // the directory and config home are renderer input, checked as chat:send checks them
    req = {
      ...req,
      cwd: assertKnownCwd(indexer, req.cwd),
      configDir: req.configDir === undefined ? undefined : assertKnownConfigDir(req.configDir, req.provider)
    }
    if (tables.tableIdForCwd(req.cwd)) {
      throw new Error('A roundtable seat session has no side chat — ask at the table.')
    }
    // the copy runs on the backend its session was started on
    if (req.resumeNativeId && !req.options?.modelEndpoint) {
      const inherited = sessionEndpointFor(`${req.provider}:${req.resumeNativeId}`)
      if (inherited) req = { ...req, options: { ...req.options, modelEndpoint: inherited } }
    }
    return s.sideChat.send(req)
  })
  ipcMain.handle(CH.sideChatCancel, (_e, turnId: string) => s.sideChat.cancel(String(turnId)))
}
