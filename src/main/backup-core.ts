import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import type {
  LibraryEntry,
  McpConfig,
  ModelEndpoint,
  PanelKind,
  Provider,
  RestoreSummary,
  SourceDir,
  TimeFormat
} from '../shared/types'
import { PROVIDERS, kindsForScope } from '../shared/library'
import { sanitizeEndpoint } from '../shared/endpoints'
import type { AppConfig } from './config'
import { SESSION_ENDPOINT_CAP, SESSION_LINEAGE_CAP, withEndpoint } from './config'
import { clampStaleDays } from './cleanup-core'

/*
 * The backup bundle and every rule about it that needs no disk: what a file may
 * contain (sanitizeBundle), how its secrets are sealed, and what restoring it
 * would do to the config (planRestore). backup.ts does the IO around this.
 */

export const BUNDLE_FORMAT = 'cockpit-backup'
export const BUNDLE_VERSION = 1

/** One file inside a skill folder. Base64 so binaries survive the round trip. */
export type SkillFile = {
  readonly data: string
  /** the owner-execute bit, so a script in a skill still runs after a restore */
  readonly exec?: true
}

export type SkillFiles = Record<string, SkillFile>

/**
 * One library scope. `ref` is portable (`global`, the indexer's `gh:owner/repo`
 * key, or a root path for repos that aren't on GitHub); `root` is the machine the
 * backup came from, so a same-machine restore lands on the very same checkout.
 */
export type ScopeRecord = {
  readonly ref: string
  readonly root: string | null
  readonly instructions?: string
  readonly library: readonly LibraryEntry[]
  readonly skills: Record<string, SkillFiles>
}

export type SealedSecrets = {
  readonly kdf: 'scrypt'
  readonly salt: string
  readonly iv: string
  readonly tag: string
  readonly data: string
}

/** Everything a passphrase-less backup leaves out, keyed to put it back. */
export type Secrets = {
  /** by scope index, then mcp entry name */
  readonly scopes: ReadonlyArray<Record<string, Pick<McpConfig, 'env' | 'args' | 'url'>>>
  readonly endpointHeaders: Record<string, Record<string, string>>
  readonly endpointKeys: Record<string, string>
}

export type Bundle = {
  readonly format: typeof BUNDLE_FORMAT
  readonly version: number
  readonly createdAt: string
  readonly appVersion: string
  /** the home directory the paths were written on, so they can be rewritten here */
  readonly home: string
  readonly settings: {
    readonly historyDays?: number
    readonly staleDays?: number
    readonly timeFormat?: TimeFormat
    readonly hiddenRepos: readonly string[]
    /** the sidebar's dragged project order; absent in files written before it existed */
    readonly repoOrder?: readonly string[]
    readonly sources: readonly SourceDir[]
  }
  readonly scopes: readonly ScopeRecord[]
  readonly endpoints: readonly ModelEndpoint[]
  readonly sessions: {
    readonly archived: readonly string[]
    readonly sessionEndpoints: Record<string, string>
    readonly continuedFrom: Record<string, string>
    readonly removedEndpoints: Record<string, string>
  }
  readonly secrets?: SealedSecrets
}

/* ---------- sealing ---------- */

/**
 * Fixed scrypt parameters: N=2^15 needs more than node's 32MiB default maxmem, and
 * reading the cost from the file itself would let a crafted backup ask for
 * gigabytes — so these are the only values written, and the only ones accepted.
 */
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const
export const MIN_PASSPHRASE = 8

function keyFrom(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, SCRYPT)
}

/** Binds the sealed block to this bundle's header, so it can't be moved into another. */
export function aadFor(header: Pick<Bundle, 'format' | 'version' | 'createdAt'>): Buffer {
  return Buffer.from(`${header.format}|${header.version}|${header.createdAt}`, 'utf8')
}

