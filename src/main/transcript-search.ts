import { open, type FileHandle } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import type {
  Provider,
  SessionMeta,
  TranscriptHit,
  TranscriptHitRole,
  TranscriptSearchQuery,
  TranscriptSearchResult,
  TranscriptSearchStop
} from '../shared/types'
import { contentToText, toMs } from './parsers/util'
import { legacyTimelineTexts } from './parsers/copilot'

/**
 * Cross-agent full-text search over transcript *contents* — "where did I discuss X",
 * the one question no single vendor can answer, because no vendor sees the other two.
 *
 * On demand, never from a shipped index: the candidate list is what the indexer would
 * page for the same scope (its paths are the trust boundary — nothing here takes a path
 * from the renderer), every file is streamed in chunks under a per-file byte cap, the
 * loop yields to the event loop between files so IPC never stalls, and a newer query
 * cancels the one in flight. Hits are capped per session and in total, and a wall-clock
 * budget guarantees a search always returns — partial results say so.
 *
 * Only the conversation is searched, user and assistant text, unless the query opts
 * tool calls and results in: a `grep` over a repo would otherwise match every session
 * that ever read the file.
 */

export const DEFAULT_HIT_LIMIT = 50
export const MAX_HIT_LIMIT = 200
export const DEFAULT_PER_SESSION = 3
const MAX_PER_SESSION = 20
/** A transcript is read only this far — a 50MB log's head, never the whole thing. */
export const DEFAULT_MAX_BYTES_PER_FILE = 8 * 1024 * 1024
/** Partial results after this long: a search over 2,500 transcripts always ends. */
export const DEFAULT_TIME_BUDGET_MS = 15_000
const CHUNK_BYTES = 256 * 1024
const MIN_QUERY_LENGTH = 2
/** Snippet window around the match, in UTF-16 units of the whitespace-collapsed text */
const SNIPPET_BEFORE = 48
const SNIPPET_AFTER = 120

const PROVIDERS: readonly Provider[] = ['claude', 'codex', 'copilot']

/** One searchable piece of a transcript line: who said it, what, when. */
type TextRecord = {
  readonly role: TranscriptHitRole
  readonly text: string
  readonly ts: number | null
}

type RecordExtractor = (line: unknown, tools: boolean) => readonly TextRecord[]

/* Per-provider line readers. Failure-tolerant like the parsers: an unfamiliar shape
   yields nothing rather than throwing, since log formats drift between releases. */

const claudeRecords: RecordExtractor = (line, tools) => {
  const l = line as any
  if (l?.type !== 'user' && l?.type !== 'assistant') return []
  const ts = toMs(l.timestamp)
  const content = l.message?.content
  const out: TextRecord[] = []
  const text = contentToText(content)
  if (text) out.push({ role: l.type, text, ts })
  if (tools && Array.isArray(content)) {
    for (const b of content) {
      if (b?.type === 'tool_use') {
        out.push({ role: 'tool', text: `${b.name ?? 'tool'} ${JSON.stringify(b.input ?? {})}`, ts })
      } else if (b?.type === 'tool_result') {
        const t = contentToText(b.content)
        if (t) out.push({ role: 'tool', text: t, ts })
      }
    }
  }
  return out
}

const codexRecords: RecordExtractor = (line, tools) => {
  const l = line as any
  const ts = toMs(l?.timestamp)
  const p = l?.payload ?? l
  if (l?.type === 'event_msg') {
    // echoes of the ResponseItem lines below — a duplicate collapses in the searcher
    if (p?.type === 'user_message' && typeof p.message === 'string')
      return [{ role: 'user', text: p.message, ts }]
    if (p?.type === 'agent_message' && typeof p.message === 'string')
      return [{ role: 'assistant', text: p.message, ts }]
    return []
  }
  if (l?.type === 'session_meta') return []
  switch (p?.type) {
    case 'message': {
      const text = contentToText(p.content)
      return text ? [{ role: p.role === 'user' ? 'user' : 'assistant', text, ts }] : []
    }
    case 'function_call': {
      if (!tools) return []
      const args = typeof p.arguments === 'string' ? p.arguments : JSON.stringify(p.arguments ?? '')
      return [{ role: 'tool', text: `${p.name ?? 'tool'} ${args}`, ts }]
    }
    case 'function_call_output': {
      if (!tools) return []
      const text = typeof p.output === 'string' ? p.output : JSON.stringify(p.output ?? '')
      return [{ role: 'tool', text, ts }]
    }
    default:
      return []
  }
}

