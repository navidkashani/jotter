import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'

import {
  scanVault,
  clearVaultCache,
  extractEdges,
  splitFrontmatter,
  isPublished,
  resolveTitle,
} from '../src/lib/vault.js'
import { buildGraph, neighbourhood } from '../src/lib/graph.js'

const VAULT = fileURLToPath(new URL('./fixtures/vault', import.meta.url))
const scan = (opts: Partial<Parameters<typeof scanVault>[0]> = {}) => {
  clearVaultCache()
  return scanVault({ root: VAULT, ...opts })
}

describe('splitFrontmatter', () => {
  it('separates YAML from body', () => {
    const { frontmatter, body } = splitFrontmatter('---\ntitle: A\ntags: [x]\n---\nBody')
    expect(frontmatter).toEqual({ title: 'A', tags: ['x'] })
    expect(body).toBe('Body')
  })

  it('treats a file with no frontmatter as all body', () => {
    const { frontmatter, body } = splitFrontmatter('Just text')
    expect(frontmatter).toEqual({})
    expect(body).toBe('Just text')
  })

  it('survives malformed YAML instead of dropping the note', () => {
    const { frontmatter, body } = splitFrontmatter('---\n[unclosed: {\n---\nBody')
    expect(frontmatter).toEqual({})
    expect(body).toBe('Body')
  })

  it('does not mistake a horizontal rule for frontmatter', () => {
    expect(splitFrontmatter('Text\n\n---\n\nMore').frontmatter).toEqual({})
  })
})

describe('extractEdges', () => {
  it('finds wikilinks with and without aliases', () => {
    expect(extractEdges('A [[One]] and [[two/Three|Label]].')).toEqual([
      { raw: 'One', embed: false, wikilink: true },
      { raw: 'two/Three', alias: 'Label', embed: false, wikilink: true },
    ])
  })

  it('marks embeds', () => {
    expect(extractEdges('![[img.png]]')[0]).toMatchObject({ raw: 'img.png', embed: true })
  })

  it('skips links inside code fences and inline code', () => {
    expect(extractEdges('```\n[[A]]\n```\n`[[B]]`\n[[C]]')).toEqual([
      { raw: 'C', embed: false, wikilink: true },
    ])
  })

  it('skips a bare in-note anchor', () => {
    expect(extractEdges('[[#Heading]]')).toEqual([])
  })

  it('finds relative markdown links but not external ones', () => {
    const edges = extractEdges('[a](other.md) [b](https://x.com) [c](/root) [d](#anchor)')
    expect(edges).toEqual([{ raw: 'other.md', alias: 'a', embed: false, wikilink: false }])
  })
})

describe('isPublished', () => {
  it('publishes everything by default', () => {
    expect(isPublished({}, 'all')).toBe(true)
    expect(isPublished({ publish: false }, 'all')).toBe(false)
    expect(isPublished({ draft: true }, 'all')).toBe(false)
  })

  it('requires an explicit opt-in under the opt-in gate', () => {
    expect(isPublished({}, 'opt-in')).toBe(false)
    expect(isPublished({ publish: true }, 'opt-in')).toBe(true)
    expect(isPublished({ publish: true, draft: true }, 'opt-in')).toBe(false)
  })
})

describe('resolveTitle', () => {
  it('prefers frontmatter, then H1, then filename', () => {
    expect(resolveTitle({ title: 'FM' }, '# H1', 'File')).toBe('FM')
    expect(resolveTitle({}, '# H1', 'File')).toBe('H1')
    expect(resolveTitle({}, 'no heading', 'File')).toBe('File')
  })

  it('ignores an H1 inside a code fence', () => {
    expect(resolveTitle({}, '```\n# Not A Title\n```', 'File')).toBe('File')
  })

  it('strips closing hashes from an ATX heading', () => {
    expect(resolveTitle({}, '# Title #', 'File')).toBe('Title')
  })
})