export function seal(secrets: Secrets, passphrase: string, aad: Buffer): SealedSecrets {
  if (passphrase.length < MIN_PASSPHRASE) {
    throw new Error(`passphrase must be at least ${MIN_PASSPHRASE} characters`)
  }
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', keyFrom(passphrase, salt), iv, { authTagLength: 16 })
  cipher.setAAD(aad)
  const data = Buffer.concat([cipher.update(JSON.stringify(secrets), 'utf8'), cipher.final()])
  return {
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  }
}

export function unseal(sealed: SealedSecrets, passphrase: string, aad: Buffer): Secrets {
  const salt = Buffer.from(sealed.salt, 'base64')
  const iv = Buffer.from(sealed.iv, 'base64')
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyFrom(passphrase, salt), iv, {
      authTagLength: 16
    })
    decipher.setAAD(aad)
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'))
    const out = Buffer.concat([
      decipher.update(Buffer.from(sealed.data, 'base64')),
      decipher.final()
    ])
    return sanitizeSecrets(JSON.parse(out.toString('utf8')))
  } catch {
    // one message for both cases on purpose: a wrong key and a flipped byte are
    // the same failure to GCM, and guessing between them would only mislead
    throw new Error('wrong passphrase or damaged backup')
  }
}

/* ---------- validation ---------- */

const NAME_RE = /^(?!\.+$)(?!-)[A-Za-z0-9_.@-]{1,80}$/
/** Any non-null root asks kindsForScope the same question: what a repo scope holds. */
const REPO_SCOPE = '/repo'
const PANEL_KINDS: readonly PanelKind[] = ['mcp', 'skill', 'plugin', 'marketplace', 'instructions']
const MAX_SKILL_FILES = 200
const MAX_ENTRIES_PER_SCOPE = 500
const MAX_SCOPES = 500
const MAX_MAP_KEYS = 5000

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function str(v: unknown, max = 500): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= max ? v : undefined
}

function strMap(v: unknown, maxKeys = MAX_MAP_KEYS): Record<string, string> {
  if (!isRecord(v)) return {}
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v).slice(0, maxKeys)) {
    const s = str(val, 4000)
    if (k.length <= 400 && s !== undefined) out[k] = s
  }
  return out
}

function strList(v: unknown, max = 5000): string[] {
  return Array.isArray(v) ? v.flatMap((x) => (str(x, 1000) !== undefined ? [x as string] : [])).slice(0, max) : []
}

function sanitizeMcpConfig(v: unknown): McpConfig | undefined {
  if (!isRecord(v)) return undefined
  const cfg: McpConfig = {
    ...(str(v['command'], 2000) !== undefined ? { command: v['command'] as string } : {}),
    ...(Array.isArray(v['args']) ? { args: strList(v['args'], 100) } : {}),
    ...(isRecord(v['env']) ? { env: strMap(v['env'], 100) } : {}),
    ...(str(v['url'], 2000) !== undefined ? { url: v['url'] as string } : {}),
    ...(str(v['type'], 50) !== undefined ? { type: v['type'] as string } : {})
  }
  return Object.keys(cfg).length > 0 ? cfg : undefined
}

function sanitizeEnabled(v: unknown): Partial<Record<Provider, boolean>> {
  const out: Partial<Record<Provider, boolean>> = {}
  if (!isRecord(v)) return out
  for (const p of PROVIDERS) if (typeof v[p] === 'boolean') out[p] = v[p] as boolean
  return out
}

/** A kept difference is a fingerprint per agent — a short string, never a config. */
function sanitizeKept(v: unknown): Partial<Record<Provider, string>> | undefined {
  if (!isRecord(v)) return undefined
  const out: Partial<Record<Provider, string>> = {}
  for (const p of PROVIDERS) {
    const s = str(v[p], 4000)
    if (s !== undefined) out[p] = s
  }
  return Object.keys(out).length > 0 ? out : undefined
}