const copilotRecords: RecordExtractor = (line, tools) => {
  const ev = line as any
  const ts = toMs(ev?.timestamp)
  if (ev?.type === 'user.message' || ev?.type === 'assistant.message') {
    const text =
      typeof ev.data?.content === 'string' ? ev.data.content : contentToText(ev.data?.content)
    return text ? [{ role: ev.type === 'user.message' ? 'user' : 'assistant', text, ts }] : []
  }
  if (!tools) return []
  if (ev?.type === 'tool.execution_start') {
    const args = ev.data?.arguments ?? ev.data?.input ?? ''
    const name = String(ev.data?.toolName ?? ev.data?.name ?? 'tool')
    return [{ role: 'tool', text: `${name} ${typeof args === 'string' ? args : JSON.stringify(args)}`, ts }]
  }
  if (ev?.type === 'tool.execution_complete') {
    const r = ev.data?.result ?? ev.data?.output
    const text = typeof r === 'string' ? r : typeof r?.content === 'string' ? r.content : ''
    return text ? [{ role: 'tool', text, ts }] : []
  }
  return []
}

const EXTRACTORS: Record<Provider, RecordExtractor> = {
  claude: claudeRecords,
  codex: codexRecords,
  copilot: copilotRecords
}

type ReadOutcome = { readonly truncated: boolean }

async function openQuietly(file: string): Promise<FileHandle | null> {
  try {
    return await open(file, 'r')
  } catch {
    return null
  }
}

function handleLine(raw: string, onLine: (line: unknown) => boolean): boolean {
  const t = raw.trim()
  if (!t) return true
  let obj: unknown
  try {
    obj = JSON.parse(t)
  } catch {
    return true
  }
  return onLine(obj)
}

/**
 * Stream a JSONL file in fixed chunks, at most `cap` bytes of it, handing each parsed
 * line to `onLine`; a false return stops the read. Malformed lines are skipped and a
 * line longer than a chunk is still assembled. Never throws — an unreadable file reads
 * as empty, the way every parser here treats one. `end` is where the file's content
 * stops counting (an earlier page of a thread); being cut there is not truncation.
 */
async function streamJsonl(
  file: string,
  limits: { readonly cap: number; readonly end?: number },
  onLine: (line: unknown) => boolean
): Promise<ReadOutcome> {
  const fh = await openQuietly(file)
  if (!fh) return { truncated: false }
  try {
    const size = Math.min((await fh.stat()).size, limits.end ?? Infinity)
    const truncated = size > limits.cap
    const stop = Math.min(size, limits.cap)
    // a multi-byte character split across two chunks must not become two U+FFFDs
    const decoder = new StringDecoder('utf8')
    const buf = Buffer.allocUnsafe(CHUNK_BYTES)
    let carry = ''
    let pos = 0
    while (pos < stop) {
      const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK_BYTES, stop - pos), pos)
      if (bytesRead === 0) break
      pos += bytesRead
      const lines = (carry + decoder.write(buf.subarray(0, bytesRead))).split('\n')
      carry = lines.pop() ?? ''
      for (const raw of lines) if (!handleLine(raw, onLine)) return { truncated }
    }
    // the last line lacks a newline only when the file ended there — a capped read
    // stops mid-line, and half a record is not a record
    if (!truncated) {
      const rest = carry + decoder.end()
      if (rest.trim()) handleLine(rest, onLine)
    }
    return { truncated }
  } catch {
    return { truncated: false }
  } finally {
    await fh.close().catch(() => {})
  }
}

