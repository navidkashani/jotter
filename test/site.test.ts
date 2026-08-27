import { describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'

import { scanVault, clearVaultCache } from '../src/lib/vault.js'
import { buildTree, folders, contains } from '../src/lib/tree.js'
import { noteHref, assetHref, tagHref, relativeAssetPath } from '../src/lib/href.js'
import { liveLabel } from '../src/lib/resolve.js'
import { svgIntrinsicSize, isOptimizable } from '../src/lib/embed.js'
import { sectionOf, preresolveLinks, expandTransclusions } from '../src/lib/transclude.js'
import { defineConfig, jotterConfigSchema } from '../src/lib/config.js'
import { buildRedirects, toNetlify, toVercel, robotsTxt } from '../src/lib/redirects.js'
import { feedXml, MAX_ITEMS, FEED_PATH } from '../src/lib/feed.js'
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
  const t = buildTree(vault().notes.filter((n) => n.published))

  it('derives folders from note paths', () => {
    const names = folders(t).map((f) => f.path).sort()
    expect(names).toContain('notes')
    expect(names).toContain('notes/nested')
  })

  it('never invents a folder holding nothing published', () => {
    // `private/` holds only an unpublished note, so it must not appear.
    expect(folders(t).map((f) => f.path)).not.toContain('private')
  })

  it('sorts folders before notes, each alphabetically', () => {
    const kinds = t.map((e) => e.kind)
    expect(kinds.indexOf('folder')).toBeLessThan(kinds.lastIndexOf('note'))
  })

  it('counts notes into every ancestor', () => {
    const notesFolder = folders(t).find((f) => f.path === 'notes')!
    // 4 directly in notes/, plus 1 in notes/nested/
    expect(notesFolder.count).toBe(5)
  })

  it('knows which folder holds the current note', () => {
    const notesFolder = folders(t).find((f) => f.path === 'notes')!
    expect(contains(notesFolder, 'notes/luhmann')).toBe(true)
    expect(contains(notesFolder, 'zettelkasten')).toBe(false)
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
})

describe('config — analytics', () => {
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
   * site's behaviour changes — but a config that used to parse now refuses to,
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
      published: true,
      frontmatter: {},
      body: '',
      tags: [],
      excerpt: 'An excerpt.',
      bodyOffset: 0,
      dates: { created: new Date('2026-01-02T00:00:00Z'), updated: new Date('2026-03-04T00:00:00Z') },
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
   * new one out of a short feed before a subscriber polls — silent loss, since
   * readers dedupe on guid and it never comes back. Hence 50 rather than
   * Quartz's 10.
   */
  it('caps the window, keeping the most recently updated', () => {
    const many = Array.from({ length: MAX_ITEMS + 10 }, (_, i) =>
      note({
        slug: `n-${i}`,
        title: `N ${i}`,
        dates: { created: new Date(2026, 0, 1), updated: new Date(2026, 0, 1 + i) },
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
   * `src/pages/[...slug].astro` gives the homepage note no route of its own, so
   * an item linking to its slug would be a dead end with no navigation to
   * recover through. The `index` slug is the same question, answered by
   * `noteHref` itself.
   */
  it('sends the homepage note to the site root, not to a slug with no page', () => {
    const notes = [note({ slug: 'home', title: 'Home page' })]
    const withHome = feedXml({ ...options, notes, homepageSlug: 'home' })
    expect(value(item(withHome, 'Home page'), 'link')).toBe('https://example.com/')

    const withIndex = feedXml({ ...options, notes: [note({ slug: 'index', title: 'Landing' })] })
    expect(value(item(withIndex, 'Landing'), 'link')).toBe('https://example.com/')
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
   * so the profile's advice is `dc:creator` — and never both.
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

describe('config — rss', () => {
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

describe('redirects', () => {
  const notes = [
    { slug: 'zettelkasten', aliases: ['Slipbox Method', 'Zettel'] },
    { slug: 'notes/other', aliases: ['Zettel'] },
    { slug: 'jotter', aliases: ['jotter'] },
    { slug: 'plain', aliases: [] },
  ] as never

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

  it('renders the Netlify and Vercel formats', () => {
    const redirects = { '/old': '/new' }
    expect(toNetlify(redirects)).toBe('/old /new 301\n')
    const vercel = JSON.parse(toVercel(redirects))
    expect(vercel.redirects).toEqual([{ source: '/old', destination: '/new', permanent: true }])
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
