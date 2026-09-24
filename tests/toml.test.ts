import { describe, it, expect } from 'vitest'
import { scanToml, tomlString, tomlValue, type TomlSection } from '../src/main/toml'

/*
 * The reader behind every edit Cockpit makes to Codex's config.toml. What matters is
 * not only the values but where each one sits: an edit is a splice at those offsets,
 * so a span that is off by one line corrupts the user's file.
 */

const find = (sections: TomlSection[], path: string): TomlSection => {
  const found = sections.find((s) => s.path.join('.') === path)
  if (!found) throw new Error(`no section ${path}`)
  return found
}

const valueOf = (sections: TomlSection[], path: string, key: string): unknown =>
  find(sections, path).keys.find((kv) => kv.key.join('.') === key)?.value

describe('scanToml', () => {
  it('reads every value form Codex configs use', () => {
    const text = [
      'model = "gpt-5"',
      '',
      '[mcp_servers.docs]',
      'command = \'C:\\tools\\docs.exe\'',
      'args = [',
      '  "-y",   # the runner flag',
      '  "docs-mcp@1.2.0",',
      ']',
      'env = { "API_KEY" = "k", PLAIN = "p" }',
      'startup_timeout_sec = 1_000',
      'enabled = true',
      'ratio = 0.5',
      'since = 1979-05-27T07:32:00Z',
      'tools.search.approve = false'
    ].join('\n')
    const sections = scanToml(text)
    expect(valueOf(sections, '', 'model')).toBe('gpt-5')
    expect(valueOf(sections, 'mcp_servers.docs', 'command')).toBe('C:\\tools\\docs.exe')
    expect(valueOf(sections, 'mcp_servers.docs', 'args')).toEqual(['-y', 'docs-mcp@1.2.0'])
    expect(valueOf(sections, 'mcp_servers.docs', 'env')).toEqual({ API_KEY: 'k', PLAIN: 'p' })
    expect(valueOf(sections, 'mcp_servers.docs', 'startup_timeout_sec')).toBe(1000)
    expect(valueOf(sections, 'mcp_servers.docs', 'enabled')).toBe(true)
    expect(valueOf(sections, 'mcp_servers.docs', 'ratio')).toBe(0.5)
    expect(valueOf(sections, 'mcp_servers.docs', 'since')).toBe('1979-05-27T07:32:00Z')
    expect(valueOf(sections, 'mcp_servers.docs', 'tools.search.approve')).toBe(false)
  })

  it('records where each value and each array element sits', () => {
    const text = '[a]\nargs = ["-y", "pkg@1.0.0"] # pinned\n'
    const kv = scanToml(text)[1].keys[0]
    expect(text.slice(kv.valueSpan.start, kv.valueSpan.end)).toBe('["-y", "pkg@1.0.0"]')
    expect(kv.items?.map((s) => text.slice(s.start, s.end))).toEqual(['"-y"', '"pkg@1.0.0"'])
    // the statement runs to the end of its line, trailing comment included
    expect(text.slice(kv.start, kv.end)).toBe('args = ["-y", "pkg@1.0.0"] # pinned\n')
  })

  // a line starting with `[` inside a multi-line string used to be taken for a table
  // header, splitting one table into two that neither Codex nor the user wrote
  it('never reads a header out of a multi-line string', () => {
    const text = [
      '[profiles.work]',
      'instructions = """',
      '[not a table]',
      'keep this',
      '"""',
      '',
      '[mcp_servers.x]',
      'command = "x"'
    ].join('\n')
    const sections = scanToml(text)
    expect(sections.map((s) => s.path.join('.'))).toEqual(['', 'profiles.work', 'mcp_servers.x'])
    expect(valueOf(sections, 'profiles.work', 'instructions')).toBe('[not a table]\nkeep this\n')
  })

  it('tiles the text: sections end where the next begins, comments go with their header', () => {
    const text = 'a = 1\n\n[one]\nb = 2\n\n# about two\n[two]\nc = 3\n'
    const sections = scanToml(text)
    expect(sections.map((s) => text.slice(s.start, s.end))).toEqual([
      'a = 1\n\n',
      '[one]\nb = 2\n\n',
      '# about two\n[two]\nc = 3\n'
    ])
  })

  it('skips a line it cannot read and keeps reading the rest', () => {
    const text = '[a]\nbroken = "no closing quote\nfine = 1\n=nonsense\n[b]\nok = "yes"\n'
    const sections = scanToml(text)
    expect(find(sections, 'a').keys.map((kv) => kv.key.join('.'))).toEqual(['fine'])
    expect(valueOf(sections, 'b', 'ok')).toBe('yes')
  })

  it('unescapes basic strings, and leaves literal strings alone', () => {
    const text = 'a = "tab\\tquote\\"\\u00e9"\nb = \'raw\\n\'\nc = """\\\n    joined"""\n'
    const sections = scanToml(text)
    expect(valueOf(sections, '', 'a')).toBe('tab\tquote"é')
    expect(valueOf(sections, '', 'b')).toBe('raw\\n')
    expect(valueOf(sections, '', 'c')).toBe('joined')
  })

  // a key read from a file is data: it must never become an object's prototype
  it('keeps a __proto__ key an ordinary key', () => {
    const table = valueOf(scanToml('t = { __proto__ = { polluted = true } }\n'), '', 't') as object
    expect(Object.getPrototypeOf(table)).toBe(Object.prototype)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.keys(table)).toEqual(['__proto__'])
  })
})

describe('writing values back', () => {
  it('escapes what a basic string cannot hold raw, and reads back the same', () => {
    const tricky = 'line one\nline "two"\t\\ \u0001'
    const written = tomlString(tricky)
    expect(written).not.toContain('\n')
    expect(valueOf(scanToml(`v = ${written}\n`), '', 'v')).toBe(tricky)
  })

  it('renders tables and arrays that read back as themselves', () => {
    const value = { 'a.b': ['x', 1, true], plain: { nested: 'y' } }
    expect(valueOf(scanToml(`v = ${tomlValue(value)}\n`), '', 'v')).toEqual(value)
  })
})
