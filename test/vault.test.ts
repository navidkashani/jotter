import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  scanVault,
  clearVaultCache,
  extractEdges,
  splitFrontmatter,
  isPublished,
  resolveTitle,
} from '../src/lib/vault.js'
import { noteHref } from '../src/lib/href.js'
import { noteFrontmatterSchema, DISPLAYED_FIELDS } from '../src/lib/frontmatter.js'
import { frontmatterTags } from '../src/lib/tags.js'
import { frontmatterDate, FRONTMATTER_CREATED, FRONTMATTER_UPDATED } from '../src/lib/dates.js'
import strings from '../src/i18n/en.json'
import { buildGraph, neighbourhood, type Graph, type GraphLink } from '../src/lib/graph.js'

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
    expect(vault.notes.length).toBe(15)
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
    // `index`, not `home`: the fixture's `Home.md` sets `homepage: true`, so
    // the scan gives it the slug that means "this note is at the root".
    const edges = (graph.outgoing.get('index') ?? []).filter((l) => l.slug === 'zettelkasten')
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

describe('neighbourhood edges', () => {
  /**
   * A graph straight from a list of `source -> target` pairs. The fixture vault
   * has no triangle in it, and a triangle is the whole point of the
   * ring-closing pass — so these build exactly the shape under test rather than
   * hunting for one in the demo content.
   */
  const graphOf = (pairs: [string, string][]): Graph => {
    const slugs = [...new Set(pairs.flat())]
    const outgoing = new Map(slugs.map((s) => [s, [] as GraphLink[]]))
    const backlinks = new Map(slugs.map((s) => [s, [] as GraphLink[]]))

    for (const [source, target] of pairs) {
      outgoing.get(source)?.push({ slug: target, title: target, anchor: '', label: target })
      backlinks.get(target)?.push({ slug: source, title: source, anchor: '', label: source })
    }

    return {
      outgoing,
      backlinks,
      titles: new Map(slugs.map((s) => [s, s])),
      orphans: [],
      warnings: [],
    }
  }

  const keys = (hood: ReturnType<typeof neighbourhood>) =>
    hood.edges.map((e) => `${e.source} ${e.target}`).sort()

  it('closes the ring between two neighbours that link to each other', () => {
    // a -> b, a -> c, b -> c. Without the closing pass, b -> c is invisible and
    // the neighbourhood is a star rather than a triangle.
    const hood = neighbourhood(graphOf([['a', 'b'], ['a', 'c'], ['b', 'c']]), 'a', 1)
    expect(hood.nodes.map((n) => n.slug).sort()).toEqual(['a', 'b', 'c'])
    expect(keys(hood)).toEqual(['a b', 'a c', 'b c'])
  })

  it('closes a ring between two neighbours reached from opposite directions', () => {
    // b links in, c links out, and b -> c joins them behind the focused note.
    const hood = neighbourhood(graphOf([['b', 'a'], ['a', 'c'], ['b', 'c']]), 'a', 1)
    expect(keys(hood)).toEqual(['a c', 'b a', 'b c'])
  })

  it('admits no node the ring-closing pass has not already seen', () => {
    // c -> d leaves the neighbourhood, so neither the edge nor d comes back.
    const hood = neighbourhood(graphOf([['a', 'c'], ['c', 'd']]), 'a', 1)
    expect(hood.nodes.map((n) => n.slug).sort()).toEqual(['a', 'c'])
    expect(keys(hood)).toEqual(['a c'])
  })

  it('keeps direction, so an incoming link reads source -> focus', () => {
    const hood = neighbourhood(graphOf([['b', 'a']]), 'a', 1)
    expect(hood.edges).toEqual([{ source: 'b', target: 'a' }])
  })

  it('keeps a mutual pair as two directed edges, and only two', () => {
    // The pair is enumerated four times over — outgoing, backlink, and once
    // more by the closing pass from each end. Deduplication leaves both
    // directions exactly once; collapsing them into one line is the renderer's
    // job, not this function's.
    const hood = neighbourhood(graphOf([['a', 'b'], ['b', 'a']]), 'a', 1)
    expect(keys(hood)).toEqual(['a b', 'b a'])
  })

  it('returns no edges at depth 0', () => {
    const hood = neighbourhood(graphOf([['a', 'b'], ['b', 'a']]), 'a', 0)
    expect(hood.nodes.map((n) => n.slug)).toEqual(['a'])
    expect(hood.edges).toEqual([])
  })
})