/** A whole-document read under the same cap, for the legacy Copilot JSON layout. */
async function readCapped(file: string, cap: number): Promise<{ text: string; truncated: boolean }> {
  const fh = await openQuietly(file)
  if (!fh) return { text: '', truncated: false }
  try {
    const size = (await fh.stat()).size
    const n = Math.min(size, cap)
    const buf = Buffer.allocUnsafe(n)
    const { bytesRead } = await fh.read(buf, 0, n, 0)
    return { text: buf.toString('utf8', 0, bytesRead), truncated: size > cap }
  } catch {
    return { text: '', truncated: false }
  } finally {
    await fh.close().catch(() => {})
  }
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()

const isLowSurrogate = (s: string, i: number): boolean => /[\uDC00-\uDFFF]/.test(s[i] ?? '')
const isHighSurrogate = (s: string, i: number): boolean => /[\uD800-\uDBFF]/.test(s[i] ?? '')

/**
 * The first match of `needle` (already lowercased and whitespace-collapsed) in a
 * record, as a hit: a snippet windowed around it, the match position inside the
 * snippet so the UI can mark it, and never a cut surrogate pair at either edge.
 */
function matchRecord(r: TextRecord, needle: string, sessionId: string): TranscriptHit | null {
  const hay = collapse(r.text)
  const lower = hay.toLowerCase()
  const at = lower.indexOf(needle)
  if (at < 0) return null
  // lowercasing can change a string's length (İ → i̇), which would shift every index
  // after it — then the position is only approximate, and nothing gets marked
  const exact = lower.length === hay.length
  const from = Math.max(0, at - SNIPPET_BEFORE)
  const to = Math.min(hay.length, at + needle.length + SNIPPET_AFTER)
  const start = from > 0 && isLowSurrogate(hay, from) ? from - 1 : from
  const end = to < hay.length && isHighSurrogate(hay, to - 1) ? to + 1 : to
  const lead = start > 0 ? '…' : ''
  const tail = end < hay.length ? '…' : ''
  const matchStart = exact ? lead.length + (at - start) : -1
  return {
    sessionId,
    role: r.role,
    snippet: lead + hay.slice(start, end) + tail,
    matchStart,
    matchEnd: exact ? matchStart + needle.length : -1,
    timestamp: r.ts
  }
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback
  return Math.max(min, Math.min(max, n))
}

type NormalQuery = {
  readonly text: string
  readonly needle: string
  readonly repoKey?: string
  readonly providers?: readonly Provider[]
  readonly limit: number
  readonly perSession: number
  readonly tools: boolean
}

/** The query is renderer input — every field is re-derived, never trusted as typed. */
function normalizeQuery(raw: TranscriptSearchQuery): NormalQuery {
  const text = collapse(String(raw?.text ?? ''))
  const providers = Array.isArray(raw?.providers)
    ? raw.providers.filter((p): p is Provider => PROVIDERS.includes(p))
    : []
  return {
    text,
    needle: text.toLowerCase(),
    repoKey: typeof raw?.repoKey === 'string' && raw.repoKey ? raw.repoKey : undefined,
    providers: providers.length > 0 ? providers : undefined,
    limit: clampInt(raw?.limit, 1, MAX_HIT_LIMIT, DEFAULT_HIT_LIMIT),
    perSession: clampInt(raw?.perSession, 1, MAX_PER_SESSION, DEFAULT_PER_SESSION),
    tools: raw?.includeTools === true
  }
}

/** The slice of the indexer a search needs — tests hand in the real one over tmpdir fixtures. */
export type CandidateSource = {
  transcriptCandidates(scope: {
    readonly repoKey?: string
    readonly providers?: readonly Provider[]
  }): SessionMeta[]
  getSession(id: string): SessionMeta | null
}

export type SearcherOptions = {
  readonly maxBytesPerFile?: number
  readonly timeBudgetMs?: number
}

export class TranscriptSearcher {
  /** Bumped by every search and every cancel — an in-flight loop compares and bails. */
  private generation = 0
  private readonly maxBytes: number
  private readonly budgetMs: number

  constructor(
    private readonly source: CandidateSource,
    opts: SearcherOptions = {}
  ) {
    this.maxBytes = opts.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE
    this.budgetMs = opts.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS
  }

  /** Stop the in-flight search; it resolves with what it had, marked `cancelled`. */
  cancel(): void {
    this.generation++
  }

  async search(raw: TranscriptSearchQuery): Promise<TranscriptSearchResult> {
    const gen = ++this.generation
    const started = Date.now()
    const q = normalizeQuery(raw)
    const hits: TranscriptHit[] = []
    const sessions: SessionMeta[] = []
    let candidates: SessionMeta[] = []
    let scanned = 0
    let truncated = 0
    let stoppedBy: TranscriptSearchStop = 'complete'
    if (q.needle.length >= MIN_QUERY_LENGTH) {
      candidates = this.source.transcriptCandidates({ repoKey: q.repoKey, providers: q.providers })
      for (const meta of candidates) {
        if (gen !== this.generation) {
          stoppedBy = 'cancelled'
          break
        }
        if (Date.now() - started >= this.budgetMs) {
          stoppedBy = 'time'
          break
        }
        const found = await this.searchFile(meta, q, () => gen === this.generation)
        scanned++
        if (found.truncated) truncated++
        if (gen !== this.generation) {
          stoppedBy = 'cancelled'
          break
        }
        if (found.hits.length > 0) {
          sessions.push(this.source.getSession(meta.id) ?? meta)
          for (const h of found.hits) {
            hits.push(h)
            if (hits.length >= q.limit) break
          }
          if (hits.length >= q.limit) {
            stoppedBy = 'hit-cap'
            break
          }
        }
        // one file per turn of the event loop — IPC and the watcher stay responsive
        await new Promise<void>((r) => setImmediate(r))
      }
    }
    return {
      query: q.text,
      hits,
      sessions,
      candidates: candidates.length,
      scanned,
      truncated,
      stoppedBy,
      elapsedMs: Date.now() - started
    }
  }

  /** Every hit in one transcript, up to the per-session cap; `alive` false stops the read. */
  private async searchFile(
    meta: SessionMeta,
    q: NormalQuery,
    alive: () => boolean
  ): Promise<{ readonly hits: TranscriptHit[]; readonly truncated: boolean }> {
    const hits: TranscriptHit[] = []
    // Codex persists a turn twice (ResponseItem + event echo) — the same text twice
    // in one file is one hit
    const seen = new Set<string>()
    const take = (r: TextRecord): boolean => {
      const hit = matchRecord(r, q.needle, meta.id)
      if (!hit) return true
      const key = `${hit.role} ${hit.snippet}`
      if (seen.has(key)) return true
      seen.add(key)
      hits.push(hit)
      return hits.length < q.perSession
    }
    if (meta.provider === 'copilot' && !meta.sourcePath.endsWith('.jsonl')) {
      const { text, truncated } = await readCapped(meta.sourcePath, this.maxBytes)
      let doc: unknown = null
      try {
        doc = JSON.parse(text)
      } catch {
        /* a capped or corrupt document has no records */
      }
      if (doc && alive()) {
        for (const r of legacyTimelineTexts(doc)) {
          if (r.role === 'tool' && !q.tools) continue
          if (!take(r)) break
        }
      }
      return { hits, truncated }
    }
    const extract = EXTRACTORS[meta.provider]
    // a thread kept across several files is searched page by page, oldest first,
    // each earlier page only as far as the thread's history in it goes
    const pages = [...(meta.segments ?? []), { path: meta.sourcePath, endByte: undefined }]
    let truncated = false
    for (const page of pages) {
      const read = await streamJsonl(page.path, { cap: this.maxBytes, end: page.endByte }, (line) => {
        if (!alive()) return false
        for (const r of extract(line, q.tools)) if (!take(r)) return false
        return true
      })
      truncated ||= read.truncated
      if (!alive() || hits.length >= q.perSession) break
    }
    return { hits, truncated }
  }
}
