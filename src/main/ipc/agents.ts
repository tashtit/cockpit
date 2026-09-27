import { ipcMain } from 'electron'
import { join } from 'node:path'
import { CH } from '../../shared/contract'
import { AGENT_NAME } from '../../shared/providers'
import { homebrewUpdateCommand, runsHomebrew } from '../../shared/agent-cli'
import { loadConfig, userDataDir } from '../config'
import { getAccounts } from '../accounts'
import { signInState } from '../agent-auth'
import { cliStatus, listCliStatus } from '../agent-cli'
import { loginLine } from '../agent-cli-core'
import { listAgentModels } from '../agent-models'
import { getUsage } from '../usage'
import { getProfile } from '../profile'
import type { Services } from '../services'
import { asProvider, optionalConfigDir } from './guards'
import { openInTerminal } from './terminal'

/**
 * The agent CLIs themselves: who each is signed in as, whether it is installed and
 * current, its models, usage and the profile. The provider and config home are renderer
 * input — a known provider, and a home the indexer derived, since the CLI runs against it.
 */
export function registerAgentHandlers(s: Services): void {
  ipcMain.handle(CH.accountsGet, () => getAccounts(loadConfig().sources))
  ipcMain.handle(CH.accountsLogin, (_e, agent: unknown, configDir: unknown) => {
    const provider = asProvider(agent)
    const home = optionalConfigDir(configDir, provider)
    return openInTerminal(
      `sign-in-${provider}`,
      `Cockpit — sign in to ${AGENT_NAME[provider]}${home ? ` (${home})` : ''}`,
      loginLine(provider, home)
    )
  })
  ipcMain.handle(CH.accountsSignIn, (_e, agent: unknown, configDir: unknown) => {
    const provider = asProvider(agent)
    return signInState(provider, optionalConfigDir(configDir, provider))
  })
  ipcMain.handle(CH.accountsModels, (_e, agent: unknown, configDir: unknown) => {
    const provider = asProvider(agent)
    return listAgentModels(provider, optionalConfigDir(configDir, provider))
  })

  ipcMain.handle(CH.cliStatus, (_e, force: unknown) => listCliStatus({ force: force === true }))
  ipcMain.handle(CH.cliUpdate, async (_e, agent: unknown) => {
    const provider = asProvider(agent)
    // the command comes from main's own reading of how the CLI is installed, never
    // from the renderer
    const status = await cliStatus(provider)
    if (!status.installed || !status.updateCommand) {
      throw new Error(`${AGENT_NAME[provider]} isn't installed, so there is nothing to update.`)
    }
    return openInTerminal(`update-${provider}`, `Cockpit — update ${AGENT_NAME[provider]}`, status.updateCommand)
  })
  // several Homebrew CLIs in one run: one `brew update` and one window rather than a
  // window each taking turns. Which CLIs is renderer input, so each is re-read here and
  // only those main itself finds behind on Homebrew go in
  ipcMain.handle(CH.cliUpdateHomebrew, async (_e, agents: unknown) => {
    if (!Array.isArray(agents)) throw new Error('expected a list of agents')
    const providers = [...new Set(agents.map(asProvider))]
    const behind = (await Promise.all(providers.map((p) => cliStatus(p)))).filter(
      (st) => st.updateAvailable && st.updateCommand !== null && runsHomebrew(st.updateCommand)
    )
    const line = homebrewUpdateCommand(behind)
    if (line === null) throw new Error('None of these has a Homebrew update waiting any more.')
    return openInTerminal(
      'update-homebrew',
      `Cockpit — update ${behind.map((st) => AGENT_NAME[st.provider]).join(' and ')}`,
      line
    )
  })
  // Homebrew only knows the releases its last `brew update` fetched, so a row whose
  // channel is behind the release can refresh it — the update itself stays a separate,
  // deliberate step
  ipcMain.handle(CH.cliRefreshChannel, async (_e, agent: unknown) => {
    const provider = asProvider(agent)
    const status = await cliStatus(provider)
    if (status.install !== 'brew-cask' && status.install !== 'brew-formula') {
      throw new Error(
        `${AGENT_NAME[provider]} doesn't get its updates from Homebrew, so there is nothing to refresh.`
      )
    }
    return openInTerminal(
      `refresh-${provider}`,
      `Cockpit — refresh what Homebrew knows (for ${AGENT_NAME[provider]})`,
      'brew update'
    )
  })

  ipcMain.handle(CH.usageGet, () => getUsage(loadConfig().sources))
  ipcMain.handle(CH.profileGet, () =>
    getProfile(s.indexer.ownSessions(), {
      sources: loadConfig().sources,
      seats: s.indexer.roundtableSessions(),
      cacheFile: join(userDataDir(), 'profile-cache.json')
    })
  )
}
