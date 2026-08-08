import { defineWorkspace } from 'vitest/config'

/**
 * Two test tiers, one runner:
 *  - unit: main-process logic against real files in tmpdirs (node env)
 *  - component: renderer components against a stubbed window.cockpit (jsdom env)
 * E2E lives in tests/e2e and runs under Playwright, not Vitest.
 */
export default defineWorkspace([
  {
    test: {
      name: 'unit',
      environment: 'node',
      include: ['tests/*.test.ts']
    }
  },
  {
    test: {
      name: 'component',
      environment: 'jsdom',
      include: ['tests/component/**/*.test.{ts,tsx}'],
      setupFiles: ['tests/component/setup.ts']
    }
  }
])
