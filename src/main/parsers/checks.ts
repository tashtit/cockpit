import type { CheckKind, WorkArtifact } from '../../shared/types'
import { shellScript, truncate } from './util'

/**
 * Which of an agent's shell commands were checks — tests, a typecheck, a linter, a
 * build — and how each one ended, for every agent. The Work panel's Checks tab answers
 * "did it verify after its last edit?" from these.
 *
 * How a run ended is read off its exit code where the log states one (Claude's `Exit
 * code N`, Codex's `exit_code`, Copilot's `shellExecution.exitCode`), and off the
 * runner's own summary in what it printed: agents pipe their tests through `tail`, and
 * a pipeline exits with its last command's status whatever the tests did.
 *
 * A heuristic by nature. A command is a check by the tool it runs (`vitest`, `tsc`,
 * `cargo clippy`) or by the script name a package or task runner is handed
 * (`npm run typecheck`, `nx run-many -t test`); one it doesn't know is no check, never
 * a guessed one. IO-free — the unit tests target this directly.
 */

/** A command rides every transcript read over IPC: a heredoc script must not */
const MAX_COMMAND = 300
/** Lines kept from the end of a run's output, and the width of each */
const OUTPUT_LINES = 12
const OUTPUT_LINE_CHARS = 240
/** How much of the output's end a runner's failure summary is looked for in */
const SUMMARY_TAIL = 8_192

/** Tools whose name alone says which check they are */
const TOOLS: Readonly<Record<string, CheckKind>> = {
  vitest: 'tests',
  jest: 'tests',
  mocha: 'tests',
  ava: 'tests',
  pytest: 'tests',
  'py.test': 'tests',
  rspec: 'tests',
  phpunit: 'tests',
  ctest: 'tests',
  tox: 'tests',
  nox: 'tests',
  tsc: 'types',
  'vue-tsc': 'types',
  'svelte-check': 'types',
  mypy: 'types',
  pyright: 'types',
  basedpyright: 'types',
  eslint: 'lint',
  oxlint: 'lint',
  stylelint: 'lint',
  ruff: 'lint',
  flake8: 'lint',
  pylint: 'lint',
  'golangci-lint': 'lint',
  rubocop: 'lint',
  shellcheck: 'lint',
  markdownlint: 'lint',
  'markdownlint-cli2': 'lint',
  actionlint: 'lint',
  swiftlint: 'lint',
  ktlint: 'lint',
  xcodebuild: 'build',
  'electron-builder': 'build'
}

/** Tools whose first subcommand says it: `go test`, `cargo clippy`, `playwright test` */
const SUBCOMMANDS: Readonly<Record<string, Readonly<Record<string, CheckKind>>>> = {
  go: { test: 'tests', vet: 'lint', build: 'build' },
  cargo: { test: 'tests', nextest: 'tests', clippy: 'lint', check: 'types', build: 'build' },
  dotnet: { test: 'tests', build: 'build' },
  swift: { test: 'tests', build: 'build' },
  deno: { test: 'tests', lint: 'lint', check: 'types' },
  mvn: { test: 'tests', verify: 'tests', compile: 'build', package: 'build', install: 'build' },
  gradle: { test: 'tests', check: 'tests', build: 'build', assemble: 'build' },
  gradlew: { test: 'tests', check: 'tests', build: 'build', assemble: 'build' },
  make: { test: 'tests', check: 'tests', lint: 'lint', build: 'build', all: 'build' },
  playwright: { test: 'e2e' },
  cypress: { run: 'e2e' },
  biome: { check: 'lint', lint: 'lint', ci: 'lint' },
  vite: { build: 'build' },
  next: { build: 'build', lint: 'lint' },
  nuxt: { build: 'build' },
  astro: { build: 'build', check: 'types' },
  'electron-vite': { build: 'build' },
  docker: { build: 'build' }
}

/** Package runners: what follows is a script of the package, a command of their own, or a tool */
const PACKAGE_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
/** Their own commands — never a script, even where a bare word would be one */
const RUNNER_COMMANDS = new Set([
  'install', 'i', 'ci', 'add', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade', 'outdated',
  'audit', 'view', 'info', 'ls', 'list', 'why', 'link', 'unlink', 'pack', 'publish', 'version',
  'init', 'create', 'config', 'cache', 'dedupe', 'prune', 'store', 'import', 'patch', 'env'
])
/** Their flags that take a value, which is never the script */
const RUNNER_VALUE_FLAGS = new Set(['--filter', '-F', '--workspace', '-w', '--prefix', '--dir', '-C', '--cwd'])
/** Task runners: what follows names targets */
const TASK_RUNNERS = new Set(['nx', 'turbo'])
/** Words that only run whatever follows them */
const WRAPPERS = new Set(['time', 'nice', 'nohup', 'env', 'sudo', 'command', 'exec', 'caffeinate'])
/** Runners of a tool: `npx vitest`, `uv run pytest`, `bundle exec rspec` */
const TOOL_RUNNERS: Readonly<Record<string, readonly string[]>> = {
  npx: [],
  bunx: [],
  uvx: [],
  pipx: ['run'],
  uv: ['run'],
  poetry: ['run'],
  pipenv: ['run'],
  hatch: ['run'],
  pdm: ['run'],
  rye: ['run'],
  bundle: ['exec']
}

