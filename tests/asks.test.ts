import { describe, it, expect } from 'vitest'
import { formatAskAnswer, parseAsks } from '../src/shared/asks'

/** The shape confirmed against real Claude Code logs (2026-09). */
const askInput = {
  questions: [
    {
      question: 'Apply the proposed settings changes?',
      header: 'Apply?',
      multiSelect: false,
      options: [
        { label: 'Yes, apply all', description: 'Apply the settings in one pass.' },
        { label: 'Dry run only', description: 'Print what would be sent.' },
        { label: 'No' }
      ]
    }
  ]
}

describe('parseAsks', () => {
  it('reads a claude AskUserQuestion with its options', () => {
    expect(parseAsks('AskUserQuestion', askInput)).toEqual([
      {
        question: 'Apply the proposed settings changes?',
        header: 'Apply?',
        options: [
          { label: 'Yes, apply all', description: 'Apply the settings in one pass.' },
          { label: 'Dry run only', description: 'Print what would be sent.' },
          { label: 'No' }
        ]
      }
    ])
  })

  it('keeps multiSelect only when the agent asked for it', () => {
    const multi = { questions: [{ question: 'Where?', multiSelect: true, options: ['Sign-in', 'Empty states'] }] }
    expect(parseAsks('AskUserQuestion', multi)?.[0]).toEqual({
      question: 'Where?',
      multiSelect: true,
      options: [{ label: 'Sign-in' }, { label: 'Empty states' }]
    })
    expect(parseAsks('AskUserQuestion', askInput)?.[0].multiSelect).toBeUndefined()
  })

  it('reads codex request_user_input the same way, options as objects or strings', () => {
    const input = {
      questions: [{ title: 'Which branch?', options: [{ name: 'main', detail: 'the default' }, 'release'] }]
    }
    expect(parseAsks('request_user_input', input)).toEqual([
      { question: 'Which branch?', options: [{ label: 'main', description: 'the default' }, { label: 'release' }] }
    ])
  })

  it('gives ExitPlanMode its two answers — it offers no list of its own', () => {
    const plan = parseAsks('ExitPlanMode', { plan: '# Plan' })
    expect(plan?.[0].options.map((o) => o.label)).toEqual(['Approve the plan', 'Keep planning'])
    // Copilot's plan gate is the same question
    expect(parseAsks('exit_plan_mode', { summary: 'Two steps', recommendedAction: 'autopilot' })).toEqual(plan)
  })

  it("reads copilot ask_user: one question, its choices as plain strings", () => {
    // the shape confirmed against real Copilot CLI logs (2026-09)
    const input = {
      question: 'Which of these should I fix?',
      choices: ['Fix #2–#5 (Recommended)', 'Fix #2 and #3 only']
    }
    expect(parseAsks('ask_user', input)).toEqual([
      { question: 'Which of these should I fix?', options: [{ label: 'Fix #2–#5 (Recommended)' }, { label: 'Fix #2 and #3 only' }] }
    ])
    // a free-form question is prose, which the composer already takes
    expect(parseAsks('ask_user', { question: 'What should the release be called?' })).toBeUndefined()
    expect(parseAsks('ask_user', { choices: ['a', 'b'] })).toBeUndefined()
  })

  it('is not a question when there is nothing to pick', () => {
    expect(parseAsks('Bash', { command: 'ls' })).toBeUndefined()
    expect(parseAsks('AskUserQuestion', { questions: 'nope' })).toBeUndefined()
    expect(parseAsks('AskUserQuestion', { questions: [{ question: 'Well?' }] })).toBeUndefined()
    expect(parseAsks('AskUserQuestion', { questions: [{ options: ['a'] }] })).toBeUndefined()
    expect(parseAsks('AskUserQuestion', undefined)).toBeUndefined()
  })

  it('bounds a pathological log: 4 questions, 8 options, no duplicate labels', () => {
    const many = {
      questions: Array.from({ length: 9 }, (_, q) => ({
        question: `q${q}`,
        options: [...Array.from({ length: 12 }, (_, o) => `o${o}`), 'o0']
      }))
    }
    const parsed = parseAsks('AskUserQuestion', many)
    expect(parsed).toHaveLength(4)
    expect(parsed?.[0].options).toHaveLength(8)
    expect(new Set(parsed?.[0].options.map((o) => o.label)).size).toBe(8)
  })

  it('collapses whitespace and caps long text', () => {
    const parsed = parseAsks('AskUserQuestion', {
      questions: [{ question: `  Which\n  one?  `, options: [{ label: 'x'.repeat(400) }] }]
    })
    expect(parsed?.[0].question).toBe('Which one?')
    expect(parsed?.[0].options[0].label).toHaveLength(160)
  })
})

describe('formatAskAnswer', () => {
  const prompts = parseAsks('AskUserQuestion', {
    questions: [
      { question: 'Apply the changes?', options: ['Yes', 'No'] },
      { question: 'Where?', multiSelect: true, options: ['Sign-in', 'Empty states'] }
    ]
  })!

  it('repeats each question with its pick — the answer stands on its own', () => {
    expect(formatAskAnswer(prompts, [['Yes'], ['Sign-in', 'Empty states']])).toBe(
      'Answering your questions:\n- Apply the changes? → Yes\n- Where? → Sign-in, Empty states'
    )
  })

  it('leaves out questions nothing was picked for, and says "question" for one', () => {
    expect(formatAskAnswer(prompts, [['Yes'], []])).toBe('Answering your question:\n- Apply the changes? → Yes')
  })

  it('sends nothing when nothing was picked', () => {
    expect(formatAskAnswer(prompts, [[], []])).toBe('')
    expect(formatAskAnswer(prompts, [])).toBe('')
  })
})
