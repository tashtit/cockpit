/**
 * Keeping a Codex roundtable seat out of the person's secrets. A seat's sandbox reads the
 * whole disk and reaches the network — so a `curl` can check a claim against a registry
 * or an RDAP page — and its prompt carries what the other seats fetched from the web: text
 * written to steer it could have it post a key file anywhere. So its permission profile
 * also denies where secrets live (`deny` in Codex's filesystem profile): SSH, cloud and
 * cluster keys, git and package-registry credentials, the agents' own sign-ins and MCP
 * configs (which hold tokens inline), Cockpit's own config for the same reason, and the
 * repository's `.env` files — named at its root, since Codex takes no globs.
 *
 * An older Codex that does not know `deny` refuses the whole config, and a seat that cannot
 * start at all is worse than one that can read `~/.aws`. So whether this Codex accepts it is
 * asked once, in the background at launch: `codex sandbox` runs `true` under the very
 * profile a seat would get — no model, nothing saved. Until it has answered yes, and on a
 * Codex that says no, a seat keeps the profile it had before the fence.
 */
import { join } from 'node:path'
import { userDataDir } from './config'
import { execText } from './env'

const PROFILE = 'cockpit-roundtable-seat'

/** Where secrets live, as Codex takes a home-relative path. */
export const SEAT_SECRET_PATHS: readonly string[] = [
  '~/.ssh',
  '~/.gnupg',
  '~/.aws',
  '~/.azure',
  '~/.kube',
  '~/.docker',
  '~/.config/gcloud',
  '~/.config/gh',
  '~/.config/github-copilot',
  '~/.netrc',
  '~/.git-credentials',
  '~/.npmrc',
  '~/.pypirc',
  '~/.claude.json',
  '~/.claude/.credentials.json',
  '~/.codex/auth.json',
  '~/.codex/config.toml',
  '~/.copilot'
]

/** A repository's secrets by convention, at its root. */
const ENV_FILES = ['.env', '.env.local', '.env.development', '.env.development.local', '.env.production', '.env.production.local', '.env.test', '.env.test.local']

/** Every path a seat working in `cwd` is denied. */
export function seatDeniedPaths(cwd: string): string[] {
  return [...SEAT_SECRET_PATHS, userDataDir(), ...ENV_FILES.map((f) => join(cwd, f))]
}

/** A TOML basic string: the profile rides `-c`, which Codex parses as TOML. */
function tomlString(s: string): string {
  return `"${s.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}

/**
 * A read-only Codex seat's reach: its sandbox with the network on, and `denied` unreadable
 * in it. A permission profile is the one way to give a read-only sandbox the network
 * (`network_access` is workspace-write's alone). The profile beats a `sandbox_mode` set with
 * `-c`, which stays as the floor for a Codex that predates profiles; the `--sandbox` flag
 * would beat the profile. The filesystem is listed as well as extended, since a Codex whose
 * profiles predate `extends` (0.120's do) ignores it. Without the network a seat's lookups
 * ran only where the person's own Codex config had its auto-reviewer approve each one out of
 * the sandbox.
 */
export function codexSeatArgs(denied: readonly string[] = []): string[] {
  const deny = denied.map((p) => `, ${tomlString(p)} = "deny"`).join('')
  return [
    '-c',
    `permissions.${PROFILE}={ extends = ":read-only", filesystem = { ":root" = "read"${deny} }, network = { enabled = true } }`,
    '-c',
    `default_permissions="${PROFILE}"`
  ]
}

/** Whether this Codex was seen to take the fence: null until asked, then its answer. */
let accepted: boolean | null = null
let asking: Promise<boolean> | null = null

/**
 * Ask this Codex, once, whether it takes a profile that denies paths — by running `true`
 * under exactly the profile a seat gets. Any failure (no Codex, an older one, a sandbox this
 * platform lacks) is a no.
 */
export function probeSeatFence(): Promise<boolean> {
  asking ??= execText(
    'codex',
    ['sandbox', ...codexSeatArgs(seatDeniedPaths('/nonexistent-cockpit-probe')), '-P', PROFILE, '--', 'true'],
    { timeoutMs: 15_000 }
  ).then((r) => {
    accepted = r.ok
    return r.ok
  })
  return asking
}

/** The paths a seat in `cwd` is denied — none until this Codex has been seen to take them. */
export function seatFence(cwd: string): string[] {
  return accepted === true ? seatDeniedPaths(cwd) : []
}

/** For tests: forget the answer, as a fresh launch would. */
export function resetSeatFence(): void {
  accepted = null
  asking = null
}
