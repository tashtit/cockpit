import { describe, expect, it } from 'vitest'
import { protoAll, protoFields, protoNumber, protoString, protoStrings, protoTime } from '../src/main/parsers/protobuf'
import { protoEncode } from '../scripts/ui-tour/store-fixtures.mts'

describe('the protobuf wire format, read without a schema', () => {
  const msg = protoEncode([
    [5, [[1, [[1, 1_787_440_451], [2, 379_900_000]]], [4, [[2, 'list_dir'], [3, '{"DirectoryPath":"/x"}']]]]],
    [19, [[2, 'first prompt']]],
    [20, [[7, [[2, 'view_file']]], [7, [[2, 'grep_search']]]]],
    [9, 300]
  ])

  it('walks nested messages by field path', () => {
    expect(protoString(msg, [19, 2])).toBe('first prompt')
    expect(protoString(msg, [5, 4, 2])).toBe('list_dir')
    expect(protoStrings(msg, [20, 7, 2])).toEqual(['view_file', 'grep_search'])
    expect(protoNumber(msg, [9])).toBe(300)
    expect(protoTime(msg, [5, 1])).toBe(1_787_440_451_379)
  })

  it('answers nothing for a path that is not there, or not what it asked for', () => {
    expect(protoString(msg, [19, 3])).toBeNull()
    expect(protoAll(msg, [99])).toEqual([])
    expect(protoNumber(msg, [19])).toBeNull()
    // bytes that are not text are not a string
    expect(protoString(protoEncode([[1, Uint8Array.from([0xff, 0xfe])]]), [1])).toBeNull()
  })

  it('reads a truncated or foreign buffer as no fields, never a throw', () => {
    // cut inside a field's body, not at a field boundary (which is a shorter message)
    expect(protoFields(msg.subarray(0, msg.length - 4))).toEqual([])
    expect(protoFields(new TextEncoder().encode('SQLite format 3'))).toEqual([])
    expect(protoFields(Uint8Array.from([0x08, 0xff, 0xff]))).toEqual([])
    expect(protoFields(new Uint8Array(0))).toEqual([])
  })
})
