import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeFifo } from './fifo'
import { readIfPresent, readJsonState, saveJsonQuietly } from '../src/main/state-file'

const root = mkdtempSync(join(tmpdir(), 'cockpit-state-file-'))
const stops: Array<() => void> = []
afterAll(() => {
  stops.forEach((stop) => stop())
  rmSync(root, { recursive: true, force: true })
})

describe('readJsonState', () => {
  const count = (raw: unknown): number => {
    const n = (raw as { n?: unknown } | null)?.n
    if (typeof n !== 'number') throw new Error('no count')
    return n
  }

  it('reads a state file back through its sanitizer', () => {
    const f = join(root, 'good.json')
    writeFileSync(f, '{"n":3}')
    expect(readJsonState(f, count, 0)).toBe(3)
  })

  it('is a fresh start for a missing, mangled, unsanitary or non-regular file', () => {
    expect(readJsonState(join(root, 'missing.json'), count, 0)).toBe(0)
    writeFileSync(join(root, 'bad.json'), '{"n":')
    expect(readJsonState(join(root, 'bad.json'), count, 0)).toBe(0)
    writeFileSync(join(root, 'odd.json'), '{"n":"three"}')
    expect(readJsonState(join(root, 'odd.json'), count, 0)).toBe(0)
    const pipe = join(root, 'pipe.json')
    stops.push(makeFifo(pipe))
    const started = Date.now()
    expect(readJsonState(pipe, count, 0)).toBe(0)
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('saveJsonQuietly', () => {
  it('writes the file whole, and logs rather than throws when it cannot', () => {
    const f = join(root, 'saved.json')
    saveJsonQuietly(f, '{"n":1}', '[test] could not save:')
    expect(readFileSync(f, 'utf8')).toBe('{"n":1}')
    const blocked = join(root, 'blocked')
    mkdirSync(join(blocked, 'state.json'), { recursive: true })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() => saveJsonQuietly(join(blocked, 'state.json'), '{}', '[test] could not save:')).not.toThrow()
      expect(error).toHaveBeenCalledWith('[test] could not save:', expect.any(Error))
    } finally {
      error.mockRestore()
    }
  })
})

describe('readIfPresent', () => {
  it('reads a file, is null for none, and refuses one it cannot read', () => {
    const f = join(root, 'present.txt')
    writeFileSync(f, 'hi')
    expect(readIfPresent(f)).toBe('hi')
    expect(readIfPresent(join(root, 'absent.txt'))).toBeNull()
    expect(() => readIfPresent(root)).toThrow(/^cannot read .*EISDIR/)
  })
})
