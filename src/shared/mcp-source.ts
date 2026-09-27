import type { McpConfig } from './types'

/*
 * What an MCP server *is*, read off the definition that launches it.
 *
 * A row used to say `npx -y @playwright/mcp@0.0.78`: the command line, which is what
 * the agent runs but not what the thing is. The three facts a person is actually
 * asking for are already in there — where the code comes from (a registry, a URL,
 * this machine), which package or host, and whether the version is pinned. The pin
 * is the interesting one: it is the only case where "is there a newer one" is a
 * question with an answer, because an unpinned runner fetches the latest anyway.
 *
 * Pure and total: anything this module can't read confidently stays `unknown` with
 * the command as its own label, rather than being guessed at. A wrong package name
 * on screen is worse than a command line.
 */

export type McpKind =
  /** reached over HTTP/SSE — nothing runs locally */
  | 'remote'
  | 'npm'
  | 'pypi'
  /** docker/podman — the image, not a registry package */
  | 'container'
  /** a program on this machine */
  | 'binary'
  /** neither a command nor a url: an entry nothing can launch */
  | 'unknown'

export type McpDescription = {
  readonly kind: McpKind
  /** the package, the host, or the command — whichever names the thing */
  readonly what: string
  /** the exact version the definition pins; absent when nothing is pinned */
  readonly version?: string
  /** a package spec with no exact pin — the runner resolves it at every launch */
  readonly floating?: true
  /** what the definition asked for when it isn't an exact version (`^1.2`, `beta`) */
  readonly range?: string
  /** how a remote server is reached */
  readonly transport?: string
  /** the runner in front of the package (`npx`, `pipx run`) */
  readonly runner?: string
}

/** The word the row wears. Lowercase except where the registry spells itself. */
export const MCP_KIND_TAG: Record<McpKind, string> = {
  remote: 'remote',
  npm: 'npm',
  pypi: 'PyPI',
  container: 'container',
  binary: 'local',
  unknown: 'local'
}

/** Registries Cockpit can ask for a latest version. */
export type Registry = 'npm' | 'pypi'

export function registryOf(d: McpDescription): Registry | null {
  return d.kind === 'npm' || d.kind === 'pypi' ? d.kind : null
}

/* ---------- runners ---------- */

/** `npx pkg` — the runner is the whole command. */
const NPM_RUNNERS = new Set(['npx', 'bunx', 'pnpx'])
/** `pnpm dlx pkg` — the runner is the command plus these leading words. */
const NPM_SUBCOMMANDS: Record<string, readonly string[]> = {
  npm: ['exec'],
  pnpm: ['dlx'],
  yarn: ['dlx'],
  bun: ['x']
}
const PYPI_RUNNERS = new Set(['uvx'])
const PYPI_SUBCOMMANDS: Record<string, readonly string[]> = {
  pipx: ['run'],
  uv: ['tool', 'run']
}
const CONTAINER_RUNNERS = new Set(['docker', 'podman'])

/** Flags that swallow the next argument, and whose value *is* the package. */
const PACKAGE_FLAGS = new Set(['-p', '--package', '--from'])

/** A command may be configured by absolute path — `npx` is still `npx`. */
function baseName(command: string): string {
  return command.split(/[\\/]/).pop() ?? command
}

/** Strip the runner's own leading subcommand words (`dlx`, `run`, `tool run`). */
function afterSubcommand(args: readonly string[], words: readonly string[]): string[] | null {
  for (const [i, word] of words.entries()) if (args[i] !== word) return null
  return args.slice(words.length)
}

type Found = {
  /** index in the original args array — what a version rewrite has to replace */
  readonly at: number
  readonly spec: string
  /**
   * What sits in front of the spec inside that same argument — `--from=` when the flag
   * and its value rode in one token, empty otherwise. A rewrite has to put it back:
   * `uvx --from=pkg cmd` and `uvx pkg cmd` run different programs.
   */
  readonly prefix: string
}

