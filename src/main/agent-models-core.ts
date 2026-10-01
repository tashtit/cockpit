import type { AgentModel } from '../shared/types'
import { isValidModel } from '../shared/endpoints'
import { isRecord } from '../shared/guards'

/**
 * Reading what models an agent CLI offers, IO-free (what the tests target). Every
 * source is provider-internal and drifts between releases, so each reader skips what it
 * does not recognise and returns what it could read — never throws (`CopilotFrames`, the
 * one stream reader, throws only on a stream that is not the protocol at all).
 */

/** A thinking level as a source names it — anything else is not one */
const EFFORT = /^[a-z]{1,16}$/

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
    const efforts = Array.isArray(m.supported_reasoning_levels)
      ? (m.supported_reasoning_levels as Array<{ effort?: unknown }>)
          .map((l) => l?.effort)
          .filter((e): e is string => typeof e === 'string' && EFFORT.test(e))
      : []
    const tiers = Array.isArray(m.service_tiers) ? (m.service_tiers as Array<{ id?: unknown }>) : []
    out.push({
      id: m.slug,
      label: typeof m.display_name === 'string' && m.display_name ? m.display_name : m.slug,
      ...(typeof m.description === 'string' && m.description ? { description: m.description } : {}),
      ...(efforts.length > 0 ? { efforts } : {}),
      ...(typeof m.default_reasoning_level === 'string' && efforts.includes(m.default_reasoning_level)
        ? { defaultEffort: m.default_reasoning_level }
        : {}),
      ...(tiers.some((t) => t?.id === 'priority') ? { fast: true } : {}),
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

/**
 * The models Copilot's `models.list` says one account may pick, in Copilot's own order,
 * each with its own thinking levels. GitHub decides the list — the plan, and an
 * organization's policy — so it differs per signed-in login; one a policy disables is
 * left out. Null when the answer is not a model list, so the caller falls back.
 */
export function copilotAccountModels(result: unknown): AgentModel[] | null {
  const models = isRecord(result) ? result.models : undefined
  if (!Array.isArray(models)) return null
  const out: AgentModel[] = []
  for (const m of models) {
    if (!isRecord(m) || typeof m.id !== 'string' || !isValidModel(m.id)) continue
    if (isRecord(m.policy) && m.policy.state === 'disabled') continue
    const efforts = Array.isArray(m.supportedReasoningEfforts)
      ? m.supportedReasoningEfforts.filter((e): e is string => typeof e === 'string' && EFFORT.test(e))
      : []
    const name = typeof m.name === 'string' ? m.name.trim().slice(0, 64) : ''
    const category = typeof m.modelPickerCategory === 'string' ? m.modelPickerCategory : ''
    out.push({
      id: m.id,
      label: name || m.id,
      // Copilot's own grouping in its picker: powerful, versatile, lightweight
      ...(/^[a-z][a-z -]{0,23}$/.test(category) ? { description: category } : {}),
      ...(efforts.length > 0 ? { efforts } : {}),
      ...(typeof m.defaultReasoningEffort === 'string' && efforts.includes(m.defaultReasoningEffort)
        ? { defaultEffort: m.defaultReasoningEffort }
        : {})
    })
  }
  return out
}

/**
 * The selection id `account.getAllUsers` gives `login`: its stored sign-in (`user`, the
 * kind Cockpit switches between) first, else the same login signed in another way (gh's
 * token, an environment token). Only the login, the kind and the id are read — an entry
 * may carry a token, which is never looked at.
 */
export function copilotSelection(users: unknown, login: string): string | null {
  if (!Array.isArray(users)) return null
  const ids = users.flatMap((u: unknown) => {
    if (!isRecord(u) || !isRecord(u.authInfo) || u.authInfo.login !== login) return []
    return typeof u.selectionId === 'string' && u.selectionId
      ? [{ stored: u.authInfo.type === 'user', id: u.selectionId }]
      : []
  })
  return (ids.find((e) => e.stored) ?? ids[0])?.id ?? null
}

/** A JSON-RPC message the way Copilot's server reads one: LSP's `Content-Length` framing. */
export function copilotFrame(msg: unknown): string {
  const body = JSON.stringify(msg)
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`
}

/** The largest message read: a model list is tens of KB, so past this it is not one. */
export const MAX_COPILOT_FRAME = 4 * 1024 * 1024
/** A header block longer than this has no end coming */
const MAX_FRAME_HEADER = 1024

/**
 * Copilot's server output, split back into messages however the pipe chunks it. Throws
 * on a header with no length, or on a message past `MAX_COPILOT_FRAME` — a stream that
 * is not the protocol, which nothing later in it would make right. A body that is not
 * JSON is skipped.
 */
export class CopilotFrames {
  private buf = Buffer.alloc(0)

  push(chunk: Buffer): unknown[] {
    this.buf = Buffer.concat([this.buf, chunk])
    const out: unknown[] = []
    for (;;) {
      const end = this.buf.indexOf('\r\n\r\n')
      if (end < 0) {
        if (this.buf.length > MAX_FRAME_HEADER) throw new Error('not a Content-Length framed stream')
        return out
      }
      const len = /(?:^|\r\n)content-length: *(\d+) *(?:\r\n|$)/i.exec(this.buf.subarray(0, end).toString('latin1'))
      if (!len) throw new Error('a message without a Content-Length')
      const size = Number(len[1])
      if (size > MAX_COPILOT_FRAME) throw new Error(`a message of ${size} bytes`)
      const start = end + 4
      if (this.buf.length < start + size) return out
      const body = this.buf.subarray(start, start + size).toString('utf8')
      this.buf = this.buf.subarray(start + size)
      try {
        out.push(JSON.parse(body))
      } catch {
        /* not JSON — skipped, the next frame still reads */
      }
    }
  }
}

/** The fields a Copilot events log names the model in — a turn's, a switch's. */
const COPILOT_MODEL_FIELD = /"(?:model|currentModel|selectedModel|newModel|explicitModelOverride)":"([^"]{1,80})"/g

/**
 * Models a Copilot log shows the CLI serving — the fallback for when Copilot's server
 * can't say what an account may pick (`copilotAccountModels`): an older CLI, no network.
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