function sanitizeEntry(v: unknown, repoScope: boolean): LibraryEntry | null {
  if (!isRecord(v)) return null
  const kind = PANEL_KINDS.find((k) => k === v['kind'])
  if (!kind) return null
  // plugins and marketplaces are global-only; getPanel hides them in a repo scope
  if (repoScope && !kindsForScope(REPO_SCOPE).includes(kind)) return null
  const name = str(v['name'], 80)
  if (name === undefined) return null
  // the instructions entry is named "Shared baseline" — spaces and all — and is the
  // one entry whose name is Cockpit's own rather than something a switch passes on
  if (kind !== 'instructions' && !NAME_RE.test(name)) return null
  const config = sanitizeMcpConfig(v['config'])
  const source = str(v['source'], 500)
  const withheld = strList(v['withheld'], 100)
  const kept = sanitizeKept(v['kept'])
  return {
    kind,
    name,
    enabled: sanitizeEnabled(v['enabled']),
    ...(kept ? { kept } : {}),
    ...(config ? { config } : {}),
    // a marketplace source becomes an argument to the agent CLI, so a leading dash
    // would be read as a flag rather than a value
    ...(source !== undefined && !source.startsWith('-') ? { source } : {}),
    ...(v['removed'] === true ? { removed: true as const } : {}),
    ...(withheld.length > 0 ? { withheld } : {})
  }
}

/** Skill paths are written to disk, so nothing may point outside its own folder. */
export function safeSkillPath(rel: unknown): string | null {
  if (typeof rel !== 'string' || rel === '' || rel.length > 400) return null
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.includes('\\')) return null
  const parts = rel.split('/')
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null
  return parts.join('/')
}

function sanitizeSkills(v: unknown): Record<string, SkillFiles> {
  if (!isRecord(v)) return {}
  const out: Record<string, SkillFiles> = {}
  for (const [name, files] of Object.entries(v)) {
    if (!NAME_RE.test(name) || !isRecord(files)) continue
    const kept: Record<string, SkillFile> = {}
    for (const [rel, file] of Object.entries(files).slice(0, MAX_SKILL_FILES)) {
      const path = safeSkillPath(rel)
      if (path === null || !isRecord(file) || typeof file['data'] !== 'string') continue
      kept[path] = { data: file['data'], ...(file['exec'] === true ? { exec: true as const } : {}) }
    }
    if (Object.keys(kept).length > 0) out[name] = kept
  }
  return out
}

function sanitizeSource(v: unknown): SourceDir | null {
  if (!isRecord(v)) return null
  const path = str(v['path'], 4000)
  // an unknown provider would crash the next scan, so it is dropped rather than kept
  const provider = PROVIDERS.find((p) => p === v['provider'])
  if (path === undefined || !provider) return null
  return { path, provider, label: str(v['label'], 200) ?? provider }
}

function sanitizeSecrets(v: unknown): Secrets {
  if (!isRecord(v)) throw new Error('damaged backup')
  const scopes = Array.isArray(v['scopes']) ? v['scopes'] : []
  return {
    scopes: scopes.slice(0, MAX_SCOPES).map((scope) => {
      const out: Record<string, Pick<McpConfig, 'env' | 'args' | 'url'>> = {}
      if (!isRecord(scope)) return out
      for (const [name, cfg] of Object.entries(scope).slice(0, MAX_ENTRIES_PER_SCOPE)) {
        const clean = sanitizeMcpConfig(cfg)
        if (clean) out[name] = { env: clean.env, args: clean.args, url: clean.url }
      }
      return out
    }),
    endpointHeaders: Object.fromEntries(
      Object.entries(isRecord(v['endpointHeaders']) ? v['endpointHeaders'] : {}).map(([id, h]) => [
        id,
        strMap(h, 16)
      ])
    ),
    endpointKeys: strMap(v['endpointKeys'], 200)
  }
}

/**
 * A backup file is untrusted input — it may have been edited, or handed over by
 * someone else — so everything that reaches the config, the agents' CLIs or the
 * disk is rebuilt here from values this function chose to keep.
 */
