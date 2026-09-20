import { createHash, randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type {
  BackupCounts,
  BackupExportResult,
  BackupPreview,
  RestoreSummary,
  SourceDir
} from '../shared/types'
import {
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  MIN_PASSPHRASE,
  aadFor,
  mergeSources,
  planRestore,
  safeSkillPath,
  sanitizeBundle,
  seal,
  splitSecrets,
  unseal,
  type Bundle,
  type ScopeRecord,
  type Secrets,
  type SkillFiles
} from './backup-core'
import {
  configFilePath,
  loadConfig,
  readConfigStrict,
  saveConfig,
  userDataDir,
  type AppConfig
} from './config'
import { adoptScope, hasSkillCopy, skillCopyDir, skillSource } from './library'
import { walkFiles } from './parsers/util'
import { isUnder } from './paths'

/*
 * The disk around backup-core: reading skills, writing the file, and putting a
 * restore into place with a snapshot behind it. Everything that belongs to the
 * app rather than to the data — the dialogs, the indexer, the keychain — is
 * injected by index.ts, which is what lets a test run the whole round trip.
 */

/** The keychain, injected — `safeStorage` has no runtime outside the packaged app. */
export type KeyStore = {
  readonly get: (id: string) => string | undefined
  readonly set: (id: string, key: string) => void
  readonly remove: (id: string) => void
}

export type ExportDeps = {
  readonly keys: KeyStore
  /** portable key for a repo root: the indexer's `gh:owner/repo`, else the path */
  readonly refFor: (repoRoot: string) => string
  readonly appVersion: string
}

export type RestoreDeps = {
  readonly keys: KeyStore
  /** portable ref → local root, for every repo the indexer knows */
  readonly knownRepos: () => ReadonlyMap<string, string>
  /** persist these sources and wait until the indexer has scanned them */
  readonly syncSources: (sources: readonly SourceDir[]) => Promise<void>
}

/* ---------- export ---------- */

const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_SKILL_BYTES = 10 * 1024 * 1024
const MAX_TOTAL_SKILL_BYTES = 64 * 1024 * 1024
const SKIP_DIRS = ['.git', 'node_modules']

type SkillRead = { readonly files: SkillFiles; readonly skipped: number; readonly bytes: number }

/** One skill folder as base64 files, bounded so a stray big file can't blow the budget. */
function readSkillFiles(dir: string, budget: number): SkillRead {
  const files: Record<string, { data: string; exec?: true }> = {}
  let skipped = 0
  let bytes = 0
  for (const path of walkFiles(dir, 6, { skip: SKIP_DIRS })) {
    const rel = safeSkillPath(relative(dir, path).split(sep).join('/'))
    if (rel === null) {
      skipped++
      continue
    }
    let stat: ReturnType<typeof statSync>
    try {
      stat = statSync(path)
    } catch {
      skipped++
      continue
    }
    if (stat.size > MAX_FILE_BYTES || bytes + stat.size > Math.min(MAX_SKILL_BYTES, budget)) {
      skipped++
      continue
    }
    try {
      files[rel] = {
        data: readFileSync(path).toString('base64'),
        ...((stat.mode & 0o100) !== 0 ? { exec: true as const } : {})
      }
      bytes += stat.size
    } catch {
      skipped++
    }
  }
  return { files, skipped, bytes }
}

function scopeRefs(cfg: AppConfig): string[] {
  return [
    ...new Set([
      ...Object.keys(cfg.library?.repos ?? {}),
      ...Object.keys(cfg.sharedInstructions?.repos ?? {})
    ])
  ]
}

function countsOf(bundle: Bundle): BackupCounts {
  return {
    scopes: bundle.scopes.length,
    entries: bundle.scopes.reduce((n, s) => n + s.library.length, 0),
    skills: bundle.scopes.reduce((n, s) => n + Object.keys(s.skills).length, 0),
    endpoints: bundle.endpoints.length,
    sessions: bundle.sessions.archived.length
  }
}

/** Gather everything worth keeping, with the secrets split out of the body. */
export function buildBundle(
  deps: ExportDeps,
  passphrase?: string
): { readonly bundle: Bundle; readonly result: Omit<BackupExportResult, 'path'> } {
  const cfg = loadConfig()
  const sealed = passphrase !== undefined && passphrase !== ''
  if (sealed && passphrase.length < MIN_PASSPHRASE) {
    throw new Error(`passphrase must be at least ${MIN_PASSPHRASE} characters`)
  }
  let budget = MAX_TOTAL_SKILL_BYTES
  let skippedFiles = 0

  const scopeFor = (root: string | null): ScopeRecord => {
    const entries = (root === null ? cfg.library?.global : cfg.library?.repos?.[root]) ?? []
    const instructions =
      root === null ? cfg.sharedInstructions?.global : cfg.sharedInstructions?.repos?.[root]
    const skills: Record<string, SkillFiles> = {}
    for (const entry of entries) {
      if (entry.kind !== 'skill') continue
      const src = skillSource(entry.name, root)
      if (src === null) continue
      const read = readSkillFiles(src, budget)
      skippedFiles += read.skipped
      budget -= read.bytes
      if (Object.keys(read.files).length > 0) skills[entry.name] = read.files
    }
    return {
      ref: root === null ? 'global' : deps.refFor(root),
      root,
      ...(instructions !== undefined && instructions.trim() !== '' ? { instructions } : {}),
      library: entries,
      skills
    }
  }

  const scopes = [scopeFor(null), ...scopeRefs(cfg).map((root) => scopeFor(root))]
  const endpoints = cfg.modelEndpoints ?? []
  let unreadableKeys = 0
  const split = splitSecrets(scopes, endpoints, {
    sealed,
    keyFor: (id) => {
      const key = deps.keys.get(id)
      // a key the keychain won't decrypt (another machine, a dev vs packaged build)
      // is counted, never quietly dropped: the user has to know to re-enter it
      if (key === undefined) unreadableKeys++
      return key
    }
  })

  const header = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    createdAt: new Date().toISOString(),
    appVersion: deps.appVersion
  } as const
  const bundle: Bundle = {
    ...header,
    home: homedir(),
    settings: {
      ...(cfg.historyDays !== undefined ? { historyDays: cfg.historyDays } : {}),
      ...(cfg.staleDays !== undefined ? { staleDays: cfg.staleDays } : {}),
      ...(cfg.timeFormat !== undefined ? { timeFormat: cfg.timeFormat } : {}),
      hiddenRepos: cfg.hiddenRepos ?? [],
      ...(cfg.repoOrder?.length ? { repoOrder: cfg.repoOrder } : {}),
      sources: cfg.sources
    },
    scopes: split.scopes,
    endpoints: split.endpoints,
    sessions: {
      archived: cfg.archived ?? [],
      sessionEndpoints: cfg.sessionEndpoints ?? {},
      continuedFrom: cfg.continuedFrom ?? {},
      removedEndpoints: cfg.removedEndpoints ?? {}
    },
    ...(sealed ? { secrets: seal(split.secrets, passphrase, aadFor(header)) } : {})
  }
  return {
    bundle,
    result: {
      counts: countsOf(bundle),
      secretsIncluded: sealed,
      withheld: split.withheld,
      unreadableKeys: sealed ? 0 : unreadableKeys,
      skippedFiles
    }
  }
}

