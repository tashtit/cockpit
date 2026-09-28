import { isBlockedAgentEnv } from './acp'
import { asRecord, isRecord } from './guards'
import { describeMcp } from './mcp-source'
import { clip } from './text'
import type { McpConfig, RegistryInput, RegistryServerKind } from './types'

/*
 * The MCP Registry: servers nobody on this machine runs yet, and what adding one writes.
 *
 * The registry (registry.modelcontextprotocol.io) is the open catalogue MCP servers are
 * published to. An entry says how its server runs — an npm or PyPI package the agent
 * launches, or a remote URL it connects to — and what it needs from the person (an API
 * key as an env var, say). This module turns an entry into the one definition Cockpit
 * would write, or into the reason it won't.
 *
 * Anyone can publish there, so an entry is untrusted input on its way into an agent's
 * config, and this is where it is held to that:
 *  - The command is always Cockpit's own — `npx -y <package>@<version>` or
 *    `uvx <package>==<version>` — never a runtime hint the entry names. Runner options
 *    (`runtimeArguments`) are refused rather than passed: `npx -c` runs a shell.
 *  - Package names and versions must look like package names and versions, so no entry
 *    can smuggle a flag in where the package goes.
 *  - Only what the publisher fixes, or a required argument's default, reaches the command
 *    line: an optional argument nobody filled in is left off. What the plan pins and fixes
 *    is shown on the row before anything is written (`RegistryServer.commandLine`).
 *  - Env names are real env names, and none of the ones that turn a launch into a
 *    loader for other code (`isBlockedAgentEnv`, the ACP agents' rule).
 *  - A remote server is https, fully spelled out (no `{placeholders}`), and needs no
 *    header to start — headers are a sign-in Cockpit has no place to keep yet.
 *
 * Pure, like the session parsers: the registry's shape drifts, so anything unreadable
 * is left out rather than failing the page. Nothing here does IO.
 */

export const MCP_REGISTRY = 'https://registry.modelcontextprotocol.io'

/** Servers per page — a list to read, not to scroll through. */
export const REGISTRY_PAGE_SIZE = 30

/** A description is a row's second line, never a paragraph. */
const MAX_DESCRIPTION = 400

/** One argument the server's own command line takes, after the package. */
type RegistryArgument = {
  readonly type: 'positional' | 'named'
  readonly name?: string
  /** the value the publisher fixes: passed as it is */
  readonly value?: string
  /** what the registry offers when nothing is given — passed only where the argument is required */
  readonly default?: string
  readonly required: boolean
  readonly hint?: string
}

type RegistryEnv = {
  readonly name: string
  readonly description: string
  readonly required: boolean
  readonly secret: boolean
  /** fixed by the publisher: written as it is, never asked for */
  readonly value?: string
  readonly default?: string
}

type RegistryPackage = {
  readonly registryType: string
  readonly identifier: string
  readonly version?: string
  readonly transport?: string
  readonly runtimeArguments: readonly RegistryArgument[]
  readonly packageArguments: readonly RegistryArgument[]
  readonly env: readonly RegistryEnv[]
}

type RegistryRemote = {
  readonly type: string
  readonly url: string
  /** headers it won't start without */
  readonly requiredHeaders: readonly string[]
}

/** A registry entry, read and normalised — the one shape the rest of this module takes. */
export type RegistryEntry = {
  readonly id: string
  readonly version: string
  readonly title?: string
  readonly description: string
  readonly repository?: string
  readonly website?: string
  readonly packages: readonly RegistryPackage[]
  readonly remotes: readonly RegistryRemote[]
}

/** How an entry would run here, or why it can't. */
export type RegistryPlan =
  | {
      readonly kind: RegistryServerKind
      /** the package, or the remote url */
      readonly what: string
      /** the package release the command pins, which need not be the entry's own version */
      readonly release?: string
      readonly inputs: readonly RegistryInput[]
      /** agents that can't run it, and why */
      readonly unsupported: Partial<Record<'codex', string>>
      /** the definition without the person's values */
      readonly base: McpConfig
    }
  | { readonly refusal: string }