export function sanitizeBundle(input: unknown): Bundle {
  if (!isRecord(input)) throw new Error('not a Cockpit backup')
  if (input['format'] !== BUNDLE_FORMAT) throw new Error('not a Cockpit backup')
  if (input['version'] !== BUNDLE_VERSION) {
    throw new Error(`backup version ${String(input['version'])} — this Cockpit reads version ${BUNDLE_VERSION}`)
  }
  const settings = isRecord(input['settings']) ? input['settings'] : {}
  const sessions = isRecord(input['sessions']) ? input['sessions'] : {}
  const scopesIn = Array.isArray(input['scopes']) ? input['scopes'].slice(0, MAX_SCOPES) : []
  const scopes: ScopeRecord[] = []
  for (const s of scopesIn) {
    if (!isRecord(s)) continue
    const ref = str(s['ref'], 4000)
    if (ref === undefined) continue
    const repoScope = ref !== 'global'
    scopes.push({
      ref,
      root: str(s['root'], 4000) ?? null,
      ...(str(s['instructions'], 200_000) !== undefined
        ? { instructions: s['instructions'] as string }
        : {}),
      library: (Array.isArray(s['library']) ? s['library'] : [])
        .slice(0, MAX_ENTRIES_PER_SCOPE)
        .flatMap((e) => {
          const entry = sanitizeEntry(e, repoScope)
          return entry ? [entry] : []
        }),
      skills: sanitizeSkills(s['skills'])
    })
  }
  const secretsIn = input['secrets']
  let secrets: SealedSecrets | undefined
  if (isRecord(secretsIn)) {
    const fields = ['salt', 'iv', 'tag', 'data'] as const
    if (secretsIn['kdf'] !== 'scrypt' || fields.some((f) => typeof secretsIn[f] !== 'string')) {
      throw new Error('backup has a secrets block this Cockpit cannot read')
    }
    secrets = {
      kdf: 'scrypt',
      salt: secretsIn['salt'] as string,
      iv: secretsIn['iv'] as string,
      tag: secretsIn['tag'] as string,
      data: secretsIn['data'] as string
    }
  }
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    createdAt: str(input['createdAt'], 40) ?? '',
    appVersion: str(input['appVersion'], 40) ?? '',
    home: str(input['home'], 4000) ?? '',
    settings: {
      ...(typeof settings['historyDays'] === 'number'
        ? { historyDays: Math.max(0, Math.floor(settings['historyDays'])) }
        : {}),
      ...(typeof settings['staleDays'] === 'number'
        ? { staleDays: clampStaleDays(settings['staleDays']) }
        : {}),
      ...(settings['timeFormat'] === '12h' || settings['timeFormat'] === '24h'
        ? { timeFormat: settings['timeFormat'] as TimeFormat }
        : {}),
      hiddenRepos: strList(settings['hiddenRepos'], 2000),
      ...(Array.isArray(settings['repoOrder']) ? { repoOrder: strList(settings['repoOrder'], 2000) } : {}),
      sources: (Array.isArray(settings['sources']) ? settings['sources'] : [])
        .slice(0, 100)
        .flatMap((s) => {
          const source = sanitizeSource(s)
          return source ? [source] : []
        })
    },
    scopes,
    endpoints: (Array.isArray(input['endpoints']) ? input['endpoints'] : [])
      .slice(0, 100)
      .flatMap((e) => {
        const id = isRecord(e) ? str(e['id'], 100) : undefined
        const ep = sanitizeEndpoint(e, id ?? '')
        return ep && id ? [ep] : []
      }),
    sessions: {
      archived: strList(sessions['archived'], MAX_MAP_KEYS),
      sessionEndpoints: strMap(sessions['sessionEndpoints']),
      continuedFrom: strMap(sessions['continuedFrom']),
      removedEndpoints: strMap(sessions['removedEndpoints'])
    },
    ...(secrets ? { secrets } : {})
  }
}

