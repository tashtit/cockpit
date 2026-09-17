import { describe, it, expect } from 'vitest'
import { ipcErrorText } from '../src/renderer/src/ipc-error'

describe('ipcErrorText', () => {
  it('strips Electron’s remote-method wrapper so main’s own message is what shows', () => {
    expect(
      ipcErrorText(new Error("Error invoking remote method 'sources:add': Error: Not a directory: /nope"))
    ).toBe('Not a directory: /nope')
  })

  it('leaves a message that was never wrapped alone', () => {
    expect(ipcErrorText(new Error('Invalid provider: base URL must be http(s)'))).toBe(
      'Invalid provider: base URL must be http(s)'
    )
  })

  it('stringifies a rejection that is not an Error', () => {
    expect(ipcErrorText('disk full')).toBe('disk full')
  })
})
