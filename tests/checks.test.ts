import { describe, expect, it } from 'vitest'
import {
  checkArtifact,
  checkKinds,
  checkOutcome,
  commandItemCheck,
  exitCodeIn,
  exitIsTheChecks,
  reportsFailure,
  scriptKind
} from '../src/main/parsers/checks'
import type { WorkArtifact } from '../src/shared/types'

describe('checkKinds: which checks a script runs', () => {
  it('knows a check by the tool it runs', () => {
    expect(checkKinds('npx vitest run tests/indexer.test.ts')).toEqual(['tests'])
    expect(checkKinds('./node_modules/.bin/tsc --noEmit -p .')).toEqual(['types'])
    expect(checkKinds('npx playwright test --grep login')).toEqual(['e2e'])
    expect(checkKinds('go test ./...')).toEqual(['tests'])
    expect(checkKinds('cargo clippy --all-targets')).toEqual(['lint'])
    expect(checkKinds('python3 -m pytest -q')).toEqual(['tests'])
    expect(checkKinds('uv run --frozen mypy src')).toEqual(['types'])
    expect(checkKinds('bundle exec rspec spec/models')).toEqual(['tests'])
    expect(checkKinds('npx prettier --check .')).toEqual(['lint'])
    expect(checkKinds('./gradlew test')).toEqual(['tests'])
  })

  it('knows a package or task runner’s check by the script it is handed', () => {
    expect(checkKinds('npm test')).toEqual(['tests'])
    expect(checkKinds('npm test -- --run')).toEqual(['tests'])
    expect(checkKinds('npm run typecheck')).toEqual(['types'])
    expect(checkKinds('npm run test:e2e -- --grep login')).toEqual(['e2e'])
    expect(checkKinds('npm run test:coverage')).toEqual(['tests'])
    expect(checkKinds('pnpm lint')).toEqual(['lint'])
    expect(checkKinds('pnpm --filter web build')).toEqual(['build'])
    expect(checkKinds('pnpm exec prettier --check src')).toEqual(['lint'])
    expect(checkKinds('yarn vitest')).toEqual(['tests'])
    expect(checkKinds('bun test')).toEqual(['tests'])
    expect(checkKinds('npx nx run-many -t test lint --parallel=3')).toEqual(['tests', 'lint'])
    expect(checkKinds('nx run web:typecheck')).toEqual(['types'])
    expect(checkKinds('nx affected --targets=build,e2e')).toEqual(['build', 'e2e'])
    expect(checkKinds('turbo run build test')).toEqual(['build', 'tests'])
  })

  it('reads every command of a script, each check once, in its order', () => {
    expect(checkKinds('cd /repo && npm run typecheck && npm test 2>&1 | tail -30')).toEqual(['types', 'tests'])
    expect(checkKinds('CI=1 timeout 300 npx vitest run; npm test')).toEqual(['tests'])
    expect(checkKinds('export PATH="$HOME/bin:$PATH"; (cd app && npm run lint)')).toEqual(['lint'])
  })

  it('is no check where the command only mentions one', () => {
    expect(checkKinds('grep -n vitest package.json')).toEqual([])
    expect(checkKinds('echo npm test')).toEqual([])
    expect(checkKinds('npm install vitest')).toEqual([])
    expect(checkKinds('npm run dev')).toEqual([])
    expect(checkKinds('pnpm add -D eslint')).toEqual([])
    expect(checkKinds('git commit -m "fix the test"')).toEqual([])
    expect(checkKinds('make')).toEqual([])
    expect(checkKinds('nx graph')).toEqual([])
  })

  it('reads script names the way projects write them', () => {
    expect(scriptKind('e2e')).toBe('e2e')
    expect(scriptKind('test:component')).toBe('tests')
    expect(scriptKind('check-types')).toBe('types')
    expect(scriptKind('lint:fix')).toBe('lint')
    expect(scriptKind('format:check')).toBe('lint')
    expect(scriptKind('build:mac')).toBe('build')
    expect(scriptKind('testing-library')).toBeNull()
    expect(scriptKind('ui:tour')).toBeNull()
  })

  it('makes a bounded artifact of a check, and nothing of anything else', () => {
    expect(checkArtifact('npm test')).toEqual({ kind: 'check', checks: ['tests'], command: 'npm test', ownExit: true })
    expect(checkArtifact('npm test | tail -5')).toEqual({ kind: 'check', checks: ['tests'], command: 'npm test | tail -5' })
    // the setup in front says nothing about the check; judging the exit still reads it all
    expect(checkArtifact('cd /repo && export PATH="$HOME/bin:$PATH" && npm test 2>&1 | tail -5')).toEqual({
      kind: 'check',
      checks: ['tests'],
      command: 'npm test 2>&1 | tail -5'
    })
    expect(checkArtifact('git pull && npm run build')).toMatchObject({ command: 'npm run build' })
    expect(checkArtifact('git pull && npm run build')).not.toHaveProperty('ownExit')
    expect(checkArtifact('ls -la')).toBeUndefined()
    expect(checkArtifact(42)).toBeUndefined()
    const long = checkArtifact(`npm test -- ${'x'.repeat(1000)}`)
    expect(long?.kind === 'check' && long.command.length).toBeLessThanOrEqual(300)
  })
})

