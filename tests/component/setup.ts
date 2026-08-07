import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import { freshApi } from './stub-api'

// api.ts captures window.cockpit at module load, so the stub must exist before any
// test module imports it — and between tests we swap methods on that same object
// (never reassign window.cockpit) so the captured reference stays live.
window.cockpit = freshApi()

beforeEach(() => {
  Object.assign(window.cockpit, freshApi())
  window.localStorage.clear()
})

afterEach(() => {
  cleanup()
})
