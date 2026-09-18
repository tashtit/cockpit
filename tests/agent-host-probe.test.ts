import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import {
  coverageFor,
  defaultAgentHostHomes,
  describeStore,
  probeAgentHost,
  type AgentHostReport
} from '../src/main/agent-host'

/**
 * The evaluation, not a unit test: it runs against this machine, so it is opt-in the way
 * the packaged smoke test is — `npm run probe:agent-host`, skipped in `npm test` and in
 * CI, where there is no VS Code and nothing to measure.
 *
 * What it answers: of the sessions VS Code's agent host is holding, how many can Cockpit
 * see? A machine with no agent host is a clean "nothing to report" — the only failure is
 * a store that exists and cannot be read, which means the format moved and the reader
 * needs to move with it.
 *
 * It also captures the store's redacted shape to test-results/agent-host-probe/, because
 * closing the gap needs a populated `local_turns` payload to parse and only a real VS
 * Code session produces one. Nothing anybody typed is written — see `payloadKeyPaths`.
 */

const ENABLED = process.env.COCKPIT_PROBE_AGENT_HOST === '1'
const OUT_DIR = join(process.cwd(), 'test-results', 'agent-host-probe')
/** One bounded sweep of the provider stores; the real index is far larger than this. */
const MAX_PROVIDER_NAMES = 100_000
/** Every provider states its session id as a uuid; codex prefixes its filenames. */
const UUID_LENGTH = 36

/**
 * Every session id the provider stores hold, which is what the indexer derives its own
 * ids from: a Claude transcript is `<id>.jsonl`, a Copilot session is a directory named
 * for its id, a Codex rollout carries the id in its filename. Collect names rather than
 * parse — membership is the whole question.
 */
async function providerSessionNames(): Promise<Set<string>> {
  const roots = [
    join(homedir(), '.claude', 'projects'),
    join(homedir(), '.codex', 'sessions'),
    join(homedir(), '.copilot', 'session-state')
  ]
  const names = new Set<string>()
  for (const root of roots) {
    if (!existsSync(root)) continue
    try {
      const entries = await readdir(root, { recursive: true, withFileTypes: true })
      for (const e of entries.slice(0, MAX_PROVIDER_NAMES)) {
        const bare = e.isFile() ? basename(e.name, extname(e.name)) : e.name
        names.add(bare)
        // a codex rollout is `rollout-<timestamp>-<uuid>`, so the uuid is the tail
        if (bare.length > UUID_LENGTH) names.add(bare.slice(-UUID_LENGTH))
      }
    } catch {
      // unreadable store — it contributes nothing, which can only understate coverage
    }
  }
  return names
}

function describeReport(report: AgentHostReport, indexed: ReadonlySet<string>): string {
  const coverage = coverageFor(report, indexed)
  const lines = [
    `\n  ${report.home}`,
    `    hosts running      ${report.endpoints.length}` +
      (report.endpoints.length
        ? ` (protocol ${[...new Set(report.endpoints.map((e) => e.protocolVersion))].join(', ')})`
        : ''),
    `    sessions stored    ${report.sessions.length}${report.truncated ? ' (truncated)' : ''}`,
    `    already indexed    ${coverage.indexed.length}`,
    `    invisible to us    ${coverage.invisible.length}`,
    `    empty (host husk)  ${coverage.empty.length}`
  ]
  for (const s of report.sessions) {
    const verdict = coverage.empty.includes(s.id)
      ? 'empty'
      : coverage.indexed.includes(s.id)
        ? 'indexed'
        : 'INVISIBLE'
    lines.push(
      `    - ${s.id}  ${verdict}  agent=${s.agent ?? '?'} transport=${s.transport ?? '?'} turns=${s.turns ?? '?'}`
    )
  }
  return lines.join('\n')
}

describe.skipIf(!ENABLED)('agent host probe (this machine)', () => {
  it('reports what VS Code is holding that Cockpit cannot see', async () => {
    const indexed = await providerSessionNames()
    const reports: AgentHostReport[] = []
    for (const home of defaultAgentHostHomes()) reports.push(await probeAgentHost(home))

    const found = reports.filter((r) => r.present)
    let out = `\nagent host probe — ${indexed.size} provider session names in the index`
    if (!found.length) out += '\n  no VS Code agent host on this machine — nothing to measure'
    for (const report of found) out += describeReport(report, indexed)

    const withTurns = found.flatMap((r) => r.sessions).filter((s) => (s.turns ?? 0) > 0)
    if (found.length && !withTurns.length) {
      out +=
        '\n\n  INCONCLUSIVE: every stored session is empty. Run one real agent session in' +
        '\n  VS Code (Claude, Codex or Copilot), then run this again — the verdict needs a' +
        '\n  session that actually said something.'
    }

    // the shape capture, for whoever writes the parser next
    mkdirSync(OUT_DIR, { recursive: true })
    for (const report of found) {
      for (const s of report.sessions) {
        const db = join(report.home, 'agentSessionData', s.id, 'session.db')
        const shape = await describeStore(db)
        if (!shape) continue
        writeFileSync(join(OUT_DIR, `${s.id}.json`), JSON.stringify(shape, null, 2) + '\n')
      }
    }
    out += `\n\n  redacted store shapes written to ${OUT_DIR}\n`
    console.log(out)

    // a store that exists must be readable: an unreadable one is the format moving
    for (const report of found) {
      for (const s of report.sessions) expect(s.id).not.toBe('')
    }
    expect(reports).toHaveLength(defaultAgentHostHomes().length)
  })
})