/** A throwaway copy of the fixture vault, with files of our own written over it. */
function vaultWith(
  files: Record<string, string>,
  options: string | Partial<Parameters<typeof scanVault>[0]> = {},
) {
  const root = mkdtempSync(join(tmpdir(), 'jotter-homepage-'))
  cpSync(VAULT, root, { recursive: true })
  for (const [path, source] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true })
    writeFileSync(join(root, path), source)
  }
  clearVaultCache()
  return scanVault({ root, ...(typeof options === 'string' ? { homepage: options } : options) })
}

const NOTE = (front: string) => `---\n${front}\n---\n\nA note.\n`

describe('the note that claims /', () => {
  /**
   * The whole mechanism: the claimant is given the slug `index`, which
   * `noteHref` has always spelled `/`. Nothing downstream needs to know a
   * homepage exists — every link to this note is `/` for the same reason a root
   * `index.md`'s always was.
   */
  it('gives the claimant the index slug, and so the / href', () => {
    const v = scan()
    // `test/fixtures/vault/Home.md` sets `homepage: true` and nothing else does.
    expect(v.byPath.get('home.md')?.slug).toBe('index')
    expect(v.bySlug.get('index')?.path).toBe('Home.md')
    expect(noteHref(v.bySlug.get('index')!.slug)).toBe('/')
  })

  it('lets config name the note by slug, by vault path or by filename', () => {
    for (const named of ['zettelkasten', 'Zettelkasten.md', 'Zettelkasten']) {
      expect(scan({ homepage: named }).bySlug.get('index')?.path).toBe('Zettelkasten.md')
    }
  })

  it('gives config the last word over homepage: true', () => {
    const v = scan({ homepage: 'Zettelkasten' })
    expect(v.bySlug.get('index')?.path).toBe('Zettelkasten.md')
    // And the flagged note keeps its own slug, and so its own page.
    expect(v.byPath.get('home.md')?.slug).toBe('home')
  })

  it('falls through when homepage names a note that is absent or unpublished', () => {
    expect(scan({ homepage: 'No Such Note' }).bySlug.get('index')?.path).toBe('Home.md')
    // `private/Secret Log.md` has `publish: false`.
    expect(scan({ homepage: 'Secret Log' }).bySlug.get('index')?.path).toBe('Home.md')
  })

  it('falls back to a root index.md when nothing claims /', () => {
    const v = vaultWith({ 'Home.md': NOTE('title: Home'), 'index.md': NOTE('title: Landing') })
    expect(v.bySlug.get('index')?.path).toBe('index.md')
    expect(v.warnings.some((w) => w.includes('claim "/"'))).toBe(false)
  })

  /** The committed default. It must cost nothing and rename nothing. */
  it('leaves every slug alone when no note claims /', () => {
    const v = vaultWith({ 'Home.md': NOTE('title: Home') })
    expect(v.bySlug.has('index')).toBe(false)
    expect(v.byPath.get('home.md')?.slug).toBe('home')
  })

  /**
   * Two notes claim `/` and only one can have it. The other keeps a page rather
   * than vanishing from a site that still lists it everywhere — and the warning
   * naming both files is the only way the author finds out.
   */
  it('suffixes the displaced index.md rather than dropping it, and names both files', () => {
    const v = vaultWith({ 'index.md': NOTE('title: Landing') }, 'Zettelkasten')
    expect(v.bySlug.get('index')?.path).toBe('Zettelkasten.md')
    expect(v.byPath.get('index.md')?.slug).toBe('index-2')
    expect(v.bySlug.get('index-2')?.path).toBe('index.md')
    const warning = v.warnings.find((w) => w.includes('claim "/"'))
    expect(warning).toContain('index.md')
    expect(warning).toContain('Zettelkasten.md')
  })

  /**
   * Renamed all the same — two notes at `index` would put the collision back —
   * but not reported: a note that opted out of publication never claimed `/`,
   * and its slug is observable nowhere.
   */
  it('displaces an unpublished index.md without warning about it', () => {
    const v = vaultWith({ 'index.md': NOTE('title: Landing\npublish: false') }, 'Zettelkasten')
    expect(v.bySlug.get('index')?.path).toBe('Zettelkasten.md')
    expect(v.byPath.get('index.md')?.slug).toBe('index-2')
    expect(v.warnings.some((w) => w.includes('claim "/"'))).toBe(false)
  })

  it('puts frontmatter ahead of a root index.md, displacing it the same way', () => {
    const v = vaultWith({ 'index.md': NOTE('title: Landing') })
    expect(v.bySlug.get('index')?.path).toBe('Home.md')
    expect(v.byPath.get('index.md')?.slug).toBe('index-2')
  })

  it('breaks a tie between two homepage: true notes in path order, and warns', () => {
    const v = vaultWith({ 'Alpha.md': NOTE('title: Alpha\nhomepage: true') })
    // Sorted path order, as `assignSlugs` already breaks its own ties: a build
    // on Linux and a build on macOS must choose the same front door.
    expect(v.bySlug.get('index')?.path).toBe('Alpha.md')
    const warning = v.warnings.find((w) => w.includes('homepage: true'))
    expect(warning).toContain('Alpha.md')
    expect(warning).toContain('Home.md')
  })
})

