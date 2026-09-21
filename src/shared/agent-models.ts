import type { AgentModel, Provider } from './types'

/**
 * The models each agent CLI accepts that no file on disk lists. Claude's CLI documents
 * its aliases (`claude --help`: an alias for the latest model, or a full name) and keeps
 * no catalog; Copilot documents `auto`. Codex needs nothing here — it caches its own
 * catalog, which main reads (`agent-models.ts`). Found models are merged after these.
 */
export const BUILTIN_MODELS: Record<Provider, readonly AgentModel[]> = {
  claude: [
    { id: 'fable', label: 'fable', description: 'latest Fable' },
    { id: 'opus', label: 'opus', description: 'latest Opus' },
    { id: 'sonnet', label: 'sonnet', description: 'latest Sonnet' },
    { id: 'haiku', label: 'haiku', description: 'latest Haiku' },
    { id: 'claude-fable-5-1', label: 'claude-fable-5-1' },
    { id: 'claude-opus-5', label: 'claude-opus-5' },
    { id: 'claude-sonnet-5', label: 'claude-sonnet-5' },
    { id: 'claude-haiku-4-5-20251001', label: 'claude-haiku-4-5-20251001' }
  ],
  codex: [],
  copilot: [{ id: 'auto', label: 'auto', description: 'Copilot picks the model' }]
}

/**
 * Thinking levels each CLI accepts, from its own `--help` (claude `--effort`, copilot
 * `--reasoning-effort`). Codex lists the levels per model in its catalog; this is the
 * set its config accepts at all, the fallback when a model's own list is unknown.
 */
export const EFFORT_LEVELS: Record<Provider, readonly string[]> = {
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  copilot: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
}

/** The levels a seat may pick: the model's own list when known, else the agent's. */
export function effortsFor(provider: Provider, model: AgentModel | undefined): readonly string[] {
  const own = model?.efforts?.filter((e) => EFFORT_LEVELS[provider].includes(e))
  return own && own.length > 0 ? own : EFFORT_LEVELS[provider]
}

/** Built-ins first, then what was found — each id once, the first description kept. */
export function mergeModels(
  first: readonly AgentModel[],
  then: readonly AgentModel[]
): AgentModel[] {
  const seen = new Set<string>()
  const out: AgentModel[] = []
  for (const m of [...first, ...then]) {
    if (seen.has(m.id)) continue
    seen.add(m.id)
    out.push(m)
  }
  return out
}
