import { homedir } from 'node:os'

/** GUI apps on macOS get a minimal PATH; make sure common CLI install dirs are present. */
export function cliEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: [
      process.env.PATH ?? '',
      '/opt/homebrew/bin',
      '/usr/local/bin',
      `${homedir()}/.local/bin`,
      `${homedir()}/bin`
    ].join(':')
  }
}