/**
 * `permalink:` is the per-note half of the URL story. The site-wide half is
 * `slugs:`; this is what overrides it for one note, and the reason it exists is
 * that a note's old address is a fact about the world rather than something a
 * slug rule can derive.
 */
describe('permalink: the address a note keeps', () => {
  const AT = (front: string) => NOTE(front)

  it('takes the value verbatim, in every slug style', () => {
    for (const style of ['derive', 'preserve', 'obsidian'] as const) {
      const v = vaultWith(
        { 'Legacy Note.md': AT('title: Legacy\npermalink: Company/About+us') },
        { slugs: style },
      )
      expect(v.byPath.get('legacy note.md')?.slug).toBe('Company/About+us')
      expect(v.bySlug.get('Company/About+us')?.path).toBe('Legacy Note.md')
    }
  })

  it('never slugifies it — no lowercasing, no dashes, no substitutions', () => {
    const v = vaultWith({
      'Legacy Note.md': AT('title: Legacy\npermalink: Wisdom+&+Approaches/Critical+Thinking'),
    })
    expect(v.byPath.get('legacy note.md')?.slug).toBe('Wisdom+&+Approaches/Critical+Thinking')
  })

  it('accepts either spelling of the slashes, the way Hugo does', () => {
    const v = vaultWith({ 'Legacy Note.md': AT('title: Legacy\npermalink: /company/about/') })
    expect(v.byPath.get('legacy note.md')?.slug).toBe('company/about')
  })

  /**
   * The gap the Open Publish starter names and cannot close on Quartz — *"one
   * old URL per note, because one is all `permalink` holds"*. jotter writes
   * `_redirects` anyway, so the rest are kept on the note for the redirect
   * writer to pick up.
   */
  it('serves the first value and keeps the rest as redirect sources', () => {
    const v = vaultWith({
      'Legacy Note.md': AT('title: Legacy\npermalink: [Company/About+us, Company/About, about]'),
    })
    const note = v.byPath.get('legacy note.md')!
    expect(note.slug).toBe('Company/About+us')
    expect(note.permalinks).toEqual(['Company/About+us', 'Company/About', 'about'])
  })

  it('leaves permalinks empty on every note that declares none', () => {
    expect(scan().notes.every((n) => n.permalinks.length === 0)).toBe(true)
  })

  /** Precedence: `config.homepage` > `homepage: true` > `permalink` > path. */
  it('loses / to config.homepage and to homepage: true', () => {
    const byConfig = vaultWith(
      { 'Legacy Note.md': AT('title: Legacy\npermalink: index') },
      { homepage: 'Zettelkasten' },
    )
    expect(byConfig.bySlug.get('index')?.path).toBe('Zettelkasten.md')

    // `test/fixtures/vault/Home.md` sets `homepage: true`.
    const byFlag = vaultWith({ 'Legacy Note.md': AT('title: Legacy\npermalink: index') })
    expect(byFlag.bySlug.get('index')?.path).toBe('Home.md')
  })

  /**
   * A permalink beats a derived slug because it is the deliberate statement of
   * the two — and the displaced note keeps a page rather than vanishing from a
   * site that still lists it, which is the same choice `claimRoot` makes.
   */
  it('displaces a derived slug, suffixes the loser and names both files', () => {
    const v = vaultWith({ 'Legacy Note.md': AT('title: Legacy\npermalink: zettelkasten') })
    expect(v.bySlug.get('zettelkasten')?.path).toBe('Legacy Note.md')
    expect(v.byPath.get('zettelkasten.md')?.slug).toBe('zettelkasten-2')
    const warning = v.warnings.find((w) => w.includes('claim "/zettelkasten"'))
    expect(warning).toContain('Zettelkasten.md')
    expect(warning).toContain('Legacy Note.md')
    expect(warning).toMatch(/Rename one/)
  })

  it('breaks a tie between two permalinks in path order, keeping both pages', () => {
    const v = vaultWith({
      'Alpha.md': AT('title: Alpha\npermalink: shared'),
      'Beta.md': AT('title: Beta\npermalink: shared'),
    })
    expect(v.bySlug.get('shared')?.path).toBe('Alpha.md')
    expect(v.byPath.get('beta.md')?.slug).toBe('shared-2')
    expect(v.warnings.some((w) => w.includes('claim "/shared"'))).toBe(true)
  })

  /**
   * And a note suffixed after losing that tie is sitting on a slug it never
   * named, so a note that *does* name it takes it — the same rule one level
   * down, rather than a special case that stops applying after the first
   * collision.
   */
  it('lets a later permalink displace a slug a tie-loser was suffixed onto', () => {
    const v = vaultWith({
      'Alpha.md': NOTE('title: Alpha\npermalink: shared'),
      'Beta.md': NOTE('title: Beta\npermalink: shared'),
      'Gamma.md': NOTE('title: Gamma\npermalink: shared-2'),
    })
    expect(v.bySlug.get('shared')?.path).toBe('Alpha.md')
    expect(v.bySlug.get('shared-2')?.path).toBe('Gamma.md')
    expect(v.byPath.get('beta.md')?.slug).toBe('shared-2-2')
  })

  it('says nothing about displacing a note nobody can reach', () => {
    const v = vaultWith({
      'Hidden.md': AT('title: Hidden\npublish: false'),
      'Legacy Note.md': AT('title: Legacy\npermalink: hidden'),
    })
    expect(v.bySlug.get('hidden')?.path).toBe('Legacy Note.md')
    expect(v.warnings.some((w) => w.includes('claim "/hidden"'))).toBe(false)
  })

  it('stops the build on a permalink that would escape dist/, naming the note', () => {
    expect(() =>
      vaultWith({ 'Legacy Note.md': AT('title: Legacy\npermalink: ../../etc/passwd') }),
    ).toThrow(/Legacy Note\.md/)
  })
})

