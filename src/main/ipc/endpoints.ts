import { ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { CH } from '../../shared/contract'
import { endpointUrlRefusal, sanitizeEndpoint } from '../../shared/endpoints'
import { BUILTIN_ACP_AGENTS, sanitizeAcpAgent } from '../../shared/acp'
import {
  addAcpAgent,
  addModelEndpoint,
  listAcpAgents,
  listModelEndpoints,
  removeAcpAgent,
  removeModelEndpoint,
  updateModelEndpoint
} from '../config'
import { deleteEndpointKey, getEndpointKey, setEndpointKey } from '../secrets'
import { fetchEndpointModels } from '../endpoint-models'
import { probeAcpAgent } from '../acp'
import type { Services } from '../services'

/** An API key as the renderer typed it — trimmed, and refused if it could not be one. */
function apiKeyOf(raw: unknown): string {
  const key = typeof raw === 'string' ? raw.trim() : ''
  if (key.length > 4096 || /[\r\n\0]/.test(key)) throw new Error('Invalid API key value.')
  return key
}

/** Custom model providers (BYOK) and ACP agents — what a turn can run on besides the CLIs' defaults. */
export function registerEndpointHandlers(s: Services): void {
  ipcMain.handle(CH.endpointsGet, () => listModelEndpoints())
  ipcMain.handle(CH.endpointsAdd, (_e, input: unknown) => {
    // the key never enters the endpoint definition — strip it, encrypt it separately
    const { apiKey, ...def } = (input ?? {}) as { apiKey?: unknown; baseUrl?: unknown }
    const urlRefusal = endpointUrlRefusal(typeof def.baseUrl === 'string' ? def.baseUrl : '')
    if (urlRefusal) throw new Error(urlRefusal)
    const ep = sanitizeEndpoint(def, randomUUID())
    if (!ep) {
      throw new Error('Invalid provider: a name, a type, an http(s) base URL, and well-formed headers are required.')
    }
    const key = apiKeyOf(apiKey)
    if (key) setEndpointKey(ep.id, key) // throws before anything is saved if the keychain is unavailable
    return addModelEndpoint(key ? { ...ep, hasKey: true } : ep)
  })
  ipcMain.handle(CH.endpointsRemove, (_e, id: string) => {
    deleteEndpointKey(String(id))
    return removeModelEndpoint(String(id))
  })
  ipcMain.handle(CH.endpointsSetKey, (_e, id: string, apiKey: string) => {
    const ep = listModelEndpoints().find((e) => e.id === String(id))
    if (!ep) throw new Error('Unknown model provider.')
    const key = apiKeyOf(String(apiKey))
    if (!key) throw new Error('Invalid API key value.')
    setEndpointKey(ep.id, key) // throws before anything is saved if the keychain is unavailable
    updateModelEndpoint({ ...ep, hasKey: true })
    return listModelEndpoints()
  })
  ipcMain.handle(CH.endpointsModels, (_e, id: string) => {
    const ep = listModelEndpoints().find((e) => e.id === String(id))
    if (!ep) throw new Error('Unknown model provider.')
    return fetchEndpointModels(ep, ep.hasKey ? getEndpointKey(ep.id) : undefined)
  })

  /* ACP agents: CLIs the user asked Cockpit to drive over the Agent Client Protocol */
  ipcMain.handle(CH.acpGet, () => [...BUILTIN_ACP_AGENTS, ...listAcpAgents()])
  // which agents a session can be started or continued with — asking re-probes a missing
  // built-in, and a recheck every built-in
  ipcMain.handle(CH.acpReadiness, (_e, opts: unknown) =>
    s.acpReadiness({ recheck: (opts as { recheck?: unknown } | undefined)?.recheck === true })
  )
  ipcMain.handle(CH.acpAdd, (_e, input: unknown) => {
    const agent = sanitizeAcpAgent(input, randomUUID())
    if (!agent) {
      throw new Error(
        'Invalid agent: a name and an executable name or absolute path are required, and environment variables that redirect what runs are refused.'
      )
    }
    if (listAcpAgents().length >= 32) throw new Error('That is as many custom agents as Cockpit stores.')
    const agents = [...BUILTIN_ACP_AGENTS, ...addAcpAgent(agent)]
    s.pushAcpReadiness()
    return agents
  })
  ipcMain.handle(CH.acpRemove, (_e, id: string) => {
    // a built-in is defined in code, not config — there is nothing to remove
    if (BUILTIN_ACP_AGENTS.some((a) => a.id === String(id))) {
      throw new Error('Built-in agents cannot be removed.')
    }
    const agents = [...BUILTIN_ACP_AGENTS, ...removeAcpAgent(String(id))]
    s.pushAcpReadiness()
    return agents
  })
  ipcMain.handle(CH.acpProbe, (_e, input: unknown) => {
    const agent = sanitizeAcpAgent(input, 'probe')
    if (!agent) return { ok: false, error: 'Fill in a name and a command first.' }
    // the probe runs in the user's home, never in a repository: a definition being
    // tested must not be handed a checkout to read before it is trusted enough to store
    return probeAcpAgent(agent, homedir())
  })
}
