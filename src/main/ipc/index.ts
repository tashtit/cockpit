import type { Services } from '../services'
import { registerAgentHandlers } from './agents'
import { registerAppHandlers } from './app'
import { registerBackupHandlers } from './backup'
import { registerChatHandlers } from './chat'
import { registerCleanupHandlers } from './cleanup'
import { registerEndpointHandlers } from './endpoints'
import { registerGithubHandlers } from './github'
import { registerLibraryHandlers } from './library'
import { registerRoundtableHandlers } from './roundtable'
import { registerSessionHandlers } from './sessions'

/**
 * Every `ipcMain.handle`, one module per domain — each channel in `CH` (shared/contract.ts)
 * is handled in exactly one of them (tests/ipc-channels.test.ts). A handler is thin: it
 * shapes renderer input through `guards.ts` and hands the work to a main module.
 */
export function registerIpc(services: Services): void {
  registerSessionHandlers(services)
  registerChatHandlers(services)
  registerRoundtableHandlers(services)
  registerGithubHandlers(services)
  registerLibraryHandlers(services)
  registerAgentHandlers(services)
  registerEndpointHandlers()
  registerBackupHandlers(services)
  registerCleanupHandlers(services)
  registerAppHandlers(services)
}