describe('scanVault against the hostile fixture', () => {
  const vault = scan()

  it('finds every markdown file', () => {
    expect(vault.notes.length).toBe(11)
  })

  it('assigns readable, unique slugs', () => {
    const slugs = vault.notes.map((n) => n.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
    expect(vault.bySlug.get('notes/luhmann')?.path).toBe('notes/Luhmann.md')
  })

  it('takes the title from frontmatter, H1 or filename', () => {
    expect(vault.byPath.get('home.md')?.title).toBe('Home')
    expect(vault.byPath.get('notes/luhmann.md')?.title).toBe('Niklas Luhmann')
    expect(vault.byPath.get('notes/ideas 💡.md')?.title).toBe('Ideas 💡')
    expect(vault.byPath.get('bare.md')?.title).toBe('bare')
  })

  it('respects the publish gate', () => {
    expect(vault.byPath.get('private/secret log.md')?.published).toBe(false)
    expect(vault.byPath.get('home.md')?.published).toBe(true)
  })

  it('publishes nothing extra under opt-in', () => {
    const optIn = scan({ publishGate: 'opt-in' })
    expect(optIn.notes.every((n) => !n.published)).toBe(true)
  })

  it('merges frontmatter and inline tags', () => {
    const z = vault.byPath.get('zettelkasten.md')!
    expect(z.tags).toContain('method/zettelkasten')
    expect(z.tags).toContain('plain')
  })

  it('never extracts a tag from inside a code fence', () => {
    expect(vault.notes.flatMap((n) => n.tags)).not.toContain('AlsoLiteral')
  })

  it('indexes aliases and warns when one shadows a real filename', () => {
    expect(vault.byAlias.get('slipbox')?.[0].path).toBe('Zettelkasten.md')
    expect(vault.warnings.some((w) => w.includes('"luhmann"') && w.includes('collides'))).toBe(true)
  })

  it('indexes assets by both bare name and full path', () => {
    expect(vault.assets.get('diagram.png')).toEqual(['attachments/diagram.png'])
    expect(vault.assets.get('attachments/diagram.png')).toEqual(['attachments/diagram.png'])
  })

  it('records outgoing edges but not ones inside code', () => {
    const raws = (vault.edges.get('Zettelkasten.md') ?? []).map((e) => e.raw)
    expect(raws).toContain('Luhmann')
    expect(raws).toContain('private/Secret Log')
    expect(raws).not.toContain('AlsoLiteral')
  })

  it('gives every note dates without any frontmatter', () => {
    const bare = vault.byPath.get('bare.md')!
    expect(bare.dates.created).toBeInstanceOf(Date)
    expect(Number.isNaN(bare.dates.created.getTime())).toBe(false)
  })

  it('memoizes: the same options return the same object', () => {
    clearVaultCache()
    const a = scanVault({ root: VAULT })
    const b = scanVault({ root: VAULT })
    expect(a).toBe(b)
  })

  it('degrades loudly rather than throwing on a missing vault', () => {
    clearVaultCache()
    const missing = scanVault({ root: '/no/such/place' })
    expect(missing.notes).toEqual([])
    expect(missing.warnings[0]).toMatch(/not found/)
  })
})

describe('buildGraph', () => {
  const vault = scan()
  const graph = buildGraph(vault)

  it('builds backlinks between published notes', () => {
    expect(graph.backlinks.get('notes/luhmann')?.map((l) => l.slug)).toContain('zettelkasten')
  })

  it('never surfaces an unpublished note in either direction', () => {
    expect(graph.backlinks.has('private/secret-log')).toBe(false)
    const out = graph.outgoing.get('zettelkasten') ?? []
    expect(out.map((l) => l.slug)).not.toContain('private/secret-log')
  })

  it('does not count an embed as a navigation edge', () => {
    // cycles/A embeds B and nothing else, so B gains no backlink from it.
    expect(graph.backlinks.get('cycles/b')?.length ?? 0).toBe(0)
  })

  it('collapses repeated links between the same pair', () => {
    const edges = (graph.outgoing.get('home') ?? []).filter((l) => l.slug === 'zettelkasten')
    expect(edges.length).toBe(1)
  })

  it('warns about an ambiguous link, naming both candidates', () => {
    const warning = graph.warnings.find((w) => w.includes('Ambiguous link "Note"'))
    expect(warning).toBeDefined()
    expect(warning).toContain('notes/Note.md')
    expect(warning).toContain('notes/nested/note.md')
  })

  it('lists orphans', () => {
    expect(graph.orphans).toContain('cycles/a')
  })

  it('builds a 1-hop neighbourhood with real titles', () => {
    const hood = neighbourhood(graph, 'notes/luhmann', 1)
    expect(hood.nodes.find((n) => n.slug === 'notes/luhmann')?.depth).toBe(0)
    expect(hood.nodes.map((n) => n.slug)).toContain('zettelkasten')
    expect(hood.nodes.find((n) => n.slug === 'zettelkasten')?.title).toBe('Zettelkasten')
  })
})