/* ---------- urls ---------- */

export function registrySearchUrl(query: string, cursor?: string, base = MCP_REGISTRY): string {
  const params = new URLSearchParams({
    search: query,
    limit: String(REGISTRY_PAGE_SIZE),
    version: 'latest'
  })
  if (cursor) params.set('cursor', cursor)
  return `${base}/v0/servers?${params.toString()}`
}

/** One exact version of one server — what an add reads when the search is no longer cached. */
export function registryVersionUrl(id: string, version: string, base = MCP_REGISTRY): string {
  return `${base}/v0/servers/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}`
}

/* ---------- reading ---------- */

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** The registry spells its fields in camelCase now and snake_case before September 2025. */
function field(o: Record<string, unknown>, camel: string, snake: string): unknown {
  return o[camel] ?? o[snake]
}

function argumentOf(value: unknown): RegistryArgument | null {
  const o = asRecord(value)
  if (!o) return null
  const type = o['type'] === 'named' ? 'named' : o['type'] === 'positional' ? 'positional' : null
  if (!type) return null
  return {
    type,
    ...(text(o['name']) ? { name: text(o['name']) } : {}),
    ...(text(o['value']) !== undefined ? { value: text(o['value']) } : {}),
    ...(text(o['default']) !== undefined ? { default: text(o['default']) } : {}),
    required: field(o, 'isRequired', 'is_required') === true,
    ...(text(field(o, 'valueHint', 'value_hint')) ? { hint: text(field(o, 'valueHint', 'value_hint')) } : {})
  }
}

function envOf(value: unknown): RegistryEnv | null {
  const o = asRecord(value)
  const name = o ? text(o['name']) : undefined
  if (!o || !name) return null
  return {
    name,
    description: text(o['description']) ?? '',
    required: field(o, 'isRequired', 'is_required') === true,
    secret: field(o, 'isSecret', 'is_secret') === true,
    ...(text(o['value']) ? { value: text(o['value']) } : {}),
    ...(text(o['default']) ? { default: text(o['default']) } : {})
  }
}

function packageOf(value: unknown): RegistryPackage | null {
  const o = asRecord(value)
  if (!o) return null
  const registryType = text(field(o, 'registryType', 'registry_type'))
  const identifier = text(o['identifier']) ?? text(o['name'])
  if (!registryType || !identifier) return null
  const transport = asRecord(o['transport'])
  return {
    registryType,
    identifier,
    ...(text(o['version']) ? { version: text(o['version']) } : {}),
    ...(transport && text(transport['type']) ? { transport: text(transport['type']) } : {}),
    runtimeArguments: list(field(o, 'runtimeArguments', 'runtime_arguments'))
      .map(argumentOf)
      .filter((a): a is RegistryArgument => a !== null),
    packageArguments: list(field(o, 'packageArguments', 'package_arguments'))
      .map(argumentOf)
      .filter((a): a is RegistryArgument => a !== null),
    env: list(field(o, 'environmentVariables', 'environment_variables'))
      .map(envOf)
      .filter((e): e is RegistryEnv => e !== null)
  }
}

function remoteOf(value: unknown): RegistryRemote | null {
  const o = asRecord(value)
  const type = o ? text(o['type']) ?? text(o['transport_type']) : undefined
  const url = o ? text(o['url']) : undefined
  if (!o || !type || !url) return null
  return {
    type,
    url,
    requiredHeaders: list(o['headers'])
      .filter(isRecord)
      .filter((h) => field(h, 'isRequired', 'is_required') === true)
      .map((h) => text(h['name']))
      .filter((n): n is string => n !== undefined)
  }
}

