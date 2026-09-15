import { describe, expect, it } from 'vitest'
import {
  parseAheadBehind,
  parseGitHeaderPaths,
  parseNumstat,
  parseStatus,
  parseUnifiedDiff,
  pickBase,
  unquotePath,
  untrackedFile,
  withNumstat
} from '../src/main/diff-core'

/* Real `git diff` output shapes, captured verbatim — the parser follows git, not a spec. */

const MODIFIED = `diff --git a/src/a.ts b/src/a.ts
index 3b18e51..a1b2c3d 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,5 @@ export function a
 line one
-line two
+line two changed
+line two and a half
 line three
 line four
@@ -20,3 +21,3 @@
 twenty
-twenty-one
+twenty one
 twenty-two
\\ No newline at end of file
`

const ADDED_DELETED_RENAMED = `diff --git a/new.txt b/new.txt
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+hello
+world
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index e69de29..0000000
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/old-name.ts b/new-name.ts
similarity index 90%
rename from old-name.ts
rename to new-name.ts
index 1111111..2222222 100644
--- a/old-name.ts
+++ b/new-name.ts
@@ -3 +3 @@
-x
+y
diff --git a/img.png b/img.png
new file mode 100644
index 0000000..abcdef0
Binary files /dev/null and b/img.png differ
`

describe('parseUnifiedDiff', () => {
  it('numbers both sides of every line across hunks', () => {
    const { files } = parseUnifiedDiff(MODIFIED)
    expect(files).toHaveLength(1)
    const f = files[0]
    expect(f.path).toBe('src/a.ts')
    expect(f.status).toBe('modified')
    expect(f.oldPath).toBeNull()
    expect(f.hunks).toHaveLength(2)
    expect(f.hunks[0].header).toBe('export function a')
    expect(f.hunks[0]).toMatchObject({ oldStart: 1, oldCount: 4, newStart: 1, newCount: 5 })
    expect(f.hunks[0].lines.map((l) => [l.op, l.oldNo, l.newNo])).toEqual([
      ['same', 1, 1],
      ['del', 2, null],
      ['add', null, 2],
      ['add', null, 3],
      ['same', 3, 4],
      ['same', 4, 5]
    ])
    // the "\ No newline" marker is metadata, never a line
    expect(f.hunks[1].lines.map((l) => l.text)).toEqual(['twenty', 'twenty-one', 'twenty one', 'twenty-two'])
    expect(f.added).toBe(3)
    expect(f.removed).toBe(2)
    expect(f.truncated).toBe(false)
  })

  it('reads additions, deletions, renames and binary files', () => {
    const { files, droppedFiles } = parseUnifiedDiff(ADDED_DELETED_RENAMED)
    expect(droppedFiles).toBe(0)
    expect(files.map((f) => [f.path, f.status, f.oldPath, f.binary])).toEqual([
      ['new.txt', 'added', null, false],
      ['gone.txt', 'deleted', null, false],
      ['new-name.ts', 'renamed', 'old-name.ts', false],
      ['img.png', 'added', null, true]
    ])
    expect(files[0].hunks[0].lines.map((l) => l.newNo)).toEqual([1, 2])
    expect(files[1].hunks[0].lines[0]).toMatchObject({ op: 'del', oldNo: 1, newNo: null })
    expect(files[3].hunks).toEqual([])
  })

  it('cuts a file at the per-file cap and flags it, keeping the others whole', () => {
    const body = Array.from({ length: 10 }, (_, i) => `+l${i}`).join('\n')
    const big = `diff --git a/big b/big\n--- a/big\n+++ b/big\n@@ -0,0 +1,10 @@\n${body}\n@@ -50,0 +61,1 @@\n+later\n`
    const small = `diff --git a/small b/small\n--- a/small\n+++ b/small\n@@ -1 +1 @@\n-a\n+b\n`
    const { files } = parseUnifiedDiff(big + small, { maxLinesPerFile: 4, maxLinesTotal: 100, maxFiles: 10 })
    expect(files[0].truncated).toBe(true)
    expect(files[0].hunks).toHaveLength(1)
    expect(files[0].hunks[0].lines).toHaveLength(4)
    expect(files[1].truncated).toBe(false)
    expect(files[1].hunks[0].lines).toHaveLength(2)
  })

  it('drops files past the listing cap and counts them', () => {
    const one = (n: string): string => `diff --git a/${n} b/${n}\n--- a/${n}\n+++ b/${n}\n@@ -1 +1 @@\n-a\n+b\n`
    const { files, droppedFiles } = parseUnifiedDiff(one('x') + one('y') + one('z'), {
      maxLinesPerFile: 10,
      maxLinesTotal: 100,
      maxFiles: 2
    })
    expect(files.map((f) => f.path)).toEqual(['x', 'y'])
    expect(droppedFiles).toBe(1)
  })

  it('ships later files without hunks once the total budget is spent', () => {
    const one = (n: string): string => `diff --git a/${n} b/${n}\n--- a/${n}\n+++ b/${n}\n@@ -1,2 +1,2 @@\n-a\n+b\n-c\n+d\n`
    const { files } = parseUnifiedDiff(one('x') + one('y'), { maxLinesPerFile: 10, maxLinesTotal: 4, maxFiles: 10 })
    expect(files[0].hunks[0].lines).toHaveLength(4)
    expect(files[1].hunks[0].lines).toHaveLength(0)
    expect(files[1].truncated).toBe(true)
  })

  it('tolerates garbage and an empty diff', () => {
    expect(parseUnifiedDiff('').files).toEqual([])
    expect(parseUnifiedDiff('not a diff\n@@ nonsense\n+stray\n').files).toEqual([])
  })
})