/**
 * The package spec among a runner's arguments: the first bare word, or the value of
 * a flag that names the package outright (`npx -p pkg cmd`, `uvx --from pkg cmd`).
 * Everything before it is the runner's own flags.
 */
function findSpec(args: readonly string[], offset: number): Found | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (PACKAGE_FLAGS.has(arg)) {
      return args[i + 1] === undefined
        ? null
        : { at: offset + i + 1, spec: args[i + 1], prefix: '' }
    }
    const eq = arg.indexOf('=')
    if (eq > 0 && PACKAGE_FLAGS.has(arg.slice(0, eq))) {
      return { at: offset + i, spec: arg.slice(eq + 1), prefix: arg.slice(0, eq + 1) }
    }
    if (arg.startsWith('-')) continue
    return { at: offset + i, spec: arg, prefix: '' }
  }
  return null
}

/* ---------- package specs ---------- */

/** An exact release: `1.2.3`, `0.0.78`, `1.2.3-rc.1`. Never a range or a dist-tag. */
const EXACT = /^\d+(\.\d+){1,2}([-+][0-9A-Za-z.-]+)?$/

/**
 * `@playwright/mcp@0.0.78` → `@playwright/mcp` + `0.0.78`; `analytics-mcp==1.2` is
 * the same thing in pip's spelling. A leading `@` is a scope, never a separator.
 */
export function splitSpec(spec: string): { name: string; version?: string; sep: string } {
  const pip = spec.match(/^(.+?)(===?|~=|>=|<=)(.+)$/)
  if (pip) return { name: pip[1], version: pip[3], sep: pip[2] }
  const at = spec.lastIndexOf('@')
  if (at <= 0) return { name: spec, sep: '@' }
  return { name: spec.slice(0, at), version: spec.slice(at + 1), sep: '@' }
}

export function isExactVersion(version: string): boolean {
  return EXACT.test(version)
}

/**
 * Newer? Compares release numbers left to right, and treats a pre-release as older
 * than the release it leads to (`1.2.3-rc.1` < `1.2.3`), which is all npm's `latest`
 * and PyPI's `version` ever hand back. Anything unparseable compares equal, so an
 * update is never *suggested* on a comparison this module couldn't make.
 */
export function isNewer(candidate: string, current: string): boolean {
  if (!isExactVersion(candidate) || !isExactVersion(current)) return false
  const parts = (v: string): { nums: number[]; pre: string } => {
    const [core, ...rest] = v.split(/[-+]/)
    return { nums: core.split('.').map(Number), pre: rest.join('-') }
  }
  const a = parts(candidate)
  const b = parts(current)
  for (let i = 0; i < Math.max(a.nums.length, b.nums.length); i++) {
    const diff = (a.nums[i] ?? 0) - (b.nums[i] ?? 0)
    if (diff !== 0) return diff > 0
  }
  if (a.pre === b.pre) return false
  // same numbers: a release beats its own pre-releases, and nothing else is decidable
  return a.pre === ''
}

/* ---------- the description ---------- */

/** Boolean flags a container runner takes before the image name. */
const CONTAINER_FLAGS = new Set(['-i', '-t', '-it', '-ti', '-d', '--rm', '--init', '--interactive'])

/**
 * The image in `docker run … image:tag`, but only when every token before it is a
 * flag this module knows takes no value. `-e KEY` and `-v a:b` would otherwise have
 * their value read as the image — and a confidently wrong name is the one outcome
 * worth avoiding. Unsure means the row keeps saying `docker`.
 */