/** The publisher's own title, which the registry keeps under its `_meta` bag. */
function metaTitle(server: Record<string, unknown>): string | undefined {
  const meta = asRecord(server['_meta'])
  const provided = meta ? asRecord(meta['io.modelcontextprotocol.registry/publisher-provided']) : null
  return provided ? text(provided['title']) : undefined
}

/**
 * One entry off a registry page, or the body of a single-version read. An entry the
 * registry marks deleted or deprecated is skipped: it is still listed for the clients
 * that pinned it, not offered to anyone new.
 */
export function parseRegistryEntry(raw: unknown): RegistryEntry | null {
  const wrapper = asRecord(raw)
  if (!wrapper) return null
  const server = asRecord(wrapper['server']) ?? wrapper
  const official = asRecord(asRecord(wrapper['_meta'])?.['io.modelcontextprotocol.registry/official'])
  const status = official ? text(official['status']) : undefined
  if (status !== undefined && status !== 'active') return null
  const id = text(server['name'])
  const version = text(server['version']) ?? text(asRecord(server['version_detail'])?.['version'])
  if (!id || !version) return null
  const description = text(server['description']) ?? ''
  const repository = text(asRecord(server['repository'])?.['url'])
  return {
    id,
    version,
    ...(text(server['title']) ?? metaTitle(server) ? { title: text(server['title']) ?? metaTitle(server) } : {}),
    description:
      clip(description, MAX_DESCRIPTION),
    ...(repository && /^https:\/\//.test(repository) ? { repository } : {}),
    ...(text(field(server, 'websiteUrl', 'website_url'))?.startsWith('https://')
      ? { website: text(field(server, 'websiteUrl', 'website_url')) }
      : {}),
    packages: list(server['packages'])
      .map(packageOf)
      .filter((p): p is RegistryPackage => p !== null),
    remotes: list(server['remotes'])
      .map(remoteOf)
      .filter((r): r is RegistryRemote => r !== null)
  }
}

/** A search page: its entries, and the cursor to the next one. */
export function parseRegistryPage(raw: unknown): { entries: RegistryEntry[]; next?: string } {
  const o = asRecord(raw)
  if (!o) return { entries: [] }
  const entries = list(o['servers'])
    .map(parseRegistryEntry)
    .filter((e): e is RegistryEntry => e !== null)
  const meta = asRecord(o['metadata'])
  const next = meta ? text(field(meta, 'nextCursor', 'next_cursor')) : undefined
  return { entries, ...(next ? { next } : {}) }
}

/* ---------- what it would run as ---------- */

/** What a person calls it: the publisher's title, else the last part of its name. */
export function registryTitle(entry: RegistryEntry): string {
  return entry.title ?? entry.id.split('/').pop() ?? entry.id
}

const NPM_NAME = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i
const PYPI_NAME = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/
/** A release as a registry names one: never a range, never something that starts like a flag. */
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const FLAG = /^-{1,2}[A-Za-z0-9][A-Za-z0-9._-]*$/
/** `{name}` — a value the person was meant to fill in, which Cockpit has no field for */
const PLACEHOLDER = /\{[^}]*\}/

/** `npx -y`: the one runner option entries declare that Cockpit's own command already passes. */
const NPX_YES = new Set(['-y', '--yes'])

