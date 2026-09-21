import type { AgentModel } from '../shared/types'
import { isValidModel } from '../shared/endpoints'

/**
 * Reading what models an agent CLI offers, IO-free (what the tests target). Every
 * source is provider-internal and drifts between releases, so each reader skips what it
 * does not recognise and returns what it could read — never throws.
 */

/**
 * Codex's own catalog, `<CODEX_HOME>/models_cache.json`: the list its picker shows is
 * the entries with `visibility: "list"` (the hidden ones are internal — review agents,
 * reserve tiers), in its own priority order.
 */
export function codexCatalog(raw: string): AgentModel[] {
  let j: unknown
  try {
    j = JSON.parse(raw)
  } catch {
    return []
  }
  const models = (j as { models?: unknown })?.models
  if (!Array.isArray(models)) return []
  const out: Array<AgentModel & { priority: number }> = []
  for (const m of models as Array<Record<string, unknown>>) {
    if (!m || typeof m.slug !== 'string' || !isValidModel(m.slug)) continue
    if (m.visibility !== undefined && m.visibility !== 'list') continue
    out.push({
      id: m.slug,
      label: typeof m.display_name === 'string' && m.display_name ? m.display_name : m.slug,
      ...(typeof m.description === 'string' && m.description ? { description: m.description } : {}),
      priority: typeof m.priority === 'number' ? m.priority : Number.MAX_SAFE_INTEGER
    })
  }
  return out
    .sort((a, b) => a.priority - b.priority)
    .map(({ priority: _priority, ...m }) => m)
}

/** The model Codex runs when none is passed — `model = "…"` in its config.toml. */
export function codexConfiguredModel(toml: string): string | null {
  const m = /^\s*model\s*=\s*"([^"]+)"/m.exec(toml)
  return m && isValidModel(m[1]) ? m[1] : null
}

/** The fields a Copilot events log names the model in — a turn's, a switch's. */
const COPILOT_MODEL_FIELD = /"(?:model|currentModel|selectedModel|newModel|explicitModelOverride)":"([^"]{1,80})"/g

/**
 * Models a Copilot log shows the CLI serving. Copilot keeps no catalog on disk and its
 * ACP session offers no model option, so what it has actually run is the evidence.
 *
 * A custom provider's session names its model `<provider-id>/<model>` where it is
 * chosen (`selectedModel`, `newModel`) but bare on every turn record — and `--model`
 * cannot run that bare name on Copilot's own backend. So any name this log also shows
 * behind a provider prefix is a custom provider's, and is skipped along with the
 * prefixed ids and the hashes some records carry.
 */
export function copilotModelsInLog(text: string): string[] {
  const ids = [...text.matchAll(COPILOT_MODEL_FIELD)].map((m) => m[1])
  const viaProvider = new Set(ids.filter((id) => id.includes('/')).map((id) => id.slice(id.lastIndexOf('/') + 1)))
  const found = new Set<string>()
  for (const id of ids) {
    if (id.includes('/') || viaProvider.has(id)) continue
    if (/^[0-9a-f]{32,}$/.test(id) || !isValidModel(id)) continue
    found.add(id)
  }
  return [...found]
}