export function writeBackup(path: string, deps: ExportDeps, passphrase?: string): BackupExportResult {
  const { bundle, result } = buildBundle(deps, passphrase)
  // write-then-rename with the mode set on the temp file: chmod on an existing
  // target would leave a window where the old inode still holds the new bytes
  const tmp = path + '.tmp'
  writeFileSync(tmp, JSON.stringify(bundle, null, 2), { mode: 0o600 })
  renameSync(tmp, path)
  return { path, ...result }
}

/* ---------- reading a file back ---------- */

const MAX_BUNDLE_BYTES = 100 * 1024 * 1024

export function readBackup(path: string): Bundle {
  const size = statSync(path).size
  if (size > MAX_BUNDLE_BYTES) {
    throw new Error(`that file is ${Math.round(size / 1e6)}MB — too big to be a Cockpit backup`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new Error('that file is not valid JSON')
  }
  return sanitizeBundle(parsed)
}

export function previewOf(bundle: Bundle, token: string, knownRepos: ReadonlyMap<string, string>): BackupPreview {
  const roots = new Set(knownRepos.values())
  const commands = new Set<string>()
  for (const scope of bundle.scopes) {
    for (const entry of scope.library) {
      if (entry.kind === 'mcp' && entry.config?.command) commands.add(entry.config.command)
    }
  }
  return {
    token,
    createdAt: bundle.createdAt,
    appVersion: bundle.appVersion,
    sealed: bundle.secrets !== undefined,
    counts: countsOf(bundle),
    unmatched: bundle.scopes
      .filter(
        (s) =>
          s.ref !== 'global' && !knownRepos.has(s.ref) && !(s.root !== null && roots.has(s.root))
      )
      .map((s) => s.ref),
    commands: [...commands]
  }
}

/* ---------- restore ---------- */

type UndoRecord = {
  readonly snapshot: string
  /** the config as this restore left it — a later write means undo is no longer safe */
  readonly configHash: string
  readonly keyIds: readonly string[]
  readonly skillDirs: readonly string[]
}

const undos = new Map<string, UndoRecord>()

function hashFile(path: string): string {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return ''
  }
}

