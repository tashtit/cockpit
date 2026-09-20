/**
 * The environment an app under test is launched with: this process's, minus the
 * developer-shell variables that would quietly run a different app than CI runs,
 * plus the caller's own overrides.
 *
 * `COCKPIT_DEV_DISPLAY` is the one that bites. It is a dev affordance for opening the
 * window on a chosen display, and `devBounds` deliberately outranks the saved
 * placement (see createWindow in src/main/index.ts) — so with it exported the window
 * never restores where it was and never reopens full screen. A developer who has it
 * set runs a spec against behaviour the runner never sees, in either direction:
 * a placement assertion that passes here and fails on CI, or the reverse.
 * `COCKPIT_DEV_BACKGROUND` is the milder half of the same pair — it decides whether
 * the window fronts itself — and a spec that depends on focus should say so in its
 * own env rather than inherit an answer from whoever is running it.
 *
 * Both are read by `readDevWindowPrefs`, which is the boundary this list tracks: the
 * dev window prefs are a person's local choice, and a test states its own.
 */
const DEV_WINDOW_VARS: readonly string[] = ['COCKPIT_DEV_DISPLAY', 'COCKPIT_DEV_BACKGROUND']

/**
 * Build the env for `electron.launch`. Overrides win over the inherited environment,
 * so a spec still names its own HOME, COCKPIT_USER_DATA or PATH as it always did.
 */
export function launchEnv(overrides: Readonly<Record<string, string>> = {}): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !DEV_WINDOW_VARS.includes(key)) env[key] = value
  }
  // CI linux runners restrict unprivileged user namespaces; no SUID helper either
  if (process.env['CI']) env['ELECTRON_DISABLE_SANDBOX'] = '1'
  return { ...env, ...overrides }
}
