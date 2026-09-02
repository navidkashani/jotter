import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'

import { scanVault, clearVaultCache } from '../src/lib/vault.js'
import {
  buildTree,
  folders,
  contains,
  neighbours,
  shadowedFolders,
  type TreeEntry,
  type TreeFolder,
} from '../src/lib/tree.js'
import { encodeSlug } from '../src/lib/url.js'
import { noteHref, assetHref, tagHref, relativeAssetPath } from '../src/lib/href.js'
import { liveLabel } from '../src/lib/resolve.js'
import { svgIntrinsicSize, isOptimizable } from '../src/lib/embed.js'
import { sectionOf, preresolveLinks, expandTransclusions } from '../src/lib/transclude.js'
import { defineConfig, jotterConfigSchema } from '../src/lib/config.js'
import {
  buildRedirects,
  buildRedirectRules,
  toNetlify,
  toVercel,
  robotsTxt,
} from '../src/lib/redirects.js'
import { feedXml, MAX_ITEMS, FEED_PATH } from '../src/lib/feed.js'
import { frontmatterImage, resolveSocialImage, socialImageUrl } from '../src/lib/social.js'
import type { VaultNote } from '../src/lib/vault.js'

const VAULT = fileURLToPath(new URL('./fixtures/vault', import.meta.url))
const vault = () => {
  clearVaultCache()
  return scanVault({ root: VAULT })
}

describe('href', () => {
  it('builds note URLs, with the root note at /', () => {
    expect(noteHref('notes/luhmann')).toBe('/notes/luhmann')
    expect(noteHref('index')).toBe('/')
    expect(noteHref('notes/luhmann', '#Some Heading')).toBe('/notes/luhmann#some-heading')
  })

  it('drops a block reference, which has no stable anchor', () => {
    expect(noteHref('a', '#^block-id')).toBe('/a')
  })

  it('percent-encodes segments but keeps the separators readable', () => {
    expect(noteHref('notes/заметка')).toBe('/notes/%D0%B7%D0%B0%D0%BC%D0%B5%D1%82%D0%BA%D0%B0')
    expect(assetHref('attachments/a b.png')).toBe('/_vault/attachments/a%20b.png')
    expect(tagHref('method/zettelkasten')).toBe('/tags/method/zettelkasten')
  })

  it('honours a base path', () => {
    expect(noteHref('a', '', '/garden')).toBe('/garden/a')
    expect(assetHref('x.png', 'garden')).toBe('/garden/_vault/x.png')
  })

  it('makes an asset path relative to the note embedding it', () => {
    expect(relativeAssetPath('Note.md', 'attachments/x.png')).toBe('./attachments/x.png')
    expect(relativeAssetPath('notes/Note.md', 'attachments/x.png')).toBe('../attachments/x.png')
    expect(relativeAssetPath('a/b/Note.md', 'a/b/x.png')).toBe('./x.png')
    expect(relativeAssetPath('a/b/c/Note.md', 'a/x.png')).toBe('../../x.png')
  })
})

describe('liveLabel', () => {
  it('keeps the path the author wrote, unlike a dead link', () => {
    expect(liveLabel('folder/Note')).toBe('folder/Note')
  })

  it('spells the heading separator the way Obsidian does', () => {
    expect(liveLabel('Note#Heading')).toBe('Note > Heading')
  })

  it('drops a block reference', () => {
    expect(liveLabel('Note#^abc')).toBe('Note')
  })
})

