/**
 * The protobuf wire format, read without a schema — Antigravity keeps its conversation
 * steps as protobuf messages whose definitions are not published. A message is a list
 * of (field number, value) pairs; a length-delimited value may be a string, bytes or a
 * nested message, and only the reader can say which. Everything here is bounded and
 * failure-tolerant: a buffer that does not parse reads as no fields.
 */

export type ProtoValue = number | Uint8Array

export type ProtoField = { readonly field: number; readonly value: ProtoValue }

/** The pairs of one message, in order; empty when the buffer is not a message. */
export function protoFields(buf: Uint8Array): ProtoField[] {
  const out: ProtoField[] = []
  let i = 0
  const varint = (): number => {
    let result = 0
    let scale = 1
    for (let n = 0; n < 10; n++) {
      if (i >= buf.length) throw new Error('truncated')
      const b = buf[i++]!
      result += (b & 0x7f) * scale
      if (b < 0x80) return result
      scale *= 128
    }
    throw new Error('varint too long')
  }
  try {
    while (i < buf.length) {
      const key = varint()
      const field = Math.floor(key / 8)
      const wire = key % 8
      if (field === 0) return []
      if (wire === 0) out.push({ field, value: varint() })
      else if (wire === 2) {
        const len = varint()
        if (i + len > buf.length) return []
        out.push({ field, value: buf.subarray(i, i + len) })
        i += len
      } else if (wire === 1) i += 8
      else if (wire === 5) i += 4
      else return []
    }
  } catch {
    return []
  }
  return i === buf.length ? out : []
}

/** Every value at a path of field numbers (`[20, 7, 2]`), in order. */
export function protoAll(buf: Uint8Array, path: readonly number[]): ProtoValue[] {
  let level: ProtoValue[] = [buf]
  for (const field of path) {
    const next: ProtoValue[] = []
    for (const v of level) {
      if (typeof v === 'number') continue
      for (const f of protoFields(v)) if (f.field === field) next.push(f.value)
    }
    level = next
  }
  return level
}

const decoder = new TextDecoder('utf-8', { fatal: true })

/** The value at a path as UTF-8 text, or null when there is none or it is not text. */
export function protoString(buf: Uint8Array, path: readonly number[]): string | null {
  const v = protoAll(buf, path)[0]
  if (v === undefined || typeof v === 'number') return null
  try {
    return decoder.decode(v)
  } catch {
    return null
  }
}

/** Every value at a path read as text, the ones that are not text left out. */
export function protoStrings(buf: Uint8Array, path: readonly number[]): string[] {
  const out: string[] = []
  for (const v of protoAll(buf, path)) {
    if (typeof v === 'number') continue
    try {
      out.push(decoder.decode(v))
    } catch {
      /* bytes, not text */
    }
  }
  return out
}

export function protoNumber(buf: Uint8Array, path: readonly number[]): number | null {
  const v = protoAll(buf, path)[0]
  return typeof v === 'number' ? v : null
}

/** A `google.protobuf.Timestamp` at a path — `{1: seconds, 2: nanos}` — as epoch ms. */
export function protoTime(buf: Uint8Array, path: readonly number[]): number | null {
  const v = protoAll(buf, path)[0]
  if (v === undefined || typeof v === 'number') return null
  const seconds = protoNumber(v, [1])
  if (seconds === null) return null
  return seconds * 1000 + Math.floor((protoNumber(v, [2]) ?? 0) / 1e6)
}
