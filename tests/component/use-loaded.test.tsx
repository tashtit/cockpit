import { describe, it, expect } from 'vitest'
import { act, renderHook, waitFor, type RenderHookResult } from '@testing-library/react'
import { useLoaded, type Loaded, type LoadOptions } from '../../src/renderer/src/use-loaded'

/** A read whose answer the test hands over when it chooses. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

type Props = { readonly key: string; readonly load: (() => Promise<string[]>) | null }

function hook(first: Props, opts?: LoadOptions<string[]>): RenderHookResult<Loaded<string[] | null>, Props> {
  return renderHook(({ key, load }: Props) => useLoaded<string[], string[] | null>(load, [key], opts), {
    initialProps: first
  })
}

describe('useLoaded', () => {
  it('lands only the newest read: an answer to deps since moved on is dropped', async () => {
    const slow = deferred<string[]>()
    const fast = deferred<string[]>()
    const r = hook({ key: 'a', load: () => slow.promise })
    expect(r.result.current.loading).toBe(true)
    r.rerender({ key: 'b', load: () => fast.promise })
    await act(async () => fast.resolve(['b']))
    await act(async () => slow.resolve(['a']))
    expect(r.result.current.value).toEqual(['b'])
    expect(r.result.current.loading).toBe(false)
  })

  it('holds the previous identity when asked and the answer says the same', async () => {
    let answer = ['x']
    const r = hook({ key: 'a', load: () => Promise.resolve(answer) }, { keepSame: true })
    await waitFor(() => expect(r.result.current.value).toEqual(['x']))
    const first = r.result.current.value
    answer = ['x']
    r.rerender({ key: 'b', load: () => Promise.resolve(answer) })
    await waitFor(() => expect(r.result.current.loading).toBe(false))
    expect(r.result.current.value).toBe(first)
  })

  it("says main's refusal without Electron's wrapper and keeps what it had", async () => {
    const r = hook({ key: 'a', load: () => Promise.resolve(['kept']) })
    await waitFor(() => expect(r.result.current.value).toEqual(['kept']))
    r.rerender({
      key: 'b',
      load: () => Promise.reject(new Error("Error invoking remote method 'x:y': Error: Not a directory"))
    })
    await waitFor(() => expect(r.result.current.error).toBe('Not a directory'))
    expect(r.result.current.value).toEqual(['kept'])
    expect(r.result.current.loading).toBe(false)
    // the next read that succeeds clears it
    r.rerender({ key: 'c', load: () => Promise.resolve(['new']) })
    await waitFor(() => expect(r.result.current.error).toBeNull())
  })

  it('keeps the value while there is nothing to read, and starts over on a reset', async () => {
    const r = hook({ key: 'a', load: () => Promise.resolve(['a']) }, { initial: [], reset: true })
    expect(r.result.current.value).toEqual([])
    await waitFor(() => expect(r.result.current.value).toEqual(['a']))
    r.rerender({ key: 'a', load: null })
    expect(r.result.current.value).toEqual(['a'])
    r.rerender({ key: 'b', load: null })
    expect(r.result.current.value).toEqual([])
  })
})