describe('slug styles, end to end', () => {
  it('keeps the vault path under preserve and obsidian, and keys bySlug by it', () => {
    const files = { 'Wisdom & Approaches/Critical Thinking.md': NOTE('title: Critical') }

    const preserve = vaultWith(files, { slugs: 'preserve' })
    expect(preserve.bySlug.get('Wisdom & Approaches/Critical Thinking')?.title).toBe('Critical')

    const obsidian = vaultWith(files, { slugs: 'obsidian' })
    expect(obsidian.bySlug.get('Wisdom+&+Approaches/Critical+Thinking')?.title).toBe('Critical')
    expect(obsidian.slugs).toBe('obsidian')
  })

  /**
   * The failure this prevents is invisible: Astro NFC-normalises every route
   * param itself, so a decomposed slug would be *routed* at its composed path
   * while `bySlug`, every href and every redirect stayed decomposed — and every
   * link to that note would 404. The path must stay byte-exact the other way,
   * because the collection's `generateId` is the path.
   */
  it('composes the slug to NFC while leaving the path as the filesystem wrote it', () => {
    const decomposed = 'Café.md' // as macOS Finder writes it
    const v = vaultWith({ [decomposed]: NOTE('title: Cafe') }, { slugs: 'preserve' })
    const note = v.notes.find((n) => n.title === 'Cafe')!
    expect(note.slug).toBe('Café'.normalize('NFC'))
    expect(v.bySlug.get('Café'.normalize('NFC'))).toBe(note)
    expect(note.path.normalize('NFC')).toBe('Café.md'.normalize('NFC'))
  })

  /**
   * The scan forwards what `slugHazards` finds — reported, and nothing renamed,
   * because renaming would be jotter inventing a slug it was told to carry
   * verbatim. (The case-only collision the same pass catches cannot be *made*
   * here: on the macOS filesystem these tests run on, `Note.md` and `note.md`
   * are one file, which is the very failure it warns about. It is asserted over
   * the function directly, in `test/lib.test.ts`.)
   */
  it('forwards a slug hazard as a warning, and renames nothing', () => {
    const v = vaultWith({ 'Q|A.md': NOTE('title: Windows') }, { slugs: 'preserve' })
    expect(v.bySlug.get('Q|A')?.title).toBe('Windows')
    expect(v.warnings.some((w) => /Windows/.test(w) && w.includes('Q|A.md'))).toBe(true)
  })

  /** An excluded note has no page, so nothing of it is written into `dist/`. */
  it('says nothing about a hazard on a note that is never written', () => {
    const v = vaultWith({ 'Q|A.md': NOTE('title: Windows\npublish: false') }, { slugs: 'preserve' })
    expect(v.warnings.some((w) => w.includes('Q|A.md'))).toBe(false)
  })
})