describe('tree', () => {
  const t = buildTree(vault().notes.filter((n) => n.published), 'derive')

  it('derives folders from note paths', () => {
    const names = folders(t).map((f) => f.path).sort()
    expect(names).toContain('notes')
    expect(names).toContain('notes/nested')
  })

  /**
   * The repair an Open Publish build needs. There every note is written to its
   * *slug*, so the folder tree derived from the paths on disk reads
   * `wisdom-approaches` where the vault reads `Wisdom & Approaches`. Note
   * titles survive because the snapshot carries one; folders have no file to
   * carry anything, so the names arrive through config instead.
   */
  it('calls a folder what config.folderNames calls it', () => {
    const notes = vault().notes.filter((n) => n.published)
    const named = buildTree(notes, 'derive', { notes: 'Notes', 'notes/nested': 'Nested Away' })
    const byPath = new Map(folders(named).map((f) => [f.path, f.name]))

    expect(byPath.get('notes')).toBe('Notes')
    expect(byPath.get('notes/nested')).toBe('Nested Away')
  })

  it('keeps its own path segment for a folder config does not name', () => {
    const notes = vault().notes.filter((n) => n.published)
    const byPath = new Map(
      folders(buildTree(notes, 'derive', { notes: 'Notes' })).map((f) => [f.path, f.name]),
    )
    expect(byPath.get('notes/nested')).toBe('nested')
  })

  it('sorts by the name a reader sees, not by the path', () => {
    // One ordering, decided where the name is: the sidebar and the folder
    // pages both read `name`, so a display name that sorts differently must
    // move the entry in both or in neither.
    const notes = vault().notes.filter((n) => n.published)
    const named = buildTree(notes, 'derive', { notes: 'Zed' })
    const topFolders = named.filter((e) => e.kind === 'folder').map((e) => e.name)
    expect([...topFolders].sort((a, b) => a.localeCompare(b))).toEqual(topFolders)
  })

  /**
   * The footer's chain. Neighbours are siblings under one folder, in the order
   * the sidebar draws them, because the flat published list this replaces is
   * sorted by whole vault path: from a note at the root, "Previous" was
   * whatever happened to sort before it anywhere in the vault.
   */
  it('links a note to its siblings, in the order the sidebar shows', () => {
    const pairs = neighbours(t)
    const inNotes = folders(t).find((f) => f.path === 'notes')!
    const siblings = (
      (t.find((e) => e.kind === 'folder' && e.path === 'notes') as TreeFolder).children
    ).filter((c) => c.kind === 'note')

    expect(siblings.length).toBeGreaterThan(1)
    expect(inNotes.slug).toBeTruthy()
    for (const [i, note] of siblings.entries()) {
      expect(pairs.get(note.slug)).toEqual({
        previous: siblings[i - 1]?.slug,
        next: siblings[i + 1]?.slug,
      })
    }
  })

  it('never steps across a folder boundary', () => {
    const pairs = neighbours(t)
    const parentOf = (slug: string) => {
      const note = vault().notes.find((n) => n.slug === slug)!
      return note.path.split('/').slice(0, -1).join('/')
    }
    for (const [slug, pair] of pairs) {
      for (const other of [pair.previous, pair.next]) {
        if (other) expect(parentOf(other)).toBe(parentOf(slug))
      }
    }
  })

  it('leaves an only child with neither neighbour rather than borrowing one', () => {
    const pairs = neighbours(t)
    const nested = (
      folders(t).find((f) => f.path === 'notes/nested')!.children
    ).filter((c) => c.kind === 'note')
    expect(nested).toHaveLength(1)
    expect(pairs.get(nested[0].slug)).toEqual({ previous: undefined, next: undefined })
  })

  /**
   * The `/about` collision, which used to be a `console.warn` inside
   * `getStaticPaths`: a line in a page-build log, on a hook Astro may not
   * re-run. The note wins the URL, the sidebar keeps listing the folder, and
   * somebody has to be told.
   */
  it('names a folder whose slug a note has taken', () => {
    const notes = vault().notes.filter((n) => n.published)
    const clash = { ...notes[0], slug: 'notes', path: 'notes/About.md' }
    expect(shadowedFolders(t, [...notes, clash])).toContainEqual({
      folder: 'notes',
      slug: 'notes',
      note: 'notes/About.md',
    })
  })

  it('says nothing when every folder owns its own slug', () => {
    expect(shadowedFolders(t, vault().notes.filter((n) => n.published))).toEqual([])
  })

  it('never invents a folder holding nothing published', () => {
    // `private/` holds only an unpublished note, so it must not appear.
    expect(folders(t).map((f) => f.path)).not.toContain('private')
  })

  /**
   * The loose notes at the top of a vault are its front doors: Welcome, Now,
   * Start here. Under the folders they sat at the bottom of the sidebar, below
   * every folder in the vault, which is where Obsidian Publish never puts them.
   */
  it('puts the root’s own notes above its folders', () => {
    const kinds = t.map((e) => e.kind)
    expect(kinds.lastIndexOf('note')).toBeLessThan(kinds.indexOf('folder'))
  })

  /** And inside a folder it is a file tree again, which is what people expect. */
  it('sorts folders before notes everywhere below the root', () => {
    const notesFolder = t.find(
      (e): e is TreeFolder => e.kind === 'folder' && e.path === 'notes',
    )!
    const kinds = notesFolder.children.map((e) => e.kind)
    expect(kinds.indexOf('folder')).toBeLessThan(kinds.lastIndexOf('note'))
  })

  it('sorts alphabetically within a kind, at every level', () => {
    const names = (entries: TreeEntry[], kind: string) =>
      entries.filter((e) => e.kind === kind).map((e) => (e.kind === 'folder' ? e.name : e.title))
    for (const kind of ['folder', 'note']) {
      const at = names(t, kind)
      expect([...at].sort((a, b) => a.localeCompare(b))).toEqual(at)
    }
  })

  it('counts notes into every ancestor', () => {
    const notesFolder = folders(t).find((f) => f.path === 'notes')!
    // 6 directly in notes/, plus 1 in notes/nested/
    expect(notesFolder.count).toBe(7)
  })

  it('knows which folder holds the current note', () => {
    const notesFolder = folders(t).find((f) => f.path === 'notes')!
    expect(contains(notesFolder, 'notes/luhmann')).toBe(true)
    expect(contains(notesFolder, 'zettelkasten')).toBe(false)
  })

  /**
   * Load-bearing, and silent when it breaks: `contains()` is a `startsWith`
   * over slugs, so a folder slugged one way above notes slugged another matches
   * nothing: no error, just a sidebar that stops opening the right branch and
   * stops marking the current page.
   */
  it('slugs a folder as a prefix of its notes under every style', () => {
    for (const style of ['derive', 'preserve', 'obsidian'] as const) {
      const notes = scanVault({ root: VAULT, slugs: style }).notes.filter((n) => n.published)
      clearVaultCache()
      const folder = folders(buildTree(notes, style)).find((f) => f.path === 'notes')!
      const inside = notes.filter((n) => n.path.startsWith('notes/'))
      expect(inside.length).toBeGreaterThan(0)
      for (const note of inside) expect(contains(folder, note.slug)).toBe(true)
    }
  })

  /**
   * And the other half of the same rule: a note a `permalink:` moved out of its
   * folder stops matching, which is correct: it is no longer served from under
   * that folder's URL.
   */
  it('stops claiming a note a permalink moved out of the folder', () => {
    const folder = folders(t).find((f) => f.path === 'notes')!
    expect(contains(folder, 'Company/About+us')).toBe(false)
  })
})

describe('svgIntrinsicSize', () => {
  it('reads width and height attributes', () => {
    expect(svgIntrinsicSize('<svg width="240" height="120"></svg>')).toEqual({ width: 240, height: 120 })
  })

  it('falls back to the viewBox', () => {
    expect(svgIntrinsicSize('<svg viewBox="0 0 300 150"></svg>')).toEqual({ width: 300, height: 150 })
  })

  it('strips px units', () => {
    expect(svgIntrinsicSize('<svg width="10px" height="20px"></svg>')).toEqual({ width: 10, height: 20 })
  })

  it('returns nothing when there is nothing to read', () => {
    expect(svgIntrinsicSize('<svg></svg>')).toBeUndefined()
  })

  it('knows which formats Astro should not re-encode', () => {
    expect(isOptimizable('a.png')).toBe(true)
    expect(isOptimizable('a.svg')).toBe(false)
    expect(isOptimizable('a.gif')).toBe(false)
  })
})

