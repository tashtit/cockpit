import { describe, expect, it } from 'vitest'
import { execText } from '../src/main/env'

describe('execText', () => {
  it('answers ok with the output of a CLI that succeeds', async () => {
    const r = await execText('/bin/sh', ['-c', 'printf hello'])
    expect(r).toMatchObject({ ok: true, stdout: 'hello', error: null })
    expect(r.cutShort).toBeUndefined()
  })

  it('says a run the timeout stopped was cut short', async () => {
    const r = await execText('/bin/sh', ['-c', 'printf partial; exec sleep 5'], { timeoutMs: 200 })
    expect(r.ok).toBe(false)
    expect(r.cutShort).toBe(true)
  })

  it('keeps its deadline against a CLI that ignores SIGTERM', async () => {
    // execFile's own timeout only signals and then waits for the child to close — a
    // child that traps TERM (or hangs on a dead network mount) held the caller as long
    // as it liked
    const started = Date.now()
    const r = await execText('/bin/sh', ['-c', "trap '' TERM; sleep 4"], { timeoutMs: 200 })
    expect(r.ok).toBe(false)
    expect(r.cutShort).toBe(true)
    expect(Date.now() - started).toBeLessThan(3_500)
  })
})