/**
 * The bug this closes is silence. `image:` was declared in the collection
 * schema and read by nothing, so a path that had gone stale — or one pointing
 * at an SVG, which no unfurler draws — built clean and shipped a text card.
 * Every warning names the note *and* the value, because "an image did not
 * resolve" sends you reading the whole vault.
 */
describe('declared card images', () => {
  it('warns, naming the note and the value, when the file is not in the vault', () => {
    // `test/fixtures/vault/Previews.md` sets `image: attachments/gone.png`.
    const warning = scan().warnings.find((w) => w.includes('attachments/gone.png'))
    expect(warning).toContain('Previews.md')
    expect(warning).toMatch(/no such file/i)
  })

  it('says nothing about a note whose image resolves', () => {
    const v = vaultWith({ 'Card.md': NOTE('title: Card\nimage: diagram.png') })
    expect(v.warnings.some((w) => w.includes('diagram.png'))).toBe(false)
  })

  it('warns about a format no link preview draws, naming the formats that work', () => {
    const v = vaultWith({
      'attachments/logo.svg': '<svg width="64" height="64"></svg>',
      'Card.md': NOTE('title: Card\nimage: logo.svg'),
    })
    const warning = v.warnings.find((w) => w.includes('logo.svg'))
    expect(warning).toContain('Card.md')
    expect(warning).toContain('PNG, JPEG, GIF or WebP')
  })

  /**
   * Quartz's own two spellings, so a migrated vault keeps the cards it had —
   * and the warning quotes the key the author actually typed, because a message
   * naming `image:` sends them looking for a line that is not in the file.
   */
  it('reads socialImage and cover as well as image, and quotes the key it read', () => {
    for (const key of ['socialImage', 'cover']) {
      const v = vaultWith({ 'Card.md': NOTE(`title: Card\n${key}: missing-card.png`) })
      const warning = v.warnings.find((w) => w.includes('missing-card.png'))
      expect(warning).toContain('Card.md')
      expect(warning).toContain(`${key}: missing-card.png`)
    }
  })

  /** No page, nothing to unfurl, nothing to say. */
  it('leaves an unpublished note alone', () => {
    const v = vaultWith({ 'Card.md': NOTE('title: Card\npublish: false\nimage: missing-card.png') })
    expect(v.warnings.some((w) => w.includes('missing-card.png'))).toBe(false)
  })

  it('validates config.image the same way, once, naming the key rather than a note', () => {
    const warning = scan({ image: 'attachments/nowhere.png' }).warnings.find((w) =>
      w.includes('attachments/nowhere.png'),
    )
    expect(warning).toContain('jotter.config.ts')
  })

  /** Neither form is the vault's to find, so neither can be missing from it. */
  it('never warns about a rooted path or an absolute URL', () => {
    for (const image of ['/og.png', 'https://cdn.example.com/og.png']) {
      expect(scan({ image }).warnings.some((w) => w.includes('og.png'))).toBe(false)
    }
  })
})

