import { describe, it, expect } from 'vitest'
import { cellToolCalls } from '../src/main/parsers/code-mode'

describe('cellToolCalls: the tools a code-mode cell calls', () => {
  it('reads a call and the literal fields of its argument', () => {
    const cell = `const r = await tools.exec_command({cmd:"sed -n '1,220p' README.md", workdir: "/r", max_output_tokens: 4000, login: false}); text(r.output)\n`
    expect(cellToolCalls(cell)).toEqual([
      { name: 'exec_command', input: { cmd: "sed -n '1,220p' README.md", workdir: '/r', max_output_tokens: 4000, login: false } }
    ])
  })

  it('finds every call in the order written, nested in Promise.all or not', () => {
    const cell = [
      'const results = await Promise.allSettled([',
      '  tools.exec_command({"cmd":"git status --short --branch","workdir":"/r"}),',
      "  tools.web__run({search_query:[{q:'site:nx.dev remote cache'}],response_length:\"long\"}),",
      '  tools.mcp__node_repl__js({code: "1 + 1", title: \'Add\'})',
      ']); results.forEach((r) => text(r))'
    ].join('\n')
    const calls = cellToolCalls(cell)
    expect(calls.map((c) => c.name)).toEqual(['exec_command', 'web__run', 'mcp__node_repl__js'])
    expect(calls[0]!.input).toEqual({ cmd: 'git status --short --branch', workdir: '/r' })
    // an array is not a literal the reader keeps; the string beside it is
    expect(calls[1]!.input).toEqual({ response_length: 'long' })
    expect(calls[2]!.input).toEqual({ code: '1 + 1', title: 'Add' })
  })

  it('unescapes strings, and keeps a template substitution as written', () => {
    const cell =
      'const p = "/r";\n' +
      'text(await tools.apply_patch(`*** Begin Patch\\n*** Update File: ${p}/src/a.ts\\n@@\\n-a\\n+b\\n*** End Patch`));\n' +
      'await tools.exec_command({cmd: "printf \'%s\\\\n\' \\"a\\tb\\" \\u00e9"})'
    const calls = cellToolCalls(cell)
    expect(calls[0]).toEqual({
      name: 'apply_patch',
      input: '*** Begin Patch\n*** Update File: ${p}/src/a.ts\n@@\n-a\n+b\n*** End Patch'
    })
    expect(calls[1]!.input).toEqual({ cmd: 'printf \'%s\\n\' "a\tb" é' })
  })

  it('skips what only running the cell could answer', () => {
    const cell = [
      'for (const c of cmds) await tools.exec_command({cmd: c, workdir});',
      'await tools.exec_command({cmd: "npm " + script, ...opts, [key]: "x", yield_time_ms: 1e3});',
      'await tools.write_stdin(session)'
    ].join('\n')
    expect(cellToolCalls(cell)).toEqual([
      { name: 'exec_command', input: {} },
      { name: 'exec_command', input: {} },
      { name: 'write_stdin', input: null }
    ])
  })

  it('is not fooled by strings, comments or regexes that mention a call', () => {
    const cell = [
      '// tools.old_way({cmd: "no"})',
      '/* tools.also_not({}) */',
      'const hits = ALL_TOOLS.filter(x => /node_repl"|tools\\.exec\\(/.test(x.name));',
      'const note = "tools.fake({cmd: 1})";',
      'x.tools.member({cmd: "not the tools global"});',
      'text(await tools.exec_command({cmd: `rg "tools.exec_command(" src`}))'
    ].join('\n')
    expect(cellToolCalls(cell)).toEqual([{ name: 'exec_command', input: { cmd: 'rg "tools.exec_command(" src' } }])
  })

  it('a cell calling no tool calls none', () => {
    expect(cellToolCalls('text(ALL_TOOLS.map((x) => x.name))')).toEqual([])
    expect(cellToolCalls('')).toEqual([])
  })

  it('never throws on a cell that does not parse, and keeps what came before the damage', () => {
    const broken = [
      'await tools.exec_command({cmd: "git status"});',
      'await tools.exec_command({cmd: "unterminated',
      'await tools.exec_command({cmd: `open ${ template',
      'tools.',
      'tools.(',
      '{{{{(((['
    ].join('\n')
    const calls = cellToolCalls(broken)
    expect(calls[0]).toEqual({ name: 'exec_command', input: { cmd: 'git status' } })
    expect(calls.length).toBeGreaterThanOrEqual(1)
    // nested far past any stack: a thrown RangeError would be lost data, not a crash
    expect(() => cellToolCalls('`${'.repeat(20_000) + 'tools.exec_command({})')).not.toThrow()
    expect(() => cellToolCalls('({a: '.repeat(20_000))).not.toThrow()
  })

  it('reads a long cell only so far, and counts calls only so far', () => {
    const many = Array.from({ length: 100 }, (_, i) => `await tools.exec_command({cmd: "echo ${i}"});`).join('\n')
    expect(cellToolCalls(many)).toHaveLength(32)
    const late = `const pad = "${'x'.repeat(70 * 1024)}";\nawait tools.exec_command({cmd: "late"})`
    expect(cellToolCalls(late)).toEqual([])
  })
})
