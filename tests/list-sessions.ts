import type { SessionMeta } from '../src/shared/types'
import { listClaudeSessionFiles, parseClaudeMeta } from '../src/main/parsers/claude'
import { listCodexSessionFiles, parseCodexMeta } from '../src/main/parsers/codex'
import { listCopilotSessionFiles, parseCopilotMeta } from '../src/main/parsers/copilot'

/**
 * Every session one provider's parser finds under a source dir: its file walk, then its
 * meta parse, with nothing of the indexer's around them (no stat-cache, no thread
 * folding, no visibility rules). The app only ever goes through the indexer, so this
 * is a test's way to ask a parser alone.
 */

export function listClaudeSessions(sourceDir: string, sourceLabel: string): SessionMeta[] {
  return listClaudeSessionFiles(sourceDir).flatMap((file) => parseClaudeMeta(file, sourceLabel) ?? [])
}

export function listCodexSessions(sourceDir: string, sourceLabel: string): SessionMeta[] {
  return listCodexSessionFiles(sourceDir).flatMap((file) => parseCodexMeta(file, sourceLabel) ?? [])
}

/** An id can turn up in more than one of Copilot's layouts; the first file found for it wins. */
export function listCopilotSessions(sourceDir: string, sourceLabel: string): SessionMeta[] {
  const out: SessionMeta[] = []
  const seen = new Set<string>()
  for (const file of listCopilotSessionFiles(sourceDir)) {
    const meta = parseCopilotMeta(file, sourceLabel)
    if (meta && !seen.has(meta.id)) {
      seen.add(meta.id)
      out.push(meta)
    }
  }
  return out
}
