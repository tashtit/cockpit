import { defineConfig } from 'vitest/config'

/**
 * Two test tiers, one runner:
 *  - unit: main-process logic against real files in tmpdirs (node env)
 *  - component: renderer components against a stubbed window.cockpit (jsdom env)
 * E2E lives in tests/e2e and runs under Playwright, not Vitest.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['tests/*.test.ts'],
          /**
           * This tier is deliberately unmocked: tests build real git repositories and
           * real worktrees in tmpdirs and run the shipping code over them, so a single
           * test can spawn a dozen git subprocesses. Vitest's 5s default is sized for
           * mocked units and turns a busy machine into a red suite — cleanup.test.ts
           * alone takes ~45s of honest work. A hang still fails, just not spuriously.
           */
          testTimeout: 20_000,
          hookTimeout: 20_000
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
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text-summary', 'html', 'cobertura'],
      reportsDirectory: 'coverage'
    }
  }
})
