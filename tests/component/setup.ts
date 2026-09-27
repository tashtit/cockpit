import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { freshApi } from './stub-api'
import { setChatLog } from '../../src/renderer/src/chat-log'

// api.ts captures window.cockpit at module load, so the stub must exist before any
// test module imports it — and between tests we swap methods on that same object
// (never reassign window.cockpit) so the captured reference stays live.
window.cockpit = freshApi()

// jsdom has no layout — Select scrolls its active option into view when opened,
// and the chat transcript pins itself to the bottom
Element.prototype.scrollIntoView ??= () => {}
Element.prototype.scrollTo ??= () => {}

beforeEach(async () => {
  Object.assign(window.cockpit, freshApi())
  window.localStorage.clear()
  // the open conversation lives in a module store (chat-log.ts), not in App's state
  setChatLog([])
  // so does which agents an ACP agent drives: each test starts from the three CLIs. Loaded
  // here, not above: it imports api.ts, which must not load before the stub exists
  const { clearAcpReadiness } = await import('../../src/renderer/src/acp-readiness')
  clearAcpReadiness()
})

afterEach(() => {
  cleanup()
})