/** The package's own command line, after the package — or why it can't be spelled out. */
function packageArgs(pkg: RegistryPackage): string[] | string {
  // a runner option reaches past the package (`npx -c` runs a shell), so only the one
  // Cockpit passes itself is let through — and then left out, being there already
  const runner = pkg.runtimeArguments.filter(
    (arg) => !(pkg.registryType === 'npm' && NPX_YES.has(arg.value ?? arg.name ?? ''))
  )
  if (runner.length > 0) {
    return 'it asks for options for its runner, which Cockpit doesn’t pass on'
  }
  const args: string[] = []
  for (const arg of pkg.packageArguments) {
    const label = arg.name ?? arg.hint ?? 'an argument'
    // an optional argument is left off, its default with it: there is no field to fill
    // it in, so passing the default would be the publisher deciding it unseen
    const given = arg.value ?? (arg.required ? arg.default : undefined)
    if (given !== undefined && PLACEHOLDER.test(given)) {
      return `it needs ${label} filled in on its command line`
    }
    if (arg.type === 'named') {
      if (!arg.name || !FLAG.test(arg.name)) return 'its command line names an option Cockpit can’t read'
      if (given === undefined) {
        if (arg.required) return `it needs ${label} on its command line`
        continue
      }
      args.push(arg.name, given)
      continue
    }
    if (given === undefined) {
      if (arg.required) return `it needs ${label} on its command line`
      continue
    }
    args.push(given)
  }
  return args
}

/** Its env: what is fixed, and what the person is asked for — or why it can't be set up. */
function packageEnv(pkg: RegistryPackage): { fixed: Record<string, string>; inputs: RegistryInput[] } | string {
  const fixed: Record<string, string> = {}
  const inputs: RegistryInput[] = []
  for (const env of pkg.env) {
    if (!ENV_NAME.test(env.name)) return `it sets an environment variable Cockpit can’t name (${env.name.slice(0, 40)})`
    if (isBlockedAgentEnv(env.name)) return `it sets ${env.name}, which Cockpit never writes into an agent`
    if (env.value !== undefined && !PLACEHOLDER.test(env.value)) {
      fixed[env.name] = env.value
      continue
    }
    inputs.push({
      name: env.name,
      description: env.description,
      required: env.required && env.default === undefined,
      secret: env.secret,
      ...(env.default !== undefined ? { default: env.default } : {})
    })
  }
  return { fixed, inputs }
}

function planPackage(pkg: RegistryPackage, version: string): RegistryPlan {
  const kind = pkg.registryType === 'npm' ? 'npm' : pkg.registryType === 'pypi' ? 'pypi' : null
  if (!kind) {
    return {
      refusal: `it runs from ${pkg.registryType === 'oci' ? 'a container image' : `a ${pkg.registryType} package`} — Cockpit adds npm, PyPI and remote servers`
    }
  }
  if (pkg.transport !== undefined && pkg.transport !== 'stdio') {
    return { refusal: 'it runs as a web server of its own, not one the agent launches' }
  }
  const release = pkg.version ?? version
  if (!(kind === 'npm' ? NPM_NAME : PYPI_NAME).test(pkg.identifier) || !VERSION.test(release)) {
    return { refusal: 'its package name or version isn’t one Cockpit can run' }
  }
  const args = packageArgs(pkg)
  if (typeof args === 'string') return { refusal: args }
  const env = packageEnv(pkg)
  if (typeof env === 'string') return { refusal: env }
  const base: McpConfig =
    kind === 'npm'
      ? { command: 'npx', args: ['-y', `${pkg.identifier}@${release}`, ...args] }
      : { command: 'uvx', args: [`${pkg.identifier}==${release}`, ...args] }
  return {
    kind,
    what: pkg.identifier,
    release,
    inputs: env.inputs,
    unsupported: {},
    base: Object.keys(env.fixed).length > 0 ? { ...base, env: env.fixed } : base
  }
}

function planRemote(remote: RegistryRemote): RegistryPlan {
  const type = remote.type === 'sse' ? 'sse' : remote.type === 'streamable-http' || remote.type === 'http' ? 'http' : null
  if (!type) return { refusal: `it is reached over ${remote.type}, which the agents don’t speak` }
  if (!remote.url.startsWith('https://') || PLACEHOLDER.test(remote.url) || remote.url.length > 2048) {
    return { refusal: 'its address isn’t a plain https URL' }
  }
  try {
    new URL(remote.url)
  } catch {
    return { refusal: 'its address isn’t a plain https URL' }
  }
  if (remote.requiredHeaders.length > 0) {
    return {
      refusal: `it needs the ${remote.requiredHeaders[0]} header to connect, which Cockpit can’t set up yet — add it in the agent’s own config`
    }
  }
  return {
    kind: 'remote',
    what: remote.url,
    inputs: [],
    // Codex writes a remote server as a bare url, which it reaches over streamable HTTP
    unsupported: type === 'sse' ? { codex: 'Codex reaches remote servers over streamable HTTP only' } : {},
    base: { url: remote.url, type }
  }
}