/* ---------- splitting secrets out at export time ---------- */

export type SplitResult = {
  readonly scopes: readonly ScopeRecord[]
  readonly endpoints: readonly ModelEndpoint[]
  readonly secrets: Secrets
  /** what a passphrase-less file had to leave behind, for the summary */
  readonly withheld: readonly string[]
}

/**
 * Take the secret-bearing parts out of the body. Sealed, they ride in `secrets`
 * and come back intact; unsealed, MCP env values are dropped and the entry
 * records which names are missing, so a switch can refuse instead of writing a
 * server with blank credentials.
 */
export function splitSecrets(
  scopes: readonly ScopeRecord[],
  endpoints: readonly ModelEndpoint[],
  opts: { readonly sealed: boolean; readonly keyFor: (id: string) => string | undefined }
): SplitResult {
  const withheld: string[] = []
  const secretScopes: Array<Record<string, Pick<McpConfig, 'env' | 'args' | 'url'>>> = []
  const outScopes = scopes.map((scope) => {
    const mine: Record<string, Pick<McpConfig, 'env' | 'args' | 'url'>> = {}
    const library = scope.library.map((entry) => {
      if (entry.kind !== 'mcp' || !entry.config) return entry
      const { env, args, url, ...rest } = entry.config
      const envNames = Object.keys(env ?? {})
      if (opts.sealed) {
        if (env || args || url) mine[entry.name] = { env, args, url }
        return { ...entry, config: rest }
      }
      if (envNames.length === 0) return entry
      withheld.push(`${entry.name} (${envNames.join(', ')})`)
      return { ...entry, config: { ...rest, args, url }, withheld: envNames }
    })
    secretScopes.push(mine)
    return { ...scope, library }
  })

  const endpointHeaders: Record<string, Record<string, string>> = {}
  const endpointKeys: Record<string, string> = {}
  const outEndpoints = endpoints.map((ep) => {
    const { hasKey, headers, ...rest } = ep
    const key = opts.keyFor(ep.id)
    if (opts.sealed) {
      if (headers) endpointHeaders[ep.id] = { ...headers }
      if (key !== undefined) endpointKeys[ep.id] = key
      return rest
    }
    if (hasKey) withheld.push(`${ep.label} (API key)`)
    if (headers && Object.keys(headers).length > 0) {
      withheld.push(`${ep.label} (${Object.keys(headers).join(', ')})`)
    }
    return rest
  })

  return {
    scopes: outScopes,
    endpoints: outEndpoints,
    secrets: { scopes: secretScopes, endpointHeaders, endpointKeys },
    withheld
  }
}

/* ---------- restore ---------- */

export type RestoreContext = {
  /** every repo the indexer knows, as portable ref → local root */
  readonly knownRepos: ReadonlyMap<string, string>
  /** roots that exist here, so a bundle's own `root` can be preferred when it does */
  readonly knownRoots: ReadonlySet<string>
  readonly home: string
  /** does this machine already hold that skill (library copy or any agent's)? */
  readonly hasSkill: (name: string, repoRoot: string | null) => boolean
  readonly dirExists: (path: string) => boolean
  readonly secrets: Secrets | null
}

export type SkillWrite = {
  readonly name: string
  readonly repoRoot: string | null
  readonly files: SkillFiles
}

export type RestorePlan = {
  readonly config: AppConfig
  readonly skillWrites: readonly SkillWrite[]
  readonly keyWrites: ReadonlyArray<{ readonly id: string; readonly key: string }>
  readonly summary: RestoreSummary
}

/** Where a bundle scope lands here, or null when this machine doesn't have it. */
function localRoot(scope: ScopeRecord, ctx: RestoreContext): string | null | undefined {
  if (scope.ref === 'global') return null
  // the exact checkout it came from wins, so a same-machine restore never moves
  // a repo's data onto a different clone of the same GitHub repo
  if (scope.root !== null && ctx.knownRoots.has(scope.root)) return scope.root
  return ctx.knownRepos.get(scope.ref)
}

