import { shell } from 'electron'
import { join } from 'node:path'
import { writeTerminalScript } from '../agent-cli'
import { terminalScript, withCliEnvironment } from '../agent-cli-core'
import { userDataDir } from '../config'
import { cliEnv } from '../env'
import { runsHomebrew } from '../../shared/agent-cli'

/*
 * Sign-in, CLI updates and resuming a released session all run in Terminal, where the
 * person can answer a browser, a device code or a password prompt. Each script is built
 * from fixed commands (agent-cli-core, session-control-core) and written under Cockpit's
 * own userData. They carry Cockpit's command search path, including desktop-owned
 * tools a plain Terminal login shell cannot find.
 */

function terminalDir(): string {
  return join(userDataDir(), 'terminal')
}

/** Write a finished script as `<name>.command` and open it in Terminal. */
export async function openScript(name: string, script: string): Promise<void> {
  const file = writeTerminalScript(terminalDir(), name, withCliEnvironment(script, cliEnv()))
  const failure = await shell.openPath(file)
  if (failure) throw new Error(`Couldn't open Terminal: ${failure}`)
}

/**
 * One command line under a title. Homebrew refuses a second run while one is going, so
 * every Homebrew script takes turns on one lock — updating Claude Code and Codex back to
 * back just queues.
 */
export function openInTerminal(name: string, title: string, line: string): Promise<void> {
  const homebrewQueue = join(terminalDir(), 'homebrew.lock')
  return openScript(name, terminalScript(title, line, runsHomebrew(line) ? { homebrewQueue } : {}))
}
