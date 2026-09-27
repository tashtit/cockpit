import type { AgentOptions, ChatRequest, SideChatRequest, SideExchange } from '../shared/types'
import { SIDE_QUESTION_MAX, sideChatSupported } from '../shared/side-chat'
import { capText } from './parsers/util'

/**
 * Side chat: a question about a session, asked of a throwaway copy of it (`sideFork` in
 * `buildCommand`). The copy holds the session up to now — mid-turn included — and nothing
 * the side chat said, so what it asked and was told before rides in the prompt. IO-free:
 * index.ts validates the directories and runs the turn on a ChatManager of its own, whose
 * turns never reach the busy board, the attention desk or the chat's own stream.
 */

/** Earlier exchanges carried into the next question: the latest ones */
export const SIDE_HISTORY_MAX = 6
/** Each carried question and answer is cut to this many characters — the prompt is argv */
const CARRY_QUESTION = 1_000
const CARRY_ANSWER = 3_000

/** Said before every side question, so the copy answers instead of carrying on with the task. */
export const SIDE_FRAME =
  '[A side question from the person, asked in Cockpit while this session goes on. You are a ' +
  'throwaway copy of the conversation: nothing you say here reaches the session, and the task ' +
  'goes on without you. Answer the question from the conversation so far, briefly and directly. ' +
  "Don't continue the task and don't change any files — reading a file to answer is fine.]"

/** The prompt a side question is asked with: the frame, the side chat so far, the question. */
export function sidePrompt(question: string, history: readonly SideExchange[]): string {
  const earlier = history.slice(-SIDE_HISTORY_MAX)
  const parts = [SIDE_FRAME]
  if (earlier.length > 0) {
    parts.push(
      'Earlier in this side chat:\n\n' +
        earlier
          .map((e) => `Question: ${capText(e.question, CARRY_QUESTION)}\n\nYour answer: ${capText(e.answer, CARRY_ANSWER)}`)
          .join('\n\n---\n\n')
    )
  }
  parts.push(`Question: ${question}`)
  return parts.join('\n\n')
}

/** The exchanges a request carries, as main will use them: well-formed, the latest ones. */
function historyOf(raw: unknown): SideExchange[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter(
      (e): e is SideExchange =>
        typeof e === 'object' && e !== null && typeof e.question === 'string' && typeof e.answer === 'string'
    )
    .filter((e) => e.question.trim() && e.answer.trim())
    .slice(-SIDE_HISTORY_MAX)
    .map((e) => ({ question: e.question, answer: e.answer }))
}

/**
 * The session's own model and thinking level, and the provider it runs on — nothing that
 * would change what the copy may do (its sandbox, its transport). `buildCommand` checks the
 * model and level again, and the endpoint is resolved and preflighted like any turn's.
 */
function optionsOf(o: AgentOptions | undefined): AgentOptions | undefined {
  if (typeof o !== 'object' || o === null) return undefined
  const kept: AgentOptions = {
    ...(typeof o.model === 'string' ? { model: o.model } : {}),
    ...(typeof o.effort === 'string' ? { effort: o.effort } : {}),
    ...(o.fast === true ? { fast: true } : {}),
    ...(typeof o.modelEndpoint === 'string' ? { modelEndpoint: o.modelEndpoint } : {})
  }
  return Object.keys(kept).length > 0 ? kept : undefined
}

/**
 * The turn a side question runs as. Throws (the ask is refused before anything spawns) on
 * an agent with no side chat, a session not named, or a question empty or past the limit.
 * The cwd and config home come back as given — index.ts validates both against what the
 * app derived, as it does for `chat:send`.
 */
export function sideTurnRequest(raw: SideChatRequest): ChatRequest {
  if (!sideChatSupported(raw.provider)) {
    throw new Error("Side chat isn't available for this agent — its CLI can't answer from a copy of a session.")
  }
  if (typeof raw.nativeSessionId !== 'string' || !raw.nativeSessionId) {
    throw new Error('Side chat needs a started session.')
  }
  const question = typeof raw.question === 'string' ? raw.question.trim() : ''
  if (!question) throw new Error('Ask a question first.')
  if (question.length > SIDE_QUESTION_MAX) {
    throw new Error(`That question is longer than ${SIDE_QUESTION_MAX.toLocaleString('en-US')} characters — shorten it.`)
  }
  const options = optionsOf(raw.options)
  return {
    provider: raw.provider,
    cwd: raw.cwd,
    prompt: sidePrompt(question, historyOf(raw.history)),
    resumeNativeId: raw.nativeSessionId,
    permissionMode: 'safe',
    sideFork: true,
    ...(options ? { options } : {}),
    ...(raw.configDir !== undefined ? { configDir: raw.configDir } : {})
  }
}