function capMap(map: Record<string, string>, cap: number): Record<string, string> {
  const entries = Object.entries(map)
  return Object.fromEntries(entries.slice(Math.max(0, entries.length - cap)))
}

function rewriteHome(path: string, from: string, to: string): string {
  if (from === '' || from === to) return path
  return path === from || path.startsWith(from + '/') ? to + path.slice(from.length) : path
}

const sameUrl = (a: string, b: string): boolean => a.replace(/\/+$/, '') === b.replace(/\/+$/, '')

/**
 * The sources a restore would end up with. Restore applies these before anything
 * else and waits for the rescan, because a repo the indexer has never seen can't
 * be matched to a scope — and then merges again through planRestore, where this
 * is a no-op.
 */
export function mergeSources(
  current: readonly SourceDir[],
  bundle: Bundle,
  ctx: Pick<RestoreContext, 'home' | 'dirExists'>
): { readonly sources: SourceDir[]; readonly skipped: readonly string[] } {
  const sources = [...current]
  const skipped: string[] = []
  for (const src of bundle.settings.sources) {
    const path = rewriteHome(src.path, bundle.home, ctx.home)
    if (sources.some((s) => s.path === path && s.provider === src.provider)) continue
    if (!ctx.dirExists(path)) {
      skipped.push(`source ${path} — not on this machine`)
      continue
    }
    sources.push({ ...src, path })
  }
  return { sources, skipped }
}

/**
 * What restoring this bundle would do, as a merge that never deletes: anything
 * already here stays as it is, because local state is what the agents actually
 * run. Re-running the same file later is therefore a no-op for what it already
 * restored, and picks up repos that have since appeared.
 */