describe('sectionOf', () => {
  const body = `Intro text.

## First

One.

### Nested

Two.

## Second

Three.
`

  it('takes a section up to the next same-level heading', () => {
    expect(sectionOf(body, '#First')).toBe('One.\n\n### Nested\n\nTwo.')
  })

  it('takes a nested section up to the next heading of any higher level', () => {
    expect(sectionOf(body, '#Nested')).toBe('Two.')
  })

  it('runs to the end for the last section', () => {
    expect(sectionOf(body, '#Second')).toBe('Three.')
  })

  it('returns the whole note for a block reference', () => {
    expect(sectionOf(body, '#^abc')).toBe(body)
  })

  it('returns nothing for a heading that is not there', () => {
    expect(sectionOf(body, '#Missing')).toBe('')
  })

  it('ignores a heading inside a code fence', () => {
    expect(sectionOf('```\n## Fake\n```\n\n## Real\n\nHere.', '#Fake')).toBe('')
  })
})

describe('preresolveLinks', () => {
  const v = vault()

  it('rewrites a published wikilink to its final href', () => {
    expect(preresolveLinks('See [[Luhmann]].', 'Home.md', v, 'shortest')).toBe(
      'See [Luhmann](/notes/luhmann).',
    )
  })

  it('flattens an unpublished target to plain text', () => {
    expect(preresolveLinks('See [[Secret Log]].', 'Home.md', v, 'shortest')).toBe('See Secret Log.')
  })

  it('resolves against the transcluded note, not the host', () => {
    // `../Luhmann` only resolves relative to notes/nested/note.md
    expect(preresolveLinks('[[../Luhmann]]', 'notes/nested/note.md', v, 'relative')).toBe(
      '[Luhmann](/notes/luhmann)',
    )
  })

  it('leaves links inside code fences alone', () => {
    const source = '```\n[[Luhmann]]\n```'
    expect(preresolveLinks(source, 'Home.md', v, 'shortest')).toBe(source)
  })
})

describe('expandTransclusions', () => {
  const v = vault()
  const options = { maxDepth: 3, linkResolution: 'shortest' as const }

  it('inlines the target and links back to it', () => {
    const out = expandTransclusions('![[Luhmann]]', 'Home.md', v, options)
    expect(out).toContain('class="transclusion"')
    expect(out).toContain('A sociologist')
    expect(out).toContain('href="/notes/luhmann"')
  })

  it('stops on a cycle rather than recursing forever', () => {
    const out = expandTransclusions('![[A]]', 'Home.md', v, options)
    expect(out).toContain('data-transclusion="cycle"')
  })

  it('respects the depth limit', () => {
    const out = expandTransclusions('![[A]]', 'Home.md', v, { ...options, maxDepth: 1 })
    expect(out).toContain('data-transclusion="depth"')
  })

  it('leaves an unpublished target as plain text', () => {
    expect(expandTransclusions('![[Secret Log]]', 'Home.md', v, options)).toBe('Secret Log')
  })

  it('leaves media embeds for the image pipeline', () => {
    expect(expandTransclusions('![[diagram.png]]', 'Home.md', v, options)).toBe('![[diagram.png]]')
  })
})

describe('config', () => {
  it('builds a complete config from nothing', () => {
    const config = defineConfig({})
    expect(config.linkResolution).toBe('shortest')
    expect(config.publishGate).toBe('all')
    expect(config.strictLineBreaks).toBe(false)
    expect(config.features.toc).toBe(true)
    expect(config.features.graph).toBe(false)
    expect(config.analytics.provider).toBe('none')
  })

  it('keeps partial feature overrides and defaults the rest', () => {
    const config = defineConfig({ features: { graph: true } })
    expect(config.features.graph).toBe(true)
    expect(config.features.backlinks).toBe(true)
  })

  it('names the offending key when a value is wrong', () => {
    expect(() => defineConfig({ layout: 'columns' as never })).toThrow(/layout/)
    expect(() => defineConfig({ url: 'not-a-url' })).toThrow(/url/)
  })

  it('rejects an unknown key rather than silently ignoring it', () => {
    expect(() => defineConfig({ colour: 'blue' } as never)).toThrow()
  })

  it('defaults to Obsidian’s line-break behaviour, not CommonMark’s', () => {
    expect(jotterConfigSchema.parse({}).strictLineBreaks).toBe(false)
  })

  /**
   * The default has to stay `derive` forever: it is the URL scheme every jotter
   * site built so far is already published at, and changing it would move every
   * page on all of them.
   */
  it('defaults slugs to derive, and accepts the other two by name', () => {
    expect(jotterConfigSchema.parse({}).slugs).toBe('derive')
    expect(defineConfig({ slugs: 'preserve' }).slugs).toBe('preserve')
    expect(defineConfig({ slugs: 'obsidian' }).slugs).toBe('obsidian')
    expect(() => defineConfig({ slugs: 'obsidian-publish' as never })).toThrow(/slugs/)
  })
})

