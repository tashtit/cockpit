/**
 * The environment an app under test is launched with: this process's, with the window
 * pinned to the background, plus the caller's own overrides.
 *
 * `COCKPIT_DEV_DISPLAY` is inherited on purpose: a developer who exports it wants every
 * window a run opens on that screen, not on the one they are working on. It no longer
 * changes what a spec observes — the override only narrows which display a saved
 * placement is judged against (see createWindow in src/main/index.ts), and the
 * placement specs place the window on the display it already opened on.
 *
 * `COCKPIT_DEV_BACKGROUND` is pinned on rather than inherited: an app under test never
 * fronts itself or takes focus from whoever is typing while it runs, and a spec that
 * depends on focus says so in its own overrides.
 */
const PINNED: Readonly<Record<string, string>> = { COCKPIT_DEV_BACKGROUND: '1' }

/**
 * Build the env for `electron.launch`. Overrides win over the inherited environment,
 * so a spec still names its own HOME, COCKPIT_USER_DATA or PATH as it always did.
 */
export function launchEnv(overrides: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  // CI linux runners restrict unprivileged user namespaces; no SUID helper either
  if (process.env['CI']) env['ELECTRON_DISABLE_SANDBOX'] = '1'
  return { ...env, ...PINNED, ...overrides }
}