/**
 * `direction:` is the escape hatch for the one case first-strong gets wrong,
 * and its failure mode is the same silence `image:` had: a value jotter cannot
 * read falls back to the site's direction, and the only symptom is a paragraph
 * still aligned the way the author was trying to change. `auto` is not a
 * mistake — it is the third value the esm7 plugin writes, and it asks for the
 * behaviour jotter does by default.
 */
describe('declared note direction', () => {
  it('warns, naming the note and the value, when it cannot read one', () => {
    const v = vaultWith({ 'Farsi.md': NOTE('title: Farsi\ndirection: right') })
    const warning = v.warnings.find((w) => w.includes('direction: right'))
    expect(warning).toContain('Farsi.md')
    expect(warning).toContain('`rtl`, `ltr` or `auto`')
  })

  it('says nothing about the three values it does read', () => {
    for (const value of ['rtl', 'LTR', ' auto ']) {
      const v = vaultWith({ 'Farsi.md': NOTE(`title: Farsi\ndirection: "${value}"`) })
      expect(v.warnings.some((w) => w.includes('direction'))).toBe(false)
    }
  })

  /** No page, nothing to align, nothing to say. */
  it('leaves an unpublished note alone', () => {
    const v = vaultWith({ 'Farsi.md': NOTE('title: Farsi\npublish: false\ndirection: right') })
    expect(v.warnings.some((w) => w.includes('direction'))).toBe(false)
  })
})

/**
 * The contract between two answers to the same question.
 *
 * `src/lib/frontmatter.ts` says what a note may contain and `src/lib/vault.ts`
 * says what jotter does with it, and for a long time they disagreed in the one
 * direction that is not survivable: the schema was *narrower*. `title: 2026` on
 * a yearly review note, `tags: [2026, reading]`, `aliases: [2026, Review]` and
 * `created: true` each failed the build outright — on a vault Obsidian opens
 * without comment, and against three pieces of coercion the scan had been
 * carrying, untested and unreachable, the whole time.
 *
 * Each case below asserts both halves at once, so the two files cannot drift
 * apart again without a red test naming the key.
 */
