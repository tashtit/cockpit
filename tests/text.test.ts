import { describe, expect, it } from 'vitest'
import { clip, sliceCodePoints } from '../src/shared/text'

describe('sliceCodePoints', () => {
  it('slices like .slice() when no surrogate pair sits on the cut', () => {
    expect(sliceCodePoints('abcdef', 3)).toBe('abc')
    expect(sliceCodePoints('abc', 10)).toBe('abc')
  })

  it('backs off a cut that would split a surrogate pair', () => {
    // '🎉' is two UTF-16 units: a cut after its first would leave a lone surrogate
    expect(sliceCodePoints('ab🎉cd', 3)).toBe('ab')
    expect(sliceCodePoints('ab🎉cd', 4)).toBe('ab🎉')
  })
})

describe('clip', () => {
  it('leaves text that fits alone', () => {
    expect(clip('twelve chars', 12)).toBe('twelve chars')
  })

  it('cuts to exactly max units with the ellipsis as the last one', () => {
    expect(clip('abcdefghij', 5)).toBe('abcd…')
    expect(clip('abcdefghij', 5)).toHaveLength(5)
  })

  it('keeps a space at the cut unless asked to trim it', () => {
    expect(clip('abc defgh', 5)).toBe('abc …')
    expect(clip('abc defgh', 5, { trimCut: true })).toBe('abc…')
  })

  it('never cuts an emoji in half', () => {
    expect(clip('abc🎉defg', 5)).toBe('abc…')
  })
})
