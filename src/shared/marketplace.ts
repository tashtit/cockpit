import { asRecord } from './guards'
import { clip } from './text'
import type { CatalogPlugin } from './types'

/*
 * What a marketplace offers, read off its own catalogue file.
 *
 * Every agent installs plugins from the same kind of repository: a `marketplace.json`
 * naming the marketplace and listing its plugins. Cockpit reads that file rather than
 * asking a CLI, because the answer has to be the same for all three agents — and
 * because a person browsing wants to see what is *in* a marketplace before any agent
 * has it.
 *
 * Pure and tolerant, like the session parsers: a catalogue is someone else's file and
 * its shape drifts between releases, so anything unreadable is left out rather than
 * failing the whole listing. Nothing here does IO — `src/main/marketplace.ts` finds the
 * file (a clone on this machine) or fetches it (only when the person asks).
 */

/** Plugins kept per marketplace — a catalogue is a list to browse, not a database. */
export const MAX_CATALOG_PLUGINS = 300

/** A description is a row's second line, never a paragraph. */
const MAX_DESCRIPTION = 240

/** Where a catalogue lives inside its repository, newest spelling first. */
export const CATALOG_PATHS = ['.claude-plugin/marketplace.json', 'marketplace.json'] as const

/** `owner/repo`, one segment each side — what a GitHub URL reduces to. */
const OWNER_REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/

/**
 * The GitHub repository a marketplace source names, in the case GitHub itself spells
 * it — `https://github.com/tashtit/marketplace.git`, `git@github.com:tashtit/marketplace`,
 * or the `owner/repo` shorthand an agent may record instead. Anything else (a local
 * path, another host) is null: this is only ever used to build a raw URL, so a source
 * it can't read confidently must not become one.
 */
export function githubRepoOf(source: string | undefined): string | null {
  if (!source) return null
  const s = source.trim().replace(/\/+$/, '').replace(/\.git$/, '')
  const url = s.match(
    /^(?:https?:\/\/(?:www\.)?github\.com\/|(?:ssh:\/\/)?git@github\.com[:/])([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)$/i
  )
  const repo = url ? url[1] : OWNER_REPO.test(s) ? s : null
  // `./tmp` or `../x` is a path, not a repository; `-c/x` would read as a flag
  return repo !== null && repo.split('/').every((part) => !/^\.+$/.test(part) && !part.startsWith('-'))
    ? repo
    : null
}

/** Where the catalogue of `owner/repo` can be read, in the order to try them. */
export function catalogUrls(repo: string): readonly string[] {
  return CATALOG_PATHS.map((path) => `https://raw.githubusercontent.com/${repo}/HEAD/${path}`)
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** An author is a name, or `{name, email}` — the email is never shown. */
function authorOf(value: unknown): string | undefined {
  if (typeof value === 'string') return text(value)
  const o = asRecord(value)
  if (o) return text(o['name'])
  return undefined
}

function keywordsOf(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((k): k is string => typeof k === 'string').slice(0, 12)
    : []
}

/**
 * One catalogue entry. A marketplace may list a plugin as a bare string (the path it
 * lives at, its last segment naming it) or as a record; both arrive here.
 */
function pluginOf(value: unknown, marketplace: string): CatalogPlugin | null {
  if (typeof value === 'string') {
    const name = value.split('/').filter(Boolean).pop()
    return name ? { name, id: `${name}@${marketplace}`, description: '', keywords: [] } : null
  }
  const o = asRecord(value)
  if (!o) return null
  const name = text(o['name'])
  if (!name) return null
  const description = text(o['description']) ?? ''
  return {
    name,
    id: `${name}@${marketplace}`,
    description:
      clip(description, MAX_DESCRIPTION),
    ...(text(o['version']) ? { version: text(o['version']) } : {}),
    ...(authorOf(o['author']) ? { author: authorOf(o['author']) } : {}),
    ...(text(o['category']) ? { category: text(o['category']) } : {}),
    keywords: keywordsOf(o['keywords']),
    ...(text(o['homepage']) ? { homepage: text(o['homepage']) } : {})
  }
}

/**
 * A catalogue file's contents. `fallback` names the marketplace when the file doesn't
 * — an agent knows it by the name it was added under, and that is the half of every
 * plugin id an install is spelled with, so it wins over the file's own `name` only
 * when the file has none.
 */
export function parseCatalog(
  raw: unknown,
  fallback: string
): { readonly name: string; readonly plugins: readonly CatalogPlugin[] } | null {
  const o = asRecord(raw)
  if (!o) return null
  const list = o['plugins']
  if (!Array.isArray(list)) return null
  const name = text(o['name']) ?? fallback
  const plugins: CatalogPlugin[] = []
  for (const entry of list.slice(0, MAX_CATALOG_PLUGINS)) {
    const plugin = pluginOf(entry, name)
    if (plugin && !plugins.some((p) => p.name === plugin.name)) plugins.push(plugin)
  }
  return { name, plugins }
}

/** Does this plugin answer what was typed? Name, description, keywords and category. */
export function matchesCatalogQuery(plugin: CatalogPlugin, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  return [plugin.name, plugin.description, plugin.category ?? '', ...plugin.keywords]
    .join(' ')
    .toLowerCase()
    .includes(q)
}