/**
 * How this entry would run here. A package the agent launches comes first — it is
 * pinned, so Cockpit can tell when it goes out of date — then a remote server. The
 * first way that works wins; when none does, the first reason is the one given.
 */
export function registryPlan(entry: RegistryEntry): RegistryPlan {
  const tries = [
    ...entry.packages.map((pkg) => planPackage(pkg, entry.version)),
    ...entry.remotes.map(planRemote)
  ]
  const works = tries.find((plan) => !('refusal' in plan))
  if (works) return works
  const first = tries[0]
  return first ?? { refusal: 'the registry lists no way to run it' }
}

/** Control characters would end a TOML string or a JSON value early — nothing typed needs one. */
const CONTROL = /[\u0000-\u001f\u007f]/

/**
 * The definition to write: the plan's base plus what the person typed. Refuses a
 * value for anything the entry didn't ask for — the only env an add can set is the
 * env the registry declared — and a required one left empty.
 */
export function registryConfig(entry: RegistryEntry, values: Readonly<Record<string, string>>): McpConfig {
  const plan = registryPlan(entry)
  if ('refusal' in plan) throw new Error(`Cockpit can’t add ${registryTitle(entry)}: ${plan.refusal}.`)
  const asked = new Map(plan.inputs.map((input) => [input.name, input]))
  for (const name of Object.keys(values)) {
    if (!asked.has(name)) throw new Error(`${registryTitle(entry)} doesn’t take ${name.slice(0, 64)}.`)
  }
  const env: Record<string, string> = { ...(plan.base.env ?? {}) }
  for (const input of plan.inputs) {
    const typed = (values[input.name] ?? '').trim()
    if (CONTROL.test(typed) || typed.length > 4096) throw new Error(`${input.name} can’t hold that value.`)
    const value = typed !== '' ? typed : input.default
    if (value !== undefined && value !== '') env[input.name] = value
    else if (input.required) throw new Error(`${registryTitle(entry)} needs ${input.name} before it can be added.`)
  }
  return Object.keys(env).length > 0 ? { ...plan.base, env } : plan.base
}

/**
 * The names it could be added under, first choice first: the last part of its registry
 * name, then that with its publisher in front (`playwright-mcp`, `microsoft-playwright-mcp`)
 * for when the first is already some other server's here.
 */
export function registryLocalNames(id: string): string[] {
  const clean = (s: string): string =>
    s
      .replace(/[^A-Za-z0-9_.-]+/g, '-')
      .replace(/^[.-]+/, '')
      .replace(/-+$/, '')
      .slice(0, 64)
  const [namespace = '', last = id] = id.includes('/') ? id.split('/') : ['', id]
  const owner = namespace.split('.').pop() ?? ''
  return [clean(last), clean(owner ? `${owner}-${last}` : last)].filter(
    (name, i, all) => name !== '' && all.indexOf(name) === i
  )
}

/** Does this definition already run what the registry entry would? The same package, or the same url. */
export function runsSame(config: McpConfig, kind: RegistryServerKind, what: string): boolean {
  if (kind === 'remote') {
    const trim = (u: string): string => u.replace(/\/+$/, '')
    return config.url !== undefined && trim(config.url) === trim(what)
  }
  const d = describeMcp(config)
  return d.kind === kind && d.what.toLowerCase() === what.toLowerCase()
}