describe('the frontmatter schema and the scan agree', () => {
  const accepts = (frontmatter: Record<string, unknown>) =>
    noteFrontmatterSchema.safeParse(frontmatter).success

  it('takes a number where resolveTitle coerces one', () => {
    expect(resolveTitle({ title: 2026 }, 'no heading', 'File')).toBe('2026')
    expect(accepts({ title: 2026 })).toBe(true)
    // A non-string description is declined by the layout, not by the build.
    expect(accepts({ description: 42 })).toBe(true)
  })

  it('takes numeric tags and aliases, which the scan stringifies', () => {
    expect(frontmatterTags([2026, 'reading'])).toEqual(['2026', 'reading'])
    expect(accepts({ tags: [2026, 'reading'] })).toBe(true)

    const v = vaultWith({ 'Year.md': NOTE('title: Year\naliases: [2026, Review]') })
    expect(v.byAlias.get('2026')?.[0].path).toBe('Year.md')
    expect(accepts({ aliases: [2026, 'Review'], alias: 2026 })).toBe(true)
  })

  /**
   * `published: true` is a publish flag in a vault that used it as one, and a
   * *date* key to `dates.ts`. `asDate` declines it and the note takes its git
   * date instead — a graceful fallback the schema must not turn into an error.
   */
  it('takes a date key the scan will decline and fall back from', () => {
    expect(frontmatterDate({ published: true }, ['published'])).toBeUndefined()
    expect(accepts({ published: true, created: true })).toBe(true)
  })

  /**
   * Declared, not merely *accepted*: `.passthrough()` takes any key at all, so
   * `safeParse` succeeding proves nothing about a key being known. The schema's
   * own shape is the only thing that does, which is why both lists below are
   * exported from the modules that own them rather than retyped here.
   */
  const declared = Object.keys(noteFrontmatterSchema.shape)

  it('declares every date spelling the scan looks for', () => {
    for (const key of [...FRONTMATTER_CREATED, ...FRONTMATTER_UPDATED]) {
      expect(declared).toContain(key)
      expect(accepts({ [key]: '2026-01-02' })).toBe(true)
    }
  })

  /**
   * The keys `Frontmatter.astro` prints in the note header. They rendered on
   * every note page for as long as the component has existed while being
   * declared nowhere, documented nowhere and set by no note in either vault.
   */
  /**
   * Loose on purpose, unlike the strict three below: `direction: 3` is a
   * cosmetic mistake, and `warnDirections` names it at scan time rather than
   * the build dying over a paragraph's alignment.
   */
  it('declares the direction key, and takes anything the scan will warn about', () => {
    expect(declared).toContain('direction')
    expect(accepts({ direction: 'rtl' })).toBe(true)
    expect(accepts({ direction: 'auto' })).toBe(true)
    expect(accepts({ direction: 'right' })).toBe(true)
  })

  it('declares every key the note header renders', () => {
    for (const key of DISPLAYED_FIELDS) expect(declared).toContain(key)
    expect(accepts({ status: 'seedling', source: 'Ahrens 2017', author: 'A', series: 'S' })).toBe(true)
    // `format()` joins a list, so a list is as legal as a scalar.
    expect(accepts({ author: ['Ada', 'Grace'], status: 3 })).toBe(true)
  })

  /**
   * `t()` returns the key itself when it cannot find a string, so a displayed
   * field with no label puts a literal `note.field.series` in a `<dt>` on every
   * note page that sets it. Nothing else in the build would catch that.
   */
  it('has a label for every key the note header renders', () => {
    for (const key of DISPLAYED_FIELDS) {
      expect(Object.keys(strings)).toContain(`note.field.${key}`)
    }
  })

  /**
   * The deliberate exception. `publish: 'false'` coerced generously is a note
   * the author meant to hide, published, in silence — the exact failure the
   * publish gate exists to prevent. Loud is right here in a way it is not for
   * a title, so these three keep refusing anything but a boolean.
   */
  it('still refuses a non-boolean gate, so a typo cannot silently publish', () => {
    expect(accepts({ publish: 'false' })).toBe(false)
    expect(accepts({ draft: 'yes' })).toBe(false)
    expect(accepts({ homepage: 'yes' })).toBe(false)
    expect(accepts({ publish: false, draft: true, homepage: true })).toBe(true)
  })

  it('still lets somebody’s Dataview field through untouched', () => {
    const parsed = noteFrontmatterSchema.parse({
      'dataview-field': { nested: true },
    }) as Record<string, unknown>
    expect(parsed['dataview-field']).toEqual({ nested: true })
  })
})
