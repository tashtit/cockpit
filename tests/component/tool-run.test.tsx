import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ChatView, foldToolRuns, runSummary } from '../../src/renderer/src/ChatView'
import type { ChatBinding } from '../../src/renderer/src/App'
import type { SessionMessage } from '../../src/shared/types'

const call = (toolName: string, text: string): SessionMessage => ({
  role: 'assistant',
  kind: 'tool_call',
  toolName,
  text,
  preview: text
})
const say = (text: string): SessionMessage => ({ role: 'assistant', kind: 'text', text })
const row = (m: SessionMessage, key: number) => ({ m, key })

const binding: ChatBinding = {
  provider: 'claude',
  cwd: '/tmp/wt',
  nativeSessionId: 'abc',
  title: 'fix the flake',
  branch: 'cockpit/fix',
  repoRoot: '/tmp/repo'
}

function renderChat(log: SessionMessage[], busy = false): void {
  render(
    <ChatView
      binding={binding}
      prs={[]}
      log={log}
      busy={busy}
      prBusy={false}
      onSend={vi.fn()}
      onCancel={vi.fn()}
      onCreatePr={vi.fn()}
      onOpenUrl={vi.fn()}
      onOpenHandoff={vi.fn()}
      onOpenLineage={vi.fn()}
    />
  )
}

describe('foldToolRuns', () => {
  it('leaves a couple of steps alone', () => {
    const rows = [row(call('Bash', 'npm test'), 0), row(call('Edit', 'a.ts'), 1)]
    expect(foldToolRuns(rows, false).every((b) => b.kind === 'row')).toBe(true)
  })

  it('folds four or more consecutive tool rows into one run', () => {
    const rows = [0, 1, 2, 3].map((i) => row(call('Bash', `step ${i}`), i))
    const blocks = foldToolRuns(rows, false)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe('run')
  })

  it('breaks a run where the agent speaks — prose is never swallowed', () => {
    const rows = [
      ...[0, 1, 2, 3].map((i) => row(call('Bash', `step ${i}`), i)),
      row(say('Here is what I found.'), 4),
      ...[5, 6, 7, 8].map((i) => row(call('Read', `file ${i}`), i))
    ]
    const blocks = foldToolRuns(rows, false)
    expect(blocks.map((b) => b.kind)).toEqual(['run', 'row', 'run'])
  })

  it('keeps the tail run open while the turn is still running', () => {
    const rows = [0, 1, 2, 3].map((i) => row(call('Bash', `step ${i}`), i))
    expect(foldToolRuns(rows, true).every((b) => b.kind === 'row')).toBe(true)
    // …but an earlier run in the same live turn still folds
    const withProse = [...rows, row(say('working'), 4), ...[5, 6, 7, 8].map((i) => row(call('Read', `f${i}`), i))]
    expect(foldToolRuns(withProse, true).map((b) => b.kind)).toEqual(['run', 'row', 'row', 'row', 'row', 'row'])
  })
})

describe('runSummary', () => {
  it('counts the steps and names the tools, most-used first in call order', () => {
    const rows = [
      row(call('Bash', 'npm test'), 0),
      row(call('Edit', 'a.ts'), 1),
      row(call('Bash', 'npm run lint'), 2),
      row(call('Read', 'b.ts'), 3)
    ]
    expect(runSummary(rows)).toBe('4 steps · Bash ×2 · Edit · Read')
  })
})

describe('ChatView work log', () => {
  it('folds a long run behind one line and opens to the rows', async () => {
    renderChat([
      say('Reproducing first.'),
      call('Bash', 'npm test -- login'),
      call('Read', '/tmp/wt/src/login.ts'),
      call('Edit', '/tmp/wt/src/login.ts'),
      call('Bash', 'npm test -- login'),
      say('Raised the retry budget.')
    ])

    // the prose stays visible; the steps are one line
    expect(screen.getByText('Reproducing first.')).toBeInTheDocument()
    const summary = screen.getByText(/^4 steps ·/)
    expect(screen.getAllByText('npm test -- login')[0]).not.toBeVisible()

    await userEvent.click(summary)
    expect(screen.getAllByText('npm test -- login')[0]).toBeVisible()
  })
})