describe('config: analytics', () => {
  it('leaves analytics off with nothing configured', () => {
    expect(defineConfig({}).analytics).toEqual({ provider: 'none' })
  })

  it('accepts each provider with an id', () => {
    expect(defineConfig({ analytics: { provider: 'plausible', id: 'example.com' } }).analytics.id).toBe('example.com')
    expect(defineConfig({ analytics: { provider: 'google', id: 'G-ABC' } }).analytics.provider).toBe('google')
  })

  /**
   * A provider with no id is a site that collects nothing, forever, and says so
   * nowhere. Degrade loudly.
   */
  it('refuses a provider without an id, naming the key', () => {
    expect(() => defineConfig({ analytics: { provider: 'plausible' } })).toThrow(/analytics\.id/)
  })

  it('still allows a leftover id once the provider is off', () => {
    // Turning analytics off should be a one-word edit, not a three-line delete.
    expect(defineConfig({ analytics: { provider: 'none', id: 'example.com' } }).analytics.provider).toBe('none')
  })

  it('takes a self-hosted host for the three providers that have one', () => {
    for (const provider of ['plausible', 'umami', 'goatcounter'] as const) {
      const config = defineConfig({ analytics: { provider, id: 'X', host: 'https://stats.example.com' } })
      expect(config.analytics.host).toBe('https://stats.example.com')
    }
  })

  /**
   * Fathom, Cloudflare and Google have no self-hosted mode at all, so a `host`
   * there is a misunderstanding rather than a preference. Ignoring it silently
   * is how someone spends an afternoon wondering why self-hosting did not take.
   */
  it('refuses a host on a provider that is vendor-hosted only', () => {
    for (const provider of ['fathom', 'cloudflare', 'google'] as const) {
      expect(() =>
        defineConfig({ analytics: { provider, id: 'X', host: 'https://stats.example.com' } }),
      ).toThrow(/analytics\.host/)
    }
  })

  it('rejects a host that is not a URL', () => {
    expect(() => defineConfig({ analytics: { provider: 'plausible', id: 'X', host: 'stats' } })).toThrow(
      /analytics\.host/,
    )
  })

  /**
   * `custom` and its `src` are gone. Neither ever rendered anything, so no
   * site's behaviour changes, but a config that used to parse now refuses to,
   * and it should say which key to delete.
   */
  it('rejects the removed custom provider, naming the key', () => {
    expect(() => defineConfig({ analytics: { provider: 'custom' } } as never)).toThrow(/analytics\.provider/)
  })

  it('rejects the removed src field rather than stripping it', () => {
    // The root `.strict()` does not cascade into a nested object, so this only
    // throws because the analytics object is strict in its own right.
    expect(() =>
      defineConfig({ analytics: { provider: 'plausible', id: 'X', src: '<script>' } } as never),
    ).toThrow(/src/)
  })
})

