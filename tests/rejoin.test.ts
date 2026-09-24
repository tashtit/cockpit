import { describe, it, expect } from 'vitest'
import { REJOIN_GRACE_MS, rejoinStream } from '../src/renderer/src/rejoin'
import type { ChatEvent, SessionMessage } from '../src/shared/types'

/**
 * A turn rejoined mid-flight: the log on disk and the stream meet at the log's tail,
 * and only there can the stream repeat a row the log already holds.
 */

const T = 'turn-9'
const text = (t: string): ChatEvent => ({ turnId: T, type: 'text', text: t })
const tool = (preview: string): ChatEvent => ({
  turnId: T,
  type: 'tool',
  toolName: 'Bash',
  detail: `{"command":"${preview}"}`,
  preview
})
const said = (t: string): SessionMessage => ({ role: 'assistant', kind: 'text', text: t })
const ran = (preview: string): SessionMessage => ({
  role: 'assistant',
  kind: 'tool_call',
  toolName: 'Bash',
  // the log's parser keeps more of the input than the stream does — preview is the match
  text: `{"command":"${preview}","description":"a longer detail than the stream carries"}`,
  preview
})
const result = (t: string): SessionMessage => ({ role: 'tool', kind: 'tool_result', text: t })

const LOG: readonly SessionMessage[] = [
  { role: 'user', kind: 'text', text: 'fix the login flake' },
  said('Looking at the test first.'),
  ran('npm test'),
  result('1 failing'),
  said('The retry is racing the timer.')
]

/** A clock the test moves by hand. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000
  return { now: () => t, advance: (ms) => (t += ms) }
}

describe('rejoinStream', () => {
  it('holds the stream until the log is read, then lets through what the log lacks', () => {
    const r = rejoinStream(T)
    expect(r.offer(text('A fresh thought.'))).toEqual([])
    expect(r.logRead(LOG)).toEqual([text('A fresh thought.')])
    expect(r.offer(tool('npm run build'))).toEqual([tool('npm run build')])
  })

  it('drops the rows the log already holds when the stream re-sends its tail', () => {
    const r = rejoinStream(T)
    // written to the log and streamed while the log was being read
    r.offer(tool('npm test'))
    r.offer(text('The retry is racing the timer.'))
    r.offer(text('Patching it now.'))
    expect(r.logRead(LOG)).toEqual([text('Patching it now.')])
  })

  it('matches a re-send that arrives just after the read, as a CLI can write its log line first', () => {
    const c = clock()
    const r = rejoinStream(T, c.now)
    expect(r.logRead(LOG)).toEqual([])
    c.advance(20)
    expect(r.offer(text('The retry is racing the timer.'))).toEqual([])
    expect(r.offer(text('Patching it now.'))).toEqual([text('Patching it now.')])
  })

  it('stops matching at the first row the log does not hold', () => {
    const r = rejoinStream(T)
    r.offer(text('Patching it now.'))
    // the agent says what it said before — new, because the stream had moved past the log
    r.offer(text('The retry is racing the timer.'))
    expect(r.logRead(LOG)).toEqual([text('Patching it now.'), text('The retry is racing the timer.')])
  })

  it('takes the first row out of the log’s order as new', () => {
    const r = rejoinStream(T)
    // the tool call is the log's; a re-send would carry on with its reply, not this
    r.offer(tool('npm test'))
    r.offer(tool('npm run lint'))
    expect(r.logRead(LOG)).toEqual([tool('npm run lint')])
  })

  it('lets a genuine repeat through once the moment after the read has passed', () => {
    const c = clock()
    const r = rejoinStream(T, c.now)
    r.logRead(LOG)
    c.advance(REJOIN_GRACE_MS + 1)
    // the agent reruns the suite, well after the read: a row of its own, not the log's
    expect(r.offer(tool('npm test'))).toEqual([tool('npm test')])
  })

  it('passes everything that is not a transcript row, in order, re-sent rows or not', () => {
    const r = rejoinStream(T)
    const session: ChatEvent = { turnId: T, type: 'session', nativeSessionId: 'abc' }
    const failed: ChatEvent = { turnId: T, type: 'error', message: 'rate limited' }
    const done: ChatEvent = { turnId: T, type: 'done' }
    r.offer(session)
    r.offer(text('The retry is racing the timer.'))
    r.offer(failed)
    r.offer(done)
    expect(r.logRead(LOG)).toEqual([session, failed, done])
  })

  it('lets the whole stream through when the log could not be read', () => {
    const r = rejoinStream(T)
    r.offer(text('The retry is racing the timer.'))
    expect(r.logRead([])).toEqual([text('The retry is racing the timer.')])
  })
})