export function planRestore(local: AppConfig, bundle: Bundle, ctx: RestoreContext): RestorePlan {
  let cfg = local
  const kept: string[] = []
  const skipped: string[] = []
  const needsValues: string[] = []
  const skillWrites: SkillWrite[] = []
  const keyWrites: Array<{ id: string; key: string }> = []
  let addedEntries = 0
  let addedInstructions = 0

  /* settings */
  const merged = mergeSources(cfg.sources, bundle, ctx)
  const sources = merged.sources
  skipped.push(...merged.skipped)
  const addedSources = sources.length - cfg.sources.length
  cfg = {
    ...cfg,
    sources,
    hiddenRepos: [...new Set([...(cfg.hiddenRepos ?? []), ...bundle.settings.hiddenRepos])],
    // an order is one arrangement, not a set — a local one is kept, a missing one adopted
    ...((cfg.repoOrder ?? []).length === 0 && (bundle.settings.repoOrder ?? []).length > 0
      ? { repoOrder: [...(bundle.settings.repoOrder ?? [])] }
      : {}),
    ...(bundle.settings.historyDays !== undefined ? { historyDays: bundle.settings.historyDays } : {}),
    ...(bundle.settings.staleDays !== undefined ? { staleDays: bundle.settings.staleDays } : {}),
    ...(bundle.settings.timeFormat !== undefined ? { timeFormat: bundle.settings.timeFormat } : {})
  }

  /* scopes: instructions, library entries, skills */
  bundle.scopes.forEach((scope, i) => {
    const root = localRoot(scope, ctx)
    if (root === undefined) {
      skipped.push(`${scope.ref} — not on this machine`)
      return
    }
    const label = scope.ref === 'global' ? 'global' : scope.ref

    if (scope.instructions !== undefined && scope.instructions.trim() !== '') {
      const shared = cfg.sharedInstructions ?? {}
      const mine = root === null ? shared.global : shared.repos?.[root]
      if ((mine ?? '').trim() === '') {
        cfg = {
          ...cfg,
          sharedInstructions:
            root === null
              ? { ...shared, global: scope.instructions }
              : { ...shared, repos: { ...shared.repos, [root]: scope.instructions } }
        }
        addedInstructions++
      } else if (mine !== scope.instructions) {
        kept.push(`instructions for ${label} — kept yours (the backup's differ)`)
      }
    }

    const existing = (root === null ? cfg.library?.global : cfg.library?.repos?.[root]) ?? []
    const added: LibraryEntry[] = []
    for (const entry of scope.library) {
      if (existing.some((e) => e.kind === entry.kind && e.name === entry.name)) continue
      const sealed = ctx.secrets?.scopes[i]?.[entry.name]
      const restored: LibraryEntry =
        entry.kind === 'mcp' && sealed
          ? { ...entry, config: { ...entry.config, ...sealed } }
          : entry
      added.push(restored)
      if (restored.withheld?.length) {
        needsValues.push(`${restored.name} in ${label} — ${restored.withheld.join(', ')}`)
      }
      const files = scope.skills[entry.name]
      if (entry.kind === 'skill' && files && !ctx.hasSkill(entry.name, root)) {
        skillWrites.push({ name: entry.name, repoRoot: root, files })
      }
    }
    if (added.length > 0) {
      addedEntries += added.length
      const lib = cfg.library ?? {}
      cfg = {
        ...cfg,
        library:
          root === null
            ? { ...lib, global: [...existing, ...added] }
            : { ...lib, repos: { ...lib.repos, [root]: [...existing, ...added] } }
      }
    }
  })

  /* endpoints — ids are remapped so session bindings follow them */
  const idMap = new Map<string, string>()
  let addedEndpoints = 0
  for (const ep of bundle.endpoints) {
    const current = cfg.modelEndpoints ?? []
    const match =
      current.find((e) => e.id === ep.id) ??
      current.find((e) => e.label === ep.label && sameUrl(e.baseUrl, ep.baseUrl))
    if (match) {
      idMap.set(ep.id, match.id)
      continue
    }
    // nothing local holds this id — ids are UUIDs, so keeping it is what lets a
    // same-machine restore put the session bindings back on their own provider
    const id = ep.id
    idMap.set(ep.id, id)
    const headers = ctx.secrets?.endpointHeaders[ep.id]
    const key = ctx.secrets?.endpointKeys[ep.id]
    if (key !== undefined) keyWrites.push({ id, key })
    else needsValues.push(`${ep.label} — API key`)
    cfg = withEndpoint(cfg, {
      ...ep,
      id,
      ...(headers ? { headers } : {}),
      ...(key !== undefined ? { hasKey: true } : {})
    })
    addedEndpoints++
  }

  /* session maps: local wins, then the existing recency caps apply */
  const bound = { ...remapBindings(bundle.sessions.sessionEndpoints, idMap), ...cfg.sessionEndpoints }
  cfg = {
    ...cfg,
    archived: [...new Set([...(cfg.archived ?? []), ...bundle.sessions.archived])],
    sessionEndpoints: capMap(bound, SESSION_ENDPOINT_CAP),
    continuedFrom: capMap(
      { ...bundle.sessions.continuedFrom, ...cfg.continuedFrom },
      SESSION_LINEAGE_CAP
    ),
    removedEndpoints: { ...bundle.sessions.removedEndpoints, ...cfg.removedEndpoints }
  }

  return {
    config: cfg,
    skillWrites,
    keyWrites,
    summary: {
      added: {
        entries: addedEntries,
        skills: skillWrites.length,
        endpoints: addedEndpoints,
        sources: addedSources,
        instructions: addedInstructions
      },
      kept,
      skipped,
      needsValues,
      undoId: null
    }
  }
}

/** A backup's session→endpoint bindings follow their endpoints' new ids. */
function remapBindings(
  map: Record<string, string>,
  idMap: ReadonlyMap<string, string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(map).flatMap(([sid, eid]) => {
      const mapped = idMap.get(eid)
      return mapped ? [[sid, mapped] as const] : []
    })
  )
}