describe('how a check ended', () => {
  const tests = checkArtifact('npm test 2>&1 | tail -20')!

  it('reads the exit code each CLI states', () => {
    expect(exitCodeIn('Exit code 1\n FAIL x')).toBe(1)
    expect(exitCodeIn('lots of output\n<exited with exit code 2>')).toBe(2)
    expect(exitCodeIn('out\n<shellId: 74 completed with exit code 1>')).toBe(1)
    expect(exitCodeIn('Chunk ID: 1\nWall time: 2s\nProcess exited with code 0\nOutput:\nok')).toBe(0)
    expect(exitCodeIn('{"output":"ok","metadata":{"exit_code":3,"duration_seconds":1}}')).toBe(3)
    expect(exitCodeIn('all good')).toBeNull()
    expect(exitCodeIn('{not json')).toBeNull()
  })

  it('passes on a zero exit, fails on its own non-zero exit, and keeps the last lines printed', () => {
    const passed = checkOutcome(tests, { text: 'ok\n\n Tests  20 passed (20)\n', exitCode: 0 })
    expect(passed).toMatchObject({ status: 'passed', exitCode: 0, output: ['ok', ' Tests  20 passed (20)'] })
    const plain = checkArtifact('cd app && export CI=1 && npm test')!
    const failed = checkOutcome(plain, { text: 'Exit code 1\nboom', exitCode: 1 })
    expect(failed).toMatchObject({ status: 'failed', exitCode: 1, output: ['boom'] })
  })

  it('does not blame a check for an exit something else in the script set', () => {
    // the rebase stopped the chain before the tests ran
    const chain = checkArtifact('git rebase origin/main && npm test')!
    const rebase = checkOutcome(chain, { text: 'Exit code 1\nCONFLICT (content): Merge conflict in a.ts', exitCode: 1 })
    expect(rebase).toMatchObject({ exitCode: 1 })
    expect(rebase).not.toHaveProperty('status')
    // grep found no match: its status, not the typecheck's
    const grep = checkOutcome(checkArtifact('npm run typecheck 2>&1 | grep error')!, { text: '', exitCode: 1 })
    expect(grep).not.toHaveProperty('status')
    // …but the runner's own summary is the runner's, whatever set the exit
    expect(checkOutcome(chain, { text: 'Tests  2 failed | 5 passed', exitCode: 1 })).toMatchObject({ status: 'failed' })
  })

  it('knows when a script’s exit is its checks’ own', () => {
    expect(exitIsTheChecks('npm run typecheck && npm test')).toBe(true)
    expect(exitIsTheChecks('cd /r && export PATH="$HOME/bin:$PATH"; X=1 npx vitest run; echo done')).toBe(true)
    expect(exitIsTheChecks('npm test 2>&1 | tail -20')).toBe(false)
    expect(exitIsTheChecks('npm run build && node scripts/probe.mjs')).toBe(false)
    expect(exitIsTheChecks('git fetch && git rebase origin/main && npm test')).toBe(false)
  })

  it('does not reach Object’s prototype for a command word', () => {
    expect(checkKinds('constructor test && toString build && make constructor')).toEqual([])
  })

  it('fails on a runner’s own summary when a pipe swallowed the exit code', () => {
    for (const text of [
      ' Test Files  1 failed | 12 passed (13)\n      Tests  2 failed | 200 passed (202)',
      'Tests:       1 failed, 41 passed, 42 total',
      '===== 3 failed, 10 passed in 2.1s =====',
      'error during build:\nRollupError: Could not resolve "./x"',
      ' ELIFECYCLE  Command failed with exit code 1.',
      '  14 passed, 6 failed',
      "src/a.ts(3,1): error TS2322: Type 'x' is not assignable",
      '✖ 4 problems (2 errors, 2 warnings)',
      '--- FAIL: TestLogin (0.01s)',
      'test result: FAILED. 3 passed; 1 failed',
      'npm error Lifecycle script `test` failed with error:'
    ]) {
      expect(checkOutcome(tests, { text, exitCode: 0 })).toMatchObject({ status: 'failed' })
    }
    // zero counts and warnings are not failures
    expect(reportsFailure('Tests  0 failed | 12 passed')).toBe(false)
    expect(reportsFailure('✖ 2 problems (0 errors, 2 warnings)')).toBe(false)
  })

  it('has no verdict where the result says nothing of how it ended', () => {
    // still running in the background, or a read that stated no exit code
    const none = checkOutcome(tests, { text: 'Command running in background with ID: b1', exitCode: null })
    expect(none.kind === 'check' && none.status).toBeUndefined()
    expect(none).toMatchObject({ output: ['Command running in background with ID: b1'] })
  })

  it('shows what the CLI printed, not the markers it wraps the output in', () => {
    const claude = checkOutcome(tests, { text: 'Tests  3 passed\nShell cwd was reset to /Users/me/repo', exitCode: 0 })
    expect(claude).toMatchObject({ output: ['Tests  3 passed'] })
    const codex = checkOutcome(tests, {
      text: 'Chunk ID: 9\nWall time: 3.1 seconds\nProcess exited with code 1\nOutput:\nFAIL a.test.ts\n1 failed',
      exitCode: 1
    })
    expect(codex).toMatchObject({ output: ['FAIL a.test.ts', '1 failed'] })
    const copilot = checkOutcome(tests, { text: 'all 20 passed\n<exited with exit code 0>', exitCode: 0 })
    expect(copilot).toMatchObject({ status: 'passed', output: ['all 20 passed'] })
    const legacy = checkOutcome(tests, { text: '{"output":"ok\\n","metadata":{"exit_code":0}}', exitCode: 0 })
    expect(legacy).toMatchObject({ output: ['ok'] })
  })

  it('keeps the output bounded: the last twelve lines, each cut to a readable width', () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i} ${'y'.repeat(i === 39 ? 900 : 0)}`).join('\n')
    const a = checkOutcome(tests, { text, exitCode: 0 }) as Extract<WorkArtifact, { kind: 'check' }>
    expect(a.output).toHaveLength(12)
    expect(a.output![0]).toBe('line 28')
    expect(a.output![11]!.length).toBeLessThanOrEqual(240)
  })

  it('leaves anything but a check as it was', () => {
    const plan: WorkArtifact = { kind: 'plan', text: 'p' }
    expect(checkOutcome(plan, { text: 'x', exitCode: 1 })).toBe(plan)
  })

  it('reads a Codex command item, in the rollout’s shape and the stream’s', () => {
    expect(
      commandItemCheck({ type: 'CommandExecution', command: ['/bin/zsh', '-lc', 'npm test'], aggregated_output: '1 failed', exit_code: 1 })
    ).toMatchObject({ checks: ['tests'], command: 'npm test', status: 'failed', exitCode: 1, ownExit: true })
    expect(
      commandItemCheck({ type: 'command_execution', command: "bash -lc 'npx tsc --noEmit'", aggregated_output: '', exit_code: 0 })
    ).toMatchObject({ checks: ['types'], status: 'passed' })
    // still running: named, no verdict
    expect(commandItemCheck({ command: 'npm test', status: 'in_progress' })).toEqual({
      kind: 'check',
      checks: ['tests'],
      command: 'npm test',
      ownExit: true
    })
    expect(commandItemCheck({ command: ['git', 'status'], exit_code: 0 })).toBeUndefined()
    expect(commandItemCheck(null)).toBeUndefined()
  })
})
