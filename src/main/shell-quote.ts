import type { Provider } from '../shared/types'
import { CONFIG_HOME_VAR } from '../shared/providers'

/**
 * Words for a POSIX shell, IO-free. The scripts Cockpit writes for Terminal and the
 * update swap, and the command lines it shows, all pass through here: a path or an id
 * reaches a shell as exactly one word whatever it holds.
 */

/** POSIX single-quoting: safe for any path, including spaces and quotes. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** One argument as a shell would have to be given it: bare when it can be, quoted otherwise. */
export function shellWord(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : shQuote(arg)
}

/** `line` run under one config home: the home rides in front as its CLI's variable, quoted. */
export function withConfigHome(provider: Provider, line: string, configDir?: string): string {
  return configDir === undefined ? line : `${CONFIG_HOME_VAR[provider]}=${shQuote(configDir)} ${line}`
}