/** A package script's name, read for the check it runs: `test:unit`, `typecheck`, `lint:fix`… */
export function scriptKind(name: string): CheckKind | null {
  const s = name.toLowerCase()
  if (/(^|[:_.-])e2e($|[:_.-])/.test(s) || /playwright|cypress/.test(s)) return 'e2e'
  if (/^(test|tests|spec)($|[:_.-])/.test(s)) return 'tests'
  if (/^(typecheck|type-check|check-types|check:types|types(:check)?|tsc)($|[:_.-])/.test(s)) return 'types'
  if (/^lint($|[:_.-])/.test(s) || /^(format|fmt|prettier):check$/.test(s)) return 'lint'
  if (/^(build|compile)($|[:_.-])/.test(s)) return 'build'
  return null
}

/** A table's own entry: a command word like `constructor` must not reach Object's prototype */
function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined
}

/** The command word of a path: `./node_modules/.bin/vitest` is `vitest` */
function base(token: string): string {
  return token.split('/').pop() ?? token
}

const isFlag = (t: string): boolean => t.startsWith('-')

/** A tool and its arguments: which check they run, if any. */
function toolKinds(tokens: readonly string[]): CheckKind[] {
  const [head, ...rest] = tokens
  if (!head) return []
  const tool = base(head)
  const named = own(TOOLS, tool)
  if (named) return [named]
  if (tool === 'prettier') return rest.some((t) => t === '--check' || t === '-c') ? ['lint'] : []
  const sub = own(SUBCOMMANDS, tool)
  if (sub) {
    const word = rest.find((t) => !isFlag(t))
    const kind = word ? own(sub, word) : undefined
    return kind ? [kind] : []
  }
  if (/^python\d*(\.\d+)?$/.test(tool) && rest[0] === '-m') return toolKinds(rest.slice(1))
  const runnerWords = own(TOOL_RUNNERS, tool)
  if (runnerWords) {
    // the runner's own flags and word come first; the tool keeps its own arguments
    let args = rest
    for (const word of runnerWords) {
      while (args[0] !== undefined && isFlag(args[0])) args = args.slice(1)
      if (args[0] === word) args = args.slice(1)
    }
    while (args[0] !== undefined && isFlag(args[0])) args = args.slice(1)
    return toolKinds(args)
  }
  if (PACKAGE_RUNNERS.has(tool)) return packageKinds(tool, rest)
  if (TASK_RUNNERS.has(tool)) return taskKinds(rest)
  return []
}

/** `npm test`, `npm run typecheck`, `pnpm lint`, `pnpm exec vitest`, `yarn --filter web build` */
function packageKinds(runner: string, args: readonly string[]): CheckKind[] {
  const words: string[] = []
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!
    if (RUNNER_VALUE_FLAGS.has(t)) i++
    else if (!isFlag(t)) words.push(t)
  }
  const [first, ...more] = words
  if (!first) return []
  if (first === 'run' || first === 'run-script') {
    const kind = more[0] ? scriptKind(more[0]) : null
    return kind ? [kind] : []
  }
  // a tool keeps its own arguments, flags and all: `pnpm exec prettier --check .`
  const from = (word: string): readonly string[] => args.slice(args.indexOf(word) + 1)
  if (first === 'exec' || first === 'dlx' || first === 'x') return toolKinds(from(first))
  // `bun test` is bun's own runner; for the others it is the package's test script
  if (first === 'test' || first === 't' || first === 'tst') return ['tests']
  if (runner === 'npm' || RUNNER_COMMANDS.has(first)) return []
  // pnpm, yarn and bun run a script by its bare name, else a dependency's binary
  const kind = scriptKind(first)
  return kind ? [kind] : toolKinds([first, ...from(first)])
}

