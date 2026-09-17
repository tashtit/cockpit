/**
 * IPC rejections reach the renderer wrapped by Electron — "Error invoking remote
 * method 'sources:add': Error: Not a directory: …". Main's own message is the whole
 * explanation, so every surface that shows one strips the wrapper first.
 */
export function ipcErrorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '')
}