function containerImage(args: readonly string[]): string | null {
  const rest = args[0] === 'run' ? args.slice(1) : null
  if (!rest) return null
  for (const arg of rest) {
    if (arg.startsWith('--') && arg.includes('=')) continue
    if (CONTAINER_FLAGS.has(arg)) continue
    if (arg.startsWith('-')) return null
    return arg
  }
  return null
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

/** The runner's arguments, with the registry it installs from — or null. */
function packageRunner(
  command: string,
  args: readonly string[]
): { registry: Registry; rest: string[]; offset: number; runner: string } | null {
  const name = baseName(command)
  if (NPM_RUNNERS.has(name)) return { registry: 'npm', rest: [...args], offset: 0, runner: name }
  if (PYPI_RUNNERS.has(name)) return { registry: 'pypi', rest: [...args], offset: 0, runner: name }
  for (const [registry, table] of [
    ['npm', NPM_SUBCOMMANDS],
    ['pypi', PYPI_SUBCOMMANDS]
  ] as const) {
    const words = table[name]
    if (!words) continue
    const rest = afterSubcommand(args, words)
    if (rest) return { registry, rest, offset: words.length, runner: [name, ...words].join(' ') }
  }
  return null
}

export function describeMcp(config: McpConfig): McpDescription {
  if (config.url) {
    return { kind: 'remote', what: hostOf(config.url), transport: config.type ?? 'http' }
  }
  if (!config.command) return { kind: 'unknown', what: '' }
  const args = config.args ?? []
  const command = baseName(config.command)
  if (CONTAINER_RUNNERS.has(command)) {
    // the image carries its own tag, which is not a release number: shown, never compared
    return { kind: 'container', what: containerImage(args) ?? command, runner: command }
  }
  const runner = packageRunner(config.command, args)
  const found = runner && findSpec(runner.rest, runner.offset)
  if (!runner || !found) {
    // `node scripts/db-mcp.js` is named by its script, not by node — one bare
    // argument, never the flags, which are the noise the label exists to drop
    const first = args.find((a) => !a.startsWith('-'))
    return { kind: 'binary', what: [command, first].filter(Boolean).join(' ') }
  }
  const { name, version } = splitSpec(found.spec)
  if (version && isExactVersion(version)) {
    return { kind: runner.registry, what: name, version, runner: runner.runner }
  }
  return {
    kind: runner.registry,
    what: name,
    floating: true,
    ...(version ? { range: version } : {}),
    runner: runner.runner
  }
}

/**
 * How the row says what this server is: where it comes from, what it is called, and
 * which version — the command line's three facts, in the order a person asks for
 * them. The launch line itself is still a click away, in the row's field table.
 */
export function mcpLabel(config: McpConfig): string {
  const d = describeMcp(config)
  if (d.kind === 'unknown') return 'nothing to launch — no command and no url'
  if (d.kind === 'remote') return `${d.transport} · ${d.what}`
  // an unpinned package and one asking for `@latest` do the same thing: resolve at
  // launch. Saying "latest" for both is the truth, and fits a row
  const version = d.version ?? (d.floating ? (d.range ?? 'latest') : '')
  return [MCP_KIND_TAG[d.kind], '·', d.what, version].filter(Boolean).join(' ')
}

/**
 * The same definition with the pinned package moved to `version`. Only the version
 * inside the spec token changes — the separator the definition already used, every
 * other argument and the command itself are left byte-identical, because this is a
 * version bump, not a rewrite of the line the user runs.
 *
 * A server that pins nothing is refused rather than pinned: it installs the latest
 * at every launch on purpose, and turning that into a pin would change what it does.
 */
export function withVersion(config: McpConfig, version: string): McpConfig {
  if (!isExactVersion(version)) throw new Error(`not a version: ${version}`)
  const args = config.args ?? []
  const runner = config.command ? packageRunner(config.command, args) : null
  const found = runner && findSpec(runner.rest, runner.offset)
  if (!runner || !found) throw new Error('this server is not launched from a package')
  const { name, version: had, sep } = splitSpec(found.spec)
  if (had === undefined) throw new Error(`${name} pins no version to change`)
  const next = [...args]
  // `found.prefix` is the flag the spec shares its argument with (`--from=`): dropping
  // it would turn "run this command from that package" into "run that package"
  next[found.at] = `${found.prefix}${name}${sep}${version}`
  return { ...config, args: next }
}