describe('feed', () => {
  const v = vault()

  /**
   * The whole vault, unfiltered, exactly as `src/integrations/vault.ts` hands
   * it over. Filtering is `feedXml`'s own job, and that is what the first test
   * below is really checking.
   */
  const options = {
    notes: v.notes,
    title: 'Slipbox',
    description: 'A garden of notes.',
    siteUrl: 'https://example.com',
    locale: 'en',
  }
  const xml = feedXml(options)

  /** One item's inner XML, by the title it carries. */
  const item = (feed: string, title: string) =>
    [...feed.matchAll(/<item>([\s\S]*?)<\/item>/g)]
      .map((m) => m[1])
      .find((body) => body.includes(`<title>${title}</title>`)) ?? ''
  const value = (body: string, tag: string) =>
    body.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`))?.[1] ?? ''
  const titles = (feed: string) =>
    [...feed.matchAll(/<item>[\s\S]*?<title>([^<]*)<\/title>/g)].map((m) => m[1])

  /**
   * A synthetic note, because the fixture vault has no note with an empty
   * excerpt and none whose title is hostile to XML. Shaped rather than scanned:
   * `feedXml` reads six fields and inventing a whole markdown file to exercise
   * one of them would hide what each test is about.
   */
  const note = (over: Partial<VaultNote> = {}): VaultNote =>
    ({
      path: 'Note.md',
      slug: 'note',
      filename: 'Note',
      title: 'Note',
      aliases: [],
      oldUrls: [],
      published: true,
      frontmatter: {},
      body: '',
      tags: [],
      excerpt: 'An excerpt.',
      bodyOffset: 0,
      dates: {
        created: new Date('2026-01-02T00:00:00Z'),
        updated: new Date('2026-03-04T00:00:00Z'),
        known: { created: true, updated: true },
      },
      ...over,
    }) as VaultNote

  /**
   * The reason this module takes the *whole* vault rather than a filtered list.
   * The feed is the one output whose note list is not the route list, so a leak
   * here is a leak nothing else in the build would catch.
   */
  it('never emits an unpublished note, title or link', () => {
    expect(xml).not.toContain('My Very Private Title')
    expect(xml).not.toContain('secret-log')
    expect(titles(xml)).not.toContain('Secret Log')
  })

  it('windows by updated, newest first', () => {
    const order = titles(xml)
    const updated = order.map((title) => new Date(value(item(xml, title), 'atom:updated')).getTime())
    expect(updated).toEqual([...updated].sort((a, b) => b - a))
  })

  /**
   * `pubDate` is the *created* date and must not move when a typo is fixed:
   * readers sort by it, and a stable guid means a revision never resurfaces
   * anyway. Wiring both elements to `updated` is the mistake this catches.
   */
  it('publishes at created and revises at updated', () => {
    const home = item(xml, 'Home')
    expect(value(home, 'pubDate')).toBe(new Date('2026-01-02').toUTCString())
    expect(value(home, 'atom:updated')).toBe(new Date('2026-03-04').toISOString())
    expect(value(home, 'pubDate')).not.toBe(value(home, 'atom:updated'))
  })

  /** Two formats, one item, and they are not interchangeable. */
  it('spells pubDate as RFC-822 and atom:updated as RFC-3339', () => {
    for (const title of titles(xml)) {
      const body = item(xml, title)
      const pub = value(body, 'pubDate')
      const updated = value(body, 'atom:updated')
      expect(pub).toMatch(/^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/)
      expect(updated).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
      expect(Number.isNaN(new Date(pub).getTime())).toBe(false)
      expect(Number.isNaN(new Date(updated).getTime())).toBe(false)
    }
  })

  /**
   * A revision re-enters the window, so revising old notes can push an unread
   * new one out of a short feed before a subscriber polls: silent loss, since
   * readers dedupe on guid and it never comes back. Hence 50 rather than
   * Quartz's 10.
   */
  it('caps the window, keeping the most recently updated', () => {
    const many = Array.from({ length: MAX_ITEMS + 10 }, (_, i) =>
      note({
        slug: `n-${i}`,
        title: `N ${i}`,
        dates: {
          created: new Date(2026, 0, 1),
          updated: new Date(2026, 0, 1 + i),
          known: { created: true, updated: true },
        },
      }),
    )
    const capped = feedXml({ ...options, notes: many })
    expect(titles(capped)).toHaveLength(MAX_ITEMS)
    expect(titles(capped)[0]).toBe(`N ${MAX_ITEMS + 9}`)
    expect(capped).not.toContain('<title>N 0</title>')
  })

  it('links and guids are absolute, on the configured origin, and agree with noteHref', () => {
    for (const title of titles(xml)) {
      const body = item(xml, title)
      const link = value(body, 'link')
      expect(link.startsWith('https://example.com/')).toBe(true)
      expect(value(body, 'guid')).toBe(link)
    }
    const luhmann = item(xml, 'Niklas Luhmann')
    expect(value(luhmann, 'link')).toBe(`https://example.com${noteHref('notes/luhmann')}`)
  })

  it('marks the guid as a permalink rather than trusting the default', () => {
    expect(xml).toContain('<guid isPermaLink="true">')
  })

  /**
   * `src/pages/[...slug].astro` gives the note claiming `/` no route of its own,
   * so an item linking to its slug would be a dead end with no navigation to
   * recover through. The feed used to take a `homepageSlug` to special-case
   * that; the scan now hands it the `index` slug, so this is `noteHref`
   * answering the question it has always answered, and the whole mechanism.
   */
  it('sends the note claiming / to the site root, not to a slug with no page', () => {
    const withIndex = feedXml({ ...options, notes: [note({ slug: 'index', title: 'Landing' })] })
    expect(value(item(withIndex, 'Landing'), 'link')).toBe('https://example.com/')
    expect(value(item(withIndex, 'Landing'), 'guid')).toBe('https://example.com/')
  })

  it('percent-encodes a unicode slug the way every page link does', () => {
    const cyrillic = item(xml, 'Заметка')
    expect(value(cyrillic, 'link')).toBe(
      'https://example.com/notes/%D0%B7%D0%B0%D0%BC%D0%B5%D1%82%D0%BA%D0%B0',
    )
  })

  /**
   * Escaped, never CDATA: a CDATA section ends at the first `]]>`, so a note
   * containing one would terminate it early and corrupt the document. Quartz's
   * feed has exactly that hole.
   */
  it('escapes hostile text rather than wrapping it in CDATA', () => {
    const hostile = feedXml({
      ...options,
      notes: [note({ title: 'A & B <tag> ]]> "quoted" it’s', excerpt: 'Ampersand & angle <' })],
    })
    expect(hostile).not.toContain('<![CDATA[')
    expect(hostile).toContain('<title>A &amp; B &lt;tag&gt; ]]&gt; &quot;quoted&quot; it’s</title>')
    expect(hostile).toContain('<description>Ampersand &amp; angle &lt;</description>')
    // Nothing outside a tag is a bare `&`, which is the property that matters.
    expect(hostile.replace(/&(?:amp|lt|gt|quot|apos|#\d+);/g, '')).not.toContain('&')
  })

  it('emits one category per tag, and none for an untagged note', () => {
    const zettel = item(xml, 'Zettelkasten')
    expect([...zettel.matchAll(/<category>([^<]*)<\/category>/g)].map((m) => m[1])).toEqual([
      'method/zettelkasten',
      'inline-ish',
      'plain',
    ])
    expect(item(xml, 'Niklas Luhmann')).not.toContain('<category>')
  })

  /**
   * RSS's `<author>` requires an e-mail address and `config.author` is a name,
   * so the profile's advice is `dc:creator`, and never both.
   */
  it('names an author only when one is configured', () => {
    expect(xml).not.toContain('<dc:creator>')
    expect(xml).not.toContain('<author>')
    const credited = feedXml({ ...options, author: 'Navid Kashani' })
    expect(credited).toContain('<dc:creator>Navid Kashani</dc:creator>')
    expect(credited).not.toContain('<author>')
  })

  /** RSS requires a title *or* a description; the title is always there. */
  it('omits the description for a note with no prose rather than emitting an empty one', () => {
    const silent = feedXml({ ...options, notes: [note({ excerpt: '' })] })
    expect(item(silent, 'Note')).not.toContain('<description>')
    expect(silent).not.toContain('<description></description>')
  })

  it('carries the channel children RSS requires, and declares both namespaces', () => {
    expect(xml).toContain('xmlns:atom="http://www.w3.org/2005/Atom"')
    expect(xml).toContain('xmlns:dc="http://purl.org/dc/elements/1.1/"')
    expect(xml).toContain('<title>Slipbox</title>')
    expect(xml).toContain('<link>https://example.com/</link>')
    expect(xml).toContain('<description>A garden of notes.</description>')
    expect(xml).toContain('<language>en</language>')
    expect(xml).toContain(
      `<atom:link href="https://example.com${FEED_PATH}" rel="self" type="application/rss+xml"/>`,
    )
  })

  /** An empty `<description>` is invalid, and it is a required channel child. */
  it('falls back to the title when no description is configured', () => {
    const bare = feedXml({ ...options, description: '' })
    expect(bare).toContain('<description>Slipbox</description>')
  })

  /**
   * `lastBuildDate` is the newest item's `updated`, never `new Date()`, so a
   * deploy diff of two unchanged builds is empty.
   */
  it('stamps lastBuildDate from the content, so two builds are byte-identical', () => {
    const newest = titles(xml)[0]
    expect(xml).toContain(
      `<lastBuildDate>${new Date(value(item(xml, newest), 'atom:updated')).toUTCString()}</lastBuildDate>`,
    )
    expect(feedXml(options)).toBe(xml)
  })

  it('still produces a valid channel for an empty vault', () => {
    const empty = feedXml({ ...options, notes: [] })
    expect(empty).toContain('<channel>')
    expect(empty).toContain('<description>A garden of notes.</description>')
    expect(empty).not.toContain('<item>')
    // Nothing was built, so there is no last build to report.
    expect(empty).not.toContain('<lastBuildDate>')
  })
})

describe('config: rss', () => {
  it('leaves the feed off by default', () => {
    expect(defineConfig({}).features.rss).toBe(false)
  })

  /**
   * A feed of relative links is not a degraded feed, it is one no reader can
   * resolve. Degrade loudly, naming the key that is missing.
   */
  it('refuses features.rss without a url, naming url', () => {
    expect(() => defineConfig({ features: { rss: true } })).toThrow(/url/)
  })

  it('accepts features.rss with a url', () => {
    const config = defineConfig({ features: { rss: true }, url: 'https://example.com' })
    expect(config.features.rss).toBe(true)
    expect(config.url).toBe('https://example.com')
  })

  it('still parses with the feed off and no url', () => {
    expect(defineConfig({ features: { rss: false } }).url).toBeUndefined()
  })

  /** Wrapping the root in a refinement must not stop `.strict()` biting. */
  it('keeps rejecting an unknown key through the refinement', () => {
    expect(() => defineConfig({ colour: 'blue' } as never)).toThrow()
  })
})

/**
 * The two halves of `image:`, split so the scan can validate a value without
 * knowing the site URL. Built against the fixture vault's own `assets` index
 * (the real one, since resolution is the whole question) with a synthetic index
 * only where the fixture has no file of the shape being tested, the way the
 * feed tests use a synthetic `note()`.
 */
describe('social images', () => {
  const v = vault()
  const SITE = 'https://example.com'
  const url = (raw: string, from = 'Home.md') =>
    socialImageUrl(resolveSocialImage(raw, from, v), SITE)

  it('resolves a vault path, a bare filename and a ./ path to the same file', () => {
    for (const raw of ['attachments/diagram.png', 'diagram.png', './diagram.png']) {
      expect(url(raw)).toBe(`${SITE}/_vault/attachments/diagram.png`)
    }
  })

  it('resolves relative to the note that declared it', () => {
    expect(url('../attachments/diagram.png', 'notes/Note.md')).toBe(
      `${SITE}/_vault/attachments/diagram.png`,
    )
  })

  /** How a file in `public/` is named. Joined to the site URL untouched. */
  it('keeps a rooted path rooted', () => {
    const resolved = resolveSocialImage('/og.png', 'Home.md', v)
    expect(resolved).toEqual({ status: 'ok', target: '/og.png', remote: false })
    expect(url('/og.png')).toBe(`${SITE}/og.png`)
  })

  it('passes an absolute URL through as the author’s explicit choice', () => {
    expect(resolveSocialImage('https://cdn.example.com/x.png', 'Home.md', v)).toEqual({
      status: 'ok',
      target: 'https://cdn.example.com/x.png',
      remote: true,
    })
    expect(url('https://cdn.example.com/x.png')).toBe('https://cdn.example.com/x.png')
  })

  it('gives a protocol-relative URL the site’s own scheme', () => {
    expect(url('//cdn.example.com/x.png')).toBe('https://cdn.example.com/x.png')
  })

  /**
   * Silence is the bug being fixed. Both of these are reported by name at the
   * scan; here they are simply not `ok`, so no tag is emitted.
   */
  it('reports a file that is not in the vault rather than inventing a URL', () => {
    expect(resolveSocialImage('attachments/gone.png', 'Home.md', v)).toEqual({ status: 'unresolved' })
    expect(url('attachments/gone.png')).toBeUndefined()
  })

  /**
   * Facebook does not render SVG, so a card pointing at one is a fetch that
   * draws nothing: indistinguishable from no card, and worse than one. A
   * different question from `isOptimizable`, which is why it has its own list.
   */
  it('refuses a format no unfurler draws', () => {
    const svgVault = { assets: new Map([['logo.svg', ['attachments/logo.svg']]]) }
    expect(resolveSocialImage('logo.svg', 'Home.md', svgVault)).toEqual({ status: 'unsupported' })
  })

  it('treats a missing, empty or non-string value as nothing declared', () => {
    for (const raw of [undefined, null, '', '   ', 42, true, ['a.png']]) {
      expect(resolveSocialImage(raw, 'Home.md', v)).toEqual({ status: 'none' })
    }
  })

  /**
   * The gate that makes the whole feature honest: an unfurler has no document
   * to resolve a relative URL against, so without `url` there is no card to
   * emit: not a shorter one.
   */
  it('emits nothing at all without a site URL', () => {
    const resolved = resolveSocialImage('diagram.png', 'Home.md', v)
    expect(resolved.status).toBe('ok')
    expect(socialImageUrl(resolved, undefined)).toBeUndefined()
    expect(socialImageUrl(resolved, '')).toBeUndefined()
  })

  it('gives nothing back for a value that did not resolve', () => {
    expect(socialImageUrl({ status: 'none' }, SITE)).toBeUndefined()
    expect(socialImageUrl({ status: 'unresolved' }, SITE)).toBeUndefined()
    expect(socialImageUrl({ status: 'unsupported' }, SITE)).toBeUndefined()
  })

  /**
   * Quartz coalesces the same three spellings, so a migrated vault keeps its
   * cards. The key comes back with the value so a warning can quote the line
   * the author would go and edit, rather than one they never typed.
   */
  it('reads image, socialImage and cover, in that order, and says which', () => {
    expect(frontmatterImage({ image: 'a.png', socialImage: 'b.png', cover: 'c.png' })).toEqual({
      key: 'image',
      value: 'a.png',
    })
    expect(frontmatterImage({ socialImage: 'b.png', cover: 'c.png' })?.key).toBe('socialImage')
    expect(frontmatterImage({ cover: 'c.png' })?.key).toBe('cover')
    expect(frontmatterImage({ image: '  a.png  ' })?.value).toBe('a.png')
    expect(frontmatterImage({})).toBeUndefined()
    expect(frontmatterImage({ image: 12 })).toBeUndefined()
    expect(frontmatterImage({ image: '   ' })).toBeUndefined()
  })
})

describe('config: image', () => {
  it('leaves the site-wide card image unset by default', () => {
    expect(defineConfig({}).image).toBeUndefined()
  })

  /**
   * The `features.rss` refinement's second use, for the identical reason: an
   * `og:image` that is not absolute is not a smaller card, it is one nobody
   * draws. Degrade loudly, naming the key that is missing.
   */
  it('refuses image without a url, naming url', () => {
    expect(() => defineConfig({ image: 'attachments/og.png' })).toThrow(/url/)
  })

  it('accepts image with a url', () => {
    const config = defineConfig({ image: 'attachments/og.png', url: 'https://example.com' })
    expect(config.image).toBe('attachments/og.png')
  })
})

describe('redirects', () => {
  /**
   * A note as `buildRedirects` reads one. Written out rather than cast, because
   * the general vacated-slug rule reads `path` and `permalinks` too, and a
   * fixture missing either would pass for the wrong reason.
   */
  const note = (fields: Partial<VaultNote> & { slug: string }): VaultNote =>
    ({
      path: `${fields.slug}.md`,
      aliases: [],
      oldUrls: [],
      renamedFrom: [],
      permalinks: [],
      ...fields,
    }) as VaultNote

  const notes = [
    note({ slug: 'zettelkasten', aliases: ['Slipbox Method', 'Zettel'] }),
    note({ slug: 'notes/other', path: 'notes/Other.md', aliases: ['Zettel'] }),
    note({ slug: 'jotter', aliases: ['jotter'] }),
    note({ slug: 'plain' }),
  ]

  it('turns aliases into redirects', () => {
    const out = buildRedirects({ notes, taken: [] })
    expect(out['/slipbox-method']).toBe('/zettelkasten')
    expect(out['/zettel']).toBe('/zettelkasten')
  })

  it('gives a contested alias to the first note that claimed it', () => {
    expect(buildRedirects({ notes, taken: [] })['/zettel']).toBe('/zettelkasten')
  })

  it('never shadows a slug a real page already owns', () => {
    const out = buildRedirects({ notes, taken: ['slipbox-method'] })
    expect(out['/slipbox-method']).toBeUndefined()
  })

  it('never redirects a note to itself', () => {
    expect(buildRedirects({ notes, taken: [] })['/jotter']).toBeUndefined()
  })

  it('lets config redirects win, and normalises their slashes', () => {
    const out = buildRedirects({ notes, taken: [], extra: { 'zettel': 'somewhere-else' } })
    expect(out['/zettel']).toBe('/somewhere-else')
  })

  /**
   * One rule for every note whose slug is not the one its path derives, rather
   * than the homepage-shaped special case it replaces. Recomputed from the
   * path, which is why no `previousSlug` field had to be invented.
   */
  it('keeps the promoted note’s old URL working', () => {
    const promoted = [
      note({ slug: 'index', path: 'Zettelkasten.md' }),
      note({ slug: 'index', path: 'notes/Deep Note.md' }),
    ]
    const out = buildRedirects({ notes: promoted, taken: [] })
    expect(out['/zettelkasten']).toBe('/')
    expect(out['/notes/deep-note']).toBe('/')
  })

  it('emits nothing for a note that was at the root all along', () => {
    const rooted = [note({ slug: 'index', path: 'index.md' })]
    expect(buildRedirects({ notes: rooted, taken: [] })).toEqual({})
  })

  it('gives up the old URL rather than shadow a note that has taken it', () => {
    const promoted = [note({ slug: 'index', path: 'Zettelkasten.md' })]
    const out = buildRedirects({ notes: promoted, taken: ['zettelkasten'] })
    expect(out['/zettelkasten']).toBeUndefined()
  })

  /**
   * The same one rule, reached the other way: a `permalink:` moved the note, so
   * the URL it used to be published at 301s to the new one.
   */
  it('301s a permalinked note’s derived slug to where it now lives', () => {
    const moved = [note({ slug: 'Company/About+us', path: 'Legacy Note.md' })]
    const out = buildRedirects({ notes: moved, taken: [], slugs: 'obsidian' })
    expect(out['/Legacy+Note']).toBe('/Company/About+us')
  })

  it('turns every permalink after the first into a redirect of its own', () => {
    const moved = [
      note({
        slug: 'Company/About+us',
        path: 'Legacy Note.md',
        permalinks: ['Company/About+us', 'Company/About', 'about'],
      }),
    ]
    const out = buildRedirects({ notes: moved, taken: [], slugs: 'obsidian' })
    expect(out['/Company/About']).toBe('/Company/About+us')
    expect(out['/about']).toBe('/Company/About+us')
    // The first is where the note is served; it is not a redirect to itself.
    expect(out['/Company/About+us']).toBeUndefined()
  })

  /**
   * A collision suffix is deliberately *not* a vacated slug: the derived slug
   * is owned by the note that won it, and `owned` skips it. A redirect there
   * would shadow a real page.
   */
  it('emits nothing for a slug a collision gave to another note', () => {
    const collided = [note({ slug: 'note-2', path: 'b/Note.md' })]
    const out = buildRedirects({ notes: collided, taken: ['note'] })
    expect(out['/note']).toBeUndefined()
  })

  /**
   * Sources come out in **URL** space and the comparisons stay in **slug**
   * space. Netlify's own docs require encoded paths in `_redirects`, and the
   * shadow check has to keep comparing like with like or it stops catching
   * anything on a site whose slugs are interesting.
   */
  it('encodes redirect sources while still detecting a shadowed page', () => {
    const moved = [note({ slug: 'new', path: 'Wisdom & Approaches/Critical Thinking.md' })]
    const out = buildRedirects({ notes: moved, taken: [], slugs: 'obsidian' })
    expect(out['/Wisdom+%26+Approaches/Critical+Thinking']).toBe('/new')
    expect(encodeSlug('Wisdom+&+Approaches/Critical+Thinking')).toBe(
      'Wisdom+%26+Approaches/Critical+Thinking',
    )

    const shadowed = buildRedirects({
      notes: moved,
      taken: ['Wisdom+&+Approaches/Critical+Thinking'],
      slugs: 'obsidian',
    })
    expect(shadowed).toEqual({})
  })

  it('encodes an alias that is not ASCII', () => {
    const cyrillic = [note({ slug: 'luhmann', aliases: ['Заметка'] })]
    const out = buildRedirects({ notes: cyrillic, taken: [] })
    expect(out['/%D0%B7%D0%B0%D0%BC%D0%B5%D1%82%D0%BA%D0%B0']).toBe('/luhmann')
  })

  /**
   * An alias is a *name*. Under `derive` that name is slugified, because the
   * derived slug it stands in for would have been; under the other two, jotter
   * does not invent spellings and carries it as typed.
   */
  it('slugifies an alias under derive and carries it verbatim otherwise', () => {
    const aliased = [note({ slug: 'x', path: 'x.md', aliases: ['Slipbox Method'] })]
    expect(buildRedirects({ notes: aliased, taken: [] })['/slipbox-method']).toBe('/x')
    expect(
      buildRedirects({ notes: aliased, taken: [], slugs: 'preserve' })['/Slipbox%20Method'],
    ).toBe('/x')
  })

  it('never lets a name become a protocol-relative URL', () => {
    const aliased = [note({ slug: 'x', path: 'x.md', aliases: ['/leading/slash/'] })]
    const out = buildRedirects({ notes: aliased, taken: [], slugs: 'preserve' })
    expect(Object.keys(out)).toEqual(['/leading/slash'])
  })

  /**
   * The status split, source by source.
   *
   * A `301` says "never ask me again", and nothing bounds one this build writes
   * with a `Cache-Control`. Every rule below but the two frozen ones is
   * recomputed from current frontmatter on every build, so the next build can
   * *withdraw* it — and a browser holding a withdrawn `301` never finds out.
   * Where the withdrawal is a note moving back, it is holding one half of a
   * loop the server completes on request. See `RedirectRule`.
   */
  describe('promises permanence only where a later build cannot retract it', () => {
    it('301s the address Obsidian Publish served, which nothing takes back', () => {
      const migrated = [note({ slug: 'notes/plain', oldUrls: ['Notes/Plain'] })]
      const out = buildRedirectRules({ notes: migrated, taken: [], slugs: 'preserve' })
      expect(out['/Notes/Plain']).toEqual({ to: '/notes/plain', permanent: true })
    })

    it('301s a redirect the author wrote into the config by hand', () => {
      const out = buildRedirectRules({ notes: [], taken: [], extra: { old: 'new' } })
      expect(out['/old']).toEqual({ to: '/new', permanent: true })
    })

    it('302s a slug a permalink or a promotion vacated', () => {
      const out = buildRedirectRules({ notes: [note({ slug: 'perma', path: 'Derived.md' })], taken: [] })
      expect(out['/derived']).toEqual({ to: '/perma', permanent: false })
    })

    it('302s every permalink after the first, which the author can reorder', () => {
      const moved = [note({ slug: 'perma', path: 'perma.md', permalinks: ['perma', 'older'] })]
      expect(buildRedirectRules({ notes: moved, taken: [] })['/older']?.permanent).toBe(false)
    })

    it('302s a rename, and 302s an alias the author can simply delete', () => {
      const moved = [note({ slug: 'now', renamedFrom: ['then'], aliases: ['Nickname'] })]
      const out = buildRedirectRules({ notes: moved, taken: [] })
      expect(out['/then']).toEqual({ to: '/now', permanent: false })
      expect(out['/nickname']).toEqual({ to: '/now', permanent: false })
    })

    /**
     * An address can arrive by both routes: Obsidian Publish served it *and*
     * the plugin has since recorded a move away from it. The frozen claim is
     * the true one, so it wins the first write and the stronger status.
     */
    it('keeps the 301 where an address is both published and renamed', () => {
      const both = [note({ slug: 'now', oldUrls: ['then'], renamedFrom: ['then'] })]
      expect(buildRedirectRules({ notes: both, taken: [] })['/then']?.permanent).toBe(true)
    })

    /**
     * The loop this all exists to break, in the two builds that produced it.
     * Neither rule is wrong on its own; both being permanent is what left a
     * browser bouncing between them until `ERR_TOO_MANY_REDIRECTS`.
     */
    it('pins neither half of a pair that reverses when a permalink is dropped', () => {
      const withPermalink = buildRedirectRules({
        notes: [note({ slug: 'perma', path: 'Derived.md' })],
        taken: [],
      })
      const afterItWasDropped = buildRedirectRules({
        notes: [note({ slug: 'derived', path: 'Derived.md', renamedFrom: ['perma'] })],
        taken: [],
      })
      expect(withPermalink['/derived']).toEqual({ to: '/perma', permanent: false })
      expect(afterItWasDropped['/perma']).toEqual({ to: '/derived', permanent: false })
    })
  })

  /**
   * `buildRedirects` is the same map with the statuses dropped, for callers
   * that only want to know where an address goes.
   */
  it('answers where an address goes without its status', () => {
    const migrated = [note({ slug: 'now', oldUrls: ['then'] })]
    expect(buildRedirects({ notes: migrated, taken: [] })['/then']).toBe('/now')
  })

  it('renders the Netlify and Vercel formats, each rule at its own status', () => {
    const rules = {
      '/old': { to: '/new', permanent: true },
      '/vacated': { to: '/new', permanent: false },
    }
    expect(toNetlify(rules)).toBe('/old /new 301\n/vacated /new 302\n')
    const vercel = JSON.parse(toVercel(rules))
    expect(vercel.redirects).toEqual([
      { source: '/old', destination: '/new', permanent: true },
      { source: '/vacated', destination: '/new', permanent: false },
    ])
    expect(vercel.cleanUrls).toBe(true)
  })

  it('writes a robots.txt that matches the noIndex setting', () => {
    expect(robotsTxt(true)).toContain('Disallow: /\n')
    expect(robotsTxt(false, 'https://x.com/sitemap-index.xml')).toContain('Sitemap: https://x.com')
    expect(robotsTxt(false)).toContain('Allow: /\n')
  })

  it('keeps crawlers out of the search index either way', () => {
    // Unconditional: a robots.txt that flips with a feature flag is one
    // somebody has to remember to check.
    expect(robotsTxt(false)).toContain('Disallow: /pagefind/')
    // …but noIndex already disallows everything, and says so in one line.
    expect(robotsTxt(true)).not.toContain('/pagefind/')
  })
})