describe('paths', () => {
  it('reads the diff --git header even when the path has spaces', () => {
    expect(parseGitHeaderPaths('a/my file.txt b/my file.txt')).toEqual({ a: 'my file.txt', b: 'my file.txt' })
    expect(parseGitHeaderPaths('a/x b/y')).toEqual({ a: 'x', b: 'y' })
    expect(parseGitHeaderPaths('nonsense')).toBeNull()
  })

  it('unquotes the C-style paths git emits for unusual bytes', () => {
    expect(unquotePath('"a/sp\\303\\244ce\\ttab.txt"')).toBe('a/späce\ttab.txt')
    expect(unquotePath('plain/path.ts')).toBe('plain/path.ts')
    expect(parseGitHeaderPaths('"a/q\\"uote" "b/q\\"uote"')).toEqual({ a: 'q"uote', b: 'q"uote' })
  })
})

describe('numstat', () => {
  it('keys totals by the landing path, renames included, binary as zero', () => {
    const stat = parseNumstat('3\t1\tsrc/a.ts\0-\t-\timg.png\x000\t0\t\0old.ts\0new.ts\0')
    expect(stat.get('src/a.ts')).toEqual({ added: 3, removed: 1, binary: false })
    expect(stat.get('img.png')).toEqual({ added: 0, removed: 0, binary: true })
    expect(stat.get('new.ts')).toEqual({ added: 0, removed: 0, binary: false })
    expect(stat.has('old.ts')).toBe(false)
  })

  it('overrides hunk counts (right even past the caps) and leaves unknown files alone', () => {
    const { files } = parseUnifiedDiff(MODIFIED)
    const [f] = withNumstat(files, new Map([['src/a.ts', { added: 300, removed: 2, binary: false }]]))
    expect(f.added).toBe(300)
    expect(withNumstat(files, new Map())[0].added).toBe(3)
  })
})

describe('branch state', () => {
  it('reads ahead/behind from rev-list --left-right --count', () => {
    expect(parseAheadBehind('2\t5\n')).toEqual({ behind: 2, ahead: 5 })
    expect(parseAheadBehind('')).toEqual({ ahead: 0, behind: 0 })
  })

  it('prefers the remote HEAD, then the usual names remote-first', () => {
    expect(pickBase('origin/develop', ['main'])).toBe('origin/develop')
    expect(pickBase(null, ['main', 'origin/master'])).toBe('origin/master')
    expect(pickBase(null, ['master'])).toBe('master')
    expect(pickBase(null, [])).toBeNull()
  })

  it('reads porcelain -z: untracked paths, dirtiness, and rename pairs', () => {
    const s = parseStatus(' M a.ts\0?? new.txt\0R  new.ts\0old.ts\0?? dir/x\0')
    expect(s.dirty).toBe(true)
    expect(s.untracked).toEqual(['new.txt', 'dir/x'])
    expect(parseStatus('')).toEqual({ dirty: false, untracked: [] })
  })
})

describe('untrackedFile', () => {
  it('draws a text file as one all-added hunk', () => {
    const f = untrackedFile('notes.md', Buffer.from('# hi\n\nbody\n'))
    expect(f).toMatchObject({ status: 'added', untracked: true, binary: false, added: 3, removed: 0 })
    expect(f.hunks[0].lines.map((l) => [l.text, l.newNo])).toEqual([
      ['# hi', 1],
      ['', 2],
      ['body', 3]
    ])
  })

  it('marks binaries and caps long files', () => {
    expect(untrackedFile('x.bin', Buffer.from([1, 0, 2])).binary).toBe(true)
    const long = untrackedFile('long.txt', Buffer.from('a\nb\nc\n'), { maxLines: 2 })
    expect(long.truncated).toBe(true)
    expect(long.added).toBe(3)
    expect(long.hunks[0].lines).toHaveLength(2)
    expect(untrackedFile('empty', Buffer.alloc(0)).hunks).toEqual([])
  })
})