/** `nx test web`, `nx run web:lint`, `nx run-many -t test lint`, `turbo run build` */
function taskKinds(args: readonly string[]): CheckKind[] {
  const targets: string[] = []
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!
    if (t === '-t' || t === '--target' || t === '--targets') {
      // the targets run to the next flag, space- or comma-separated
      for (i++; i < args.length && !isFlag(args[i]!); i++) targets.push(...args[i]!.split(','))
      i--
    } else if (t.startsWith('--targets=') || t.startsWith('--target=')) {
      targets.push(...t.slice(t.indexOf('=') + 1).split(','))
    }
  }
  const words = args.filter((t) => !isFlag(t))
  if (targets.length === 0 && words[0] === 'run' && words[1]?.includes(':')) targets.push(words[1].split(':')[1]!)
  else if (targets.length === 0 && words[0] === 'run') targets.push(...words.slice(1))
  else if (targets.length === 0 && words[0] && !['run-many', 'affected', 'graph', 'show'].includes(words[0]))
    targets.push(words[0])
  return targets.flatMap((t) => {
    const kind = scriptKind(t)
    return kind ? [kind] : []
  })
}

/** One simple command of a script, its words with the assignments and wrappers in front dropped. */
function commandWords(segment: string): string[] {
  const words = segment
    .replace(/^[\s(]+|[\s)]+$/g, '')
    .split(/\s+/)
    .filter(Boolean)
    // redirections are not arguments: `2>&1`, `>/dev/null`
    .filter((w) => !/^\d*[<>]/.test(w))
  let i = 0
  while (i < words.length) {
    const w = words[i]!
    if (/^[A-Za-z_]\w*=/.test(w) || WRAPPERS.has(w)) i++
    else if (w === 'timeout' || w === 'gtimeout') i += 2
    else break
  }
  return words.slice(i)
}

/** The checks a shell script runs, in its order and each once: `npm run typecheck && npm test`. */
export function checkKinds(script: string): CheckKind[] {
  const out: CheckKind[] = []
  // `&&`, `||`, `;`, pipes and lines all separate commands; quoting is not tracked, so
  // a separator inside a quoted argument only splits that argument
  for (const segment of script.split(/&&|\|\||[;|\n]/)) {
    for (const kind of toolKinds(commandWords(segment))) if (!out.includes(kind)) out.push(kind)
  }
  return out
}

/** Commands that only set the stage — their status is never what a script is judged by */
const SETUP = new Set(['cd', 'pushd', 'popd', 'export', 'unset', 'set', 'source', '.', 'echo', 'printf', 'true', ':', 'sleep'])

/**
 * Whether a script's exit status is its checks' own: every command in it is a check or
 * a setup step, and no check hands its output down a pipe (a pipeline exits with its
 * last command's status — `tail`'s, or `grep`'s when nothing matched). Anything else
 * could be what failed: the rebase before the tests, the script after the build.
 */
export function exitIsTheChecks(script: string): boolean {
  for (const statement of script.split(/&&|\|\||[;\n]/)) {
    const stages = statement.split('|')
    if (stages.length > 1 && toolKinds(commandWords(stages[0]!)).length > 0) return false
    for (const stage of stages) {
      const words = commandWords(stage)
      if (words.length === 0 || SETUP.has(words[0]!) || toolKinds(words).length > 0) continue
      return false
    }
  }
  return true
}

/**
 * The script from its first check on: the `cd` and `export PATH=…` an agent puts in
 * front of every command say nothing about the check, and would fill its lines.
 */
function fromFirstCheck(script: string): string {
  const parts = script.split(/(&&|\|\||[;|\n])/)
  let at = 0
  for (let i = 0; i < parts.length; i += 2) {
    if (toolKinds(commandWords(parts[i]!)).length > 0) return script.slice(at).trim()
    at += parts[i]!.length + (parts[i + 1]?.length ?? 0)
  }
  return script.trim()
}

/** A shell call's script as a check, before anything has been read of how it ended. */
export function checkArtifact(script: unknown): WorkArtifact | undefined {
  if (typeof script !== 'string' || !script.trim()) return undefined
  const checks = checkKinds(script)
  if (checks.length === 0) return undefined
  return {
    kind: 'check',
    checks,
    command: truncate(fromFirstCheck(script), MAX_COMMAND),
    ...(exitIsTheChecks(script) ? { ownExit: true } : {})
  }
}

/**
 * The exit code a shell result states in its text: Claude's `Exit code 1` first line,
 * Copilot's `<exited with exit code 1>` / `<shellId: 7 completed with exit code 1>`
 * markers, Codex's `Process exited with code 1`, or an older Codex result's JSON
 * `metadata.exit_code`. Null when it states none.
 */
export function exitCodeIn(text: string): number | null {
  const m =
    /^Exit code (\d+)/.exec(text) ??
    /<(?:exited|shellId: \S+ completed) with exit code (\d+)>/.exec(text) ??
    /Process exited with code (\d+)/.exec(text)
  if (m) return Number(m[1])
  if (text.trimStart().startsWith('{')) {
    try {
      const code = (JSON.parse(text) as { metadata?: { exit_code?: unknown } })?.metadata?.exit_code
      return typeof code === 'number' ? code : null
    } catch {
      return null
    }
  }
  return null
}

