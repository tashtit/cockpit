import type { AskOption, AskPrompt } from './types'

/**
 * Questions an agent stopped to ask, and the answer a pick turns into.
 *
 * The agents that can ask say so in a tool call that never gets an answer on its own:
 * Claude's `AskUserQuestion` (a list of questions, each with labelled options) and
 * `ExitPlanMode` (approve the plan, or keep planning), Codex's `request_user_input`,
 * Copilot's `ask_user` (one question and its `choices`) and `exit_plan_mode`.
 * Copilot's permission prompts are not here on purpose — approving one needs the
 * process that is blocked on it, and Cockpit answers by sending a message.
 *
 * Log shapes are provider-internal and drift between releases, so every field is
 * read defensively and everything is bounded: a malformed question is no question,
 * never a broken transcript. IO-free — both processes import this.
 */

/** A pathological log must never turn into a wall of chips. */
const MAX_QUESTIONS = 4
const MAX_OPTIONS = 8
const MAX_LABEL = 160
const MAX_TEXT = 400

function text(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

function record(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

/** One offered answer: a bare string, or an object naming the label and what it means. */
function toOption(v: unknown): AskOption | null {
  const label = text(v, MAX_LABEL) || text(record(v)?.label ?? record(v)?.name ?? record(v)?.option, MAX_LABEL)
  if (!label) return null
  const description = text(record(v)?.description ?? record(v)?.detail, MAX_TEXT)
  return description ? { label, description } : { label }
}

function toPrompt(v: unknown): AskPrompt | null {
  const q = record(v)
  if (!q) return null
  const question = text(q.question ?? q.title ?? q.prompt, MAX_TEXT)
  const options: AskOption[] = []
  // Copilot names its offered answers `choices`
  const offered = Array.isArray(q.options) ? q.options : q.choices
  if (Array.isArray(offered)) {
    for (const o of offered) {
      const opt = toOption(o)
      // a repeated label would make two picks indistinguishable in the answer
      if (opt && !options.some((p) => p.label === opt.label)) options.push(opt)
      if (options.length === MAX_OPTIONS) break
    }
  }
  // a question with nothing to pick is prose, and the composer already handles prose
  if (!question || options.length === 0) return null
  const header = text(q.header, 40)
  return {
    question,
    ...(header ? { header } : {}),
    ...(q.multiSelect === true ? { multiSelect: true } : {}),
    options
  }
}

/** The plan gate (Claude's and Copilot's) asks one thing and offers no list — these are its two answers. */
const PLAN_PROMPT: AskPrompt = {
  question: 'Approve this plan and start implementing it?',
  header: 'Plan',
  options: [
    { label: 'Approve the plan', description: 'Go ahead and implement it as written.' },
    { label: 'Keep planning', description: 'Not yet — the plan needs changes first.' }
  ]
}

/**
 * The questions a tool call is waiting on, or undefined when it is an ordinary tool.
 * `input` is the call's parsed arguments (Codex writes them as a JSON string — parse
 * before calling).
 */
export function parseAsks(toolName: string, input: unknown): AskPrompt[] | undefined {
  if (toolName === 'ExitPlanMode' || toolName === 'exit_plan_mode') return [PLAN_PROMPT]
  // Copilot asks one question per call, at the top level of its arguments; a bare
  // question with no `choices` wants prose, which the composer already takes
  if (toolName === 'ask_user') {
    const prompt = toPrompt(input)
    return prompt ? [prompt] : undefined
  }
  if (toolName !== 'AskUserQuestion' && toolName !== 'request_user_input') return undefined
  const questions = record(input)?.questions
  if (!Array.isArray(questions)) return undefined
  const out: AskPrompt[] = []
  for (const q of questions) {
    const prompt = toPrompt(q)
    if (prompt) out.push(prompt)
    if (out.length === MAX_QUESTIONS) break
  }
  return out.length > 0 ? out : undefined
}

/**
 * The message a set of picks sends. Cockpit answers by continuing the session, so
 * this is the user's next prompt — it repeats each question so the answer stands on
 * its own in a transcript the agent resumes from. Questions left unpicked are left
 * out; nothing picked at all sends nothing. A pick may be the person's own words
 * (the card's Other), several lines long: those stay inside their question's item.
 */
export function formatAskAnswer(
  prompts: readonly AskPrompt[],
  picks: readonly (readonly string[])[]
): string {
  const lines = prompts
    .map((p, i) => ({ p, picked: (picks[i] ?? []).filter((l) => l.trim()) }))
    .filter(({ picked }) => picked.length > 0)
    .map(({ p, picked }) => {
      const said = picked.map((l) => l.trim().replace(/\n/g, '\n  '))
      return `- ${p.question} → ${said.join(', ')}`
    })
  if (lines.length === 0) return ''
  const head = lines.length > 1 ? 'Answering your questions:' : 'Answering your question:'
  return `${head}\n${lines.join('\n')}`
}
