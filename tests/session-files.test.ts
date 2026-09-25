import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertSharedFile,
  MAX_IMAGE_BYTES,
  MAX_TEXT_BYTES,
  openSharedFile,
  readSharedFile,
  type FileShell
} from '../src/main/session-files'
import type { SessionMessage, SessionMeta } from '../src/shared/types'

// the real path: macOS's tmpdir is itself a link (/var → /private/var)
const root = realpathSync(mkdtempSync(join(tmpdir(), 'cockpit-session-files-')))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const file = (name: string, content: string | Buffer): string => {
  const p = join(root, name)
  writeFileSync(p, content)
  return p
}

/** A session whose log shared these files, as the indexer would hand it over. */
function sessions(shared: readonly string[], cwd: string | null = root) {
  const meta = { id: 'claude:s1', cwd } as SessionMeta
  const messages: SessionMessage[] = [
    { role: 'assistant', kind: 'tool_call', toolName: 'SendUserFile', text: '{}', artifact: { kind: 'shared', files: shared, links: [] } }
  ]
  return { getSession: (id: string) => (id === meta.id ? meta : null), getMessages: () => messages }
}

describe('assertSharedFile: only what the session shared', () => {
  const shot = file('shot.png', 'png')

  it('passes a path the session’s log shared, relative ones resolved against its directory', () => {
    expect(assertSharedFile(sessions([shot]), 'claude:s1', shot)).toBe(shot)
    expect(assertSharedFile(sessions(['shot.png']), 'claude:s1', shot)).toBe(shot)
  })

  it('refuses any other path, and an unknown session', () => {
    expect(() => assertSharedFile(sessions([shot]), 'claude:s1', '/etc/passwd')).toThrow(/did not share/)
    expect(() => assertSharedFile(sessions([shot]), 'claude:nope', shot)).toThrow(/Unknown session/)
    // the renderer's argument is coerced, never trusted for its type
    expect(() => assertSharedFile(sessions([shot]), 'claude:s1', { toString: () => '/etc/passwd' })).toThrow()
  })
})

describe('readSharedFile: a bounded preview', () => {
  it('sends an image whole, with the type a blob needs', () => {
    const p = file('a.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const r = readSharedFile(p)
    expect(r).toMatchObject({ kind: 'image', mime: 'image/png', size: 4, openable: true })
    expect(r.kind === 'image' && Array.from(r.data)).toEqual([0x89, 0x50, 0x4e, 0x47])
  })

  it('reads the head of text, and says when there is more', () => {
    expect(readSharedFile(file('notes.md', '# Report\n\nAll green.\n'))).toEqual({
      kind: 'text',
      text: '# Report\n\nAll green.\n',
      truncated: false,
      markdown: true,
      size: 21,
      openable: true
    })
    const long = readSharedFile(file('run.log', 'x'.repeat(MAX_TEXT_BYTES + 10)))
    expect(long).toMatchObject({ kind: 'text', truncated: true, markdown: false })
    expect(long.kind === 'text' && long.text.length).toBe(MAX_TEXT_BYTES)
  })

  it('draws no binary, no page source, and no image too large to send', () => {
    expect(readSharedFile(file('blob.bin', Buffer.from([1, 0, 2])))).toEqual({ kind: 'other', size: 3, reason: 'kind', openable: false })
    expect(readSharedFile(file('report.html', '<p>hi</p>'))).toMatchObject({ kind: 'other', reason: 'kind', openable: true })
    const big = file('big.png', '')
    truncateSync(big, MAX_IMAGE_BYTES + 1)
    expect(readSharedFile(big)).toMatchObject({ kind: 'other', reason: 'size', openable: true })
  })

  it('says a file is gone, and a directory is no file', () => {
    expect(readSharedFile(join(root, 'never.png'))).toEqual({ kind: 'missing' })
    mkdirSync(join(root, 'dir.png'), { recursive: true })
    expect(readSharedFile(join(root, 'dir.png'))).toEqual({ kind: 'missing' })
  })
})

describe('openSharedFile: documents and images, or Finder', () => {
  const shell = (): FileShell & { opened: string[]; shown: string[] } => {
    const opened: string[] = []
    const shown: string[] = []
    return {
      opened,
      shown,
      openPath: vi.fn(async (p: string) => {
        opened.push(p)
        return ''
      }),
      showItemInFolder: vi.fn((p: string) => void shown.push(p))
    }
  }

  it('opens a document in its app, and shows anything in Finder', async () => {
    const s = shell()
    const pdf = file('spec.pdf', '%PDF')
    expect(await openSharedFile(pdf, 'open', s)).toBeNull()
    const script = file('run.command', '#!/bin/sh\necho hi\n')
    expect(await openSharedFile(script, 'reveal', s)).toBeNull()
    expect(s.opened).toEqual([pdf])
    expect(s.shown).toEqual([script])
  })

  it('never opens what would run — judged on the file a link really is', async () => {
    const s = shell()
    const script = file('go.command', '#!/bin/sh\n')
    expect(await openSharedFile(script, 'open', s)).toMatch(/documents and images only/)
    const disguised = join(root, 'shot-link.png')
    symlinkSync(script, disguised)
    expect(await openSharedFile(disguised, 'open', s)).toMatch(/documents and images only/)
    expect(s.opened).toEqual([])
  })

  it('says a file is gone rather than opening nothing', async () => {
    const s = shell()
    expect(await openSharedFile(join(root, 'gone.png'), 'open', s)).toMatch(/no longer on disk/)
    expect(await openSharedFile(join(root, 'gone.png'), 'reveal', s)).toMatch(/no longer on disk/)
  })

  it('passes on what the OS said when it could not open one', async () => {
    const s = { openPath: async () => 'No application knows how to open it', showItemInFolder: () => {} }
    expect(await openSharedFile(file('x.md', '#'), 'open', s)).toBe('No application knows how to open it')
  })
})
