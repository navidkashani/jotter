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