function snapshotConfig(): string {
  const dir = join(userDataDir(), 'backups')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  // raw bytes, not a re-serialization: the config holds plaintext MCP env values
  // and a snapshot that "cleaned" anything would not be an undo
  if (existsSync(configFilePath())) copyFileSync(configFilePath(), path)
  else writeFileSync(path, JSON.stringify({ sources: [] }, null, 2), { mode: 0o600 })
  return path
}

function writeSkill(name: string, repoRoot: string | null, files: SkillFiles): string {
  const dir = skillCopyDir(name, repoRoot)
  for (const [rel, file] of Object.entries(files)) {
    const dest = resolve(dir, rel)
    // belt and braces: sanitizeBundle already rejected traversal, but this is the
    // line that actually writes, so it checks for itself
    if (dest === dir || !isUnder(dest, dir)) throw new Error(`unsafe path in skill "${name}"`)
    mkdirSync(dirname(dest), { recursive: true })
    writeFileSync(dest, Buffer.from(file.data, 'base64'), { mode: file.exec ? 0o755 : 0o644 })
  }
  return dir
}

/**
 * Put a backup into place. The config is snapshotted first, sources go in before
 * anything that needs the indexer to have seen a repo, and keys are written
 * before the config that references them — a key without its endpoint is
 * harmless, an endpoint that claims a key it doesn't have is not.
 */
export async function restoreBackup(
  bundle: Bundle,
  deps: RestoreDeps,
  passphrase?: string
): Promise<RestoreSummary> {
  if (bundle.secrets && (passphrase === undefined || passphrase === '')) {
    throw new Error('this backup is sealed — enter its passphrase to restore it')
  }
  const secrets: Secrets | null = bundle.secrets
    ? unseal(bundle.secrets, passphrase as string, aadFor(bundle))
    : null

  // refuses rather than building on defaults when the existing config is unreadable
  const before = readConfigStrict()
  const snapshot = snapshotConfig()
  const ctxBase = { home: homedir(), dirExists: (p: string) => existsSync(p) }

  const merged = mergeSources(before.sources, bundle, ctxBase)
  if (merged.sources.length !== before.sources.length) {
    saveConfig({ ...before, sources: merged.sources })
    await deps.syncSources(merged.sources)
  }

  const knownRepos = deps.knownRepos()
  adoptScope(null)
  for (const root of new Set(knownRepos.values())) adoptScope(root)

  const plan = planRestore(readConfigStrict(), bundle, {
    ...ctxBase,
    knownRepos,
    knownRoots: new Set(knownRepos.values()),
    hasSkill: hasSkillCopy,
    secrets
  })

  const keyIds: string[] = []
  const skillDirs: string[] = []
  try {
    for (const { id, key } of plan.keyWrites) {
      deps.keys.set(id, key)
      keyIds.push(id)
    }
    for (const write of plan.skillWrites) {
      skillDirs.push(writeSkill(write.name, write.repoRoot, write.files))
    }
  } catch (err) {
    // nothing has touched the config yet, so undoing the halves that did land
    // leaves the machine exactly as it was
    for (const id of keyIds) deps.keys.remove(id)
    for (const dir of skillDirs) rmSync(dir, { recursive: true, force: true })
    throw err
  }
  saveConfig(plan.config)

  const undoId = randomUUID()
  undos.set(undoId, { snapshot, configHash: hashFile(configFilePath()), keyIds, skillDirs })
  return { ...plan.summary, undoId }
}

/**
 * Put the config back as it was, provided nothing has written to it since — a
 * chat binding its endpoint mid-session would otherwise be thrown away with it.
 * The snapshot file stays either way, so there is always a manual way back.
 */
export function undoRestore(undoId: string, keys: KeyStore): void {
  const undo = undos.get(undoId)
  if (!undo) throw new Error('that restore can no longer be undone')
  if (hashFile(configFilePath()) !== undo.configHash) {
    throw new Error(`settings have changed since that restore — the snapshot is at ${undo.snapshot}`)
  }
  copyFileSync(undo.snapshot, configFilePath())
  for (const id of undo.keyIds) {
    try {
      keys.remove(id)
    } catch {
      /* a key that won't delete is not worth failing an undo over */
    }
  }
  for (const dir of undo.skillDirs) rmSync(dir, { recursive: true, force: true })
  undos.delete(undoId)
}