/** What a result says the command printed, without the markers the CLIs wrap it in. */
function printed(text: string): string {
  let t = text
    .replace(/^Exit code \d+\n?/, '')
    // Claude's note that it put the shell back where it was
    .replace(/\n?Shell cwd was reset to [^\n]*\s*$/, '')
    .replace(/\n?<(?:exited|shellId: \S+ completed) with exit code \d+>\s*$/, '')
  // Codex's exec_command: a header of ids and timings, then `Output:`
  const at = t.indexOf('\nOutput:\n')
  if (at >= 0 && /Process exited with code|Wall time/.test(t.slice(0, at))) t = t.slice(at + '\nOutput:\n'.length)
  if (t.trimStart().startsWith('{')) {
    try {
      const output = (JSON.parse(t) as { output?: unknown })?.output
      if (typeof output === 'string') t = output
    } catch {
      /* not the JSON form */
    }
  }
  return t
}

/**
 * A runner's own words for a failure, which survive the pipe that swallowed its exit
 * code: vitest, jest, pytest, playwright and mocha counts, tsc's errors, eslint's
 * problems, go's and cargo's verdicts, a bundler's failed build, and the line npm,
 * pnpm and yarn print when the script they ran exited non-zero.
 */
const FAILURE_SUMMARIES: readonly RegExp[] = [
  /\b[1-9]\d* (failed|failing|failures?)\b/,
  /\berror TS\d+:/,
  /\bFound [1-9]\d* errors?\b/,
  /\u2716 [1-9]\d* problems? \([1-9]\d* errors?/,
  /^(--- )?FAIL\b/m,
  /\btest result: FAILED\b/,
  /\berror: could not compile\b/,
  /\berror during build\b|\bBuild failed\b/i,
  /\bELIFECYCLE\b|Lifecycle script `[^`]+` failed|\bCommand failed with exit code [1-9]/
]

export function reportsFailure(output: string): boolean {
  const tail = output.slice(-SUMMARY_TAIL)
  return FAILURE_SUMMARIES.some((re) => re.test(tail))
}

/** The last lines a run printed, each cut to a readable width — its spacing kept, since a
 *  runner aligns its summary and indents its stack traces. */
function lastLines(output: string): string[] {
  const lines = output.replace(/\r\n/g, '\n').split('\n').filter((l) => l.trim())
  return lines.slice(-OUTPUT_LINES).map((raw) => {
    const l = raw.replace(/\t/g, '  ').trimEnd()
    return l.length > OUTPUT_LINE_CHARS ? `${Array.from(l).slice(0, OUTPUT_LINE_CHARS - 1).join('')}…` : l
  })
}

/**
 * How a check ended, from a result that says how. A runner's failure summary in the
 * output fails it always — a zero exit through a pipe is not a pass. A non-zero exit
 * fails it only when nothing else in the script could have exited so (`ownExit`); a zero
 * exit passes it. A result with no exit code and no summary is no verdict (a command
 * still running in the background, a truncated read), never a guessed pass.
 */
export function checkOutcome(
  a: WorkArtifact,
  result: { readonly text: string; readonly exitCode: number | null }
): WorkArtifact {
  if (a.kind !== 'check') return a
  const output = printed(result.text)
  const nonZero = result.exitCode !== null && result.exitCode !== 0
  const failed = reportsFailure(output) || (nonZero && a.ownExit === true)
  const status = failed ? 'failed' : result.exitCode === 0 ? 'passed' : undefined
  const lines = lastLines(output)
  return {
    ...a,
    ...(status ? { status } : {}),
    ...(result.exitCode !== null ? { exitCode: result.exitCode } : {}),
    ...(lines.length > 0 ? { output: lines } : {})
  }
}

/**
 * A Codex command item as a check — `CommandExecution` in a rollout, `command_execution`
 * in the `exec --json` stream, the same fields in both: the command (an argv or a shell
 * string), what it printed and its exit code.
 */
export function commandItemCheck(item: unknown): WorkArtifact | undefined {
  const i = item && typeof item === 'object' ? (item as Record<string, unknown>) : null
  const a = checkArtifact(shellScript(i?.command))
  if (!a || !i) return a
  const output =
    typeof i.aggregated_output === 'string'
      ? i.aggregated_output
      : [i.stdout, i.stderr].filter((s): s is string => typeof s === 'string' && s !== '').join('\n')
  // an item still running has neither yet
  if (typeof i.exit_code !== 'number' && !output) return a
  return checkOutcome(a, { text: output, exitCode: typeof i.exit_code === 'number' ? i.exit_code : null })
}
