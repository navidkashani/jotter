import { describe, expect, it } from 'vitest'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { markdownToHtml } from 'satteri'

import { scanVault, clearVaultCache } from '../src/lib/vault.js'
import { defineConfig, type JotterConfigInput } from '../src/lib/config.js'
import { jotterPlugins, satteriFeatures } from '../src/markdown/index.js'

const VAULT = fileURLToPath(new URL('./fixtures/vault', import.meta.url))

/** Compile a note exactly the way the Astro build will. */
function render(notePath: string, overrides: JotterConfigInput = {}): string {
  clearVaultCache()
  const vault = scanVault({ root: VAULT })
  const config = defineConfig({ vault: VAULT, ...overrides })
  const note = vault.byPath.get(notePath.toLowerCase())
  if (!note) throw new Error(`fixture missing: ${notePath}`)

  const result = markdownToHtml(note.body, {
    features: satteriFeatures,
    mdastPlugins: jotterPlugins(vault, config),
    fileURL: pathToFileURL(join(VAULT, note.path)),
  })
  return typeof result === 'string' ? result : (result as { html: string }).html
}

describe('wikilink resolution', () => {
  const html = render('Zettelkasten.md')

  it('turns a resolved wikilink into a real link', () => {
    expect(html).toMatch(/<a href="\/notes\/luhmann">Luhmann<\/a>/)
  })

  it('renders an unpublished target as an inert span, not an anchor', () => {
    expect(html).toContain('class="dead-link"')
    expect(html).not.toMatch(/<a[^>]*href="[^"]*secret/i)
  })

  it('never leaks an unpublished note title', () => {
    expect(html).not.toContain('My Very Private Title')
    expect(html).toContain('the private one') // the alias the author wrote
  })

  it('renders an unresolved link as an inert span labelled by its target', () => {
    expect(html).toMatch(/<span class="dead-link">Nothing At All<\/span>/)
  })

  it('emits no anchor with an empty or undefined href', () => {
    expect(html).not.toMatch(/<a[^>]+href=""/)
    expect(html).not.toMatch(/href="undefined"/)
    expect(html).not.toMatch(/<span[^>]+href=/)
  })

  it('leaves wikilinks inside a code fence and inline code literal', () => {
    expect(html).toContain('[[Luhmann]] inside a fence stays literal')
    expect(html).toContain('[[AlsoLiteral]]')
  })

  it('labels a dead link with the basename, not the written path', () => {
    const bare = render('Home.md')
    expect(bare).toMatch(/<span class="dead-link">Secret Log<\/span>/)
  })
})

describe('embeds', () => {
  const html = render('Zettelkasten.md')

  it('resolves an image embed to the attachment', () => {
    expect(html).toMatch(/<img[^>]+src="[^"]*diagram\.png"/)
  })

  it('reads a numeric pipe as a width', () => {
    expect(html).toMatch(/<img[^>]+width="300"/)
  })

  it('reads a non-numeric pipe as a caption and builds a figure', () => {
    expect(html).toContain('<figure class="embed-figure">')
    expect(html).toContain('<figcaption>A caption here</figcaption>')
  })

  it('never puts a figure inside a paragraph', () => {
    // An open <p> with no </p> before the <figure> would be invalid nesting,
    // which Astro 7's compiler no longer silently repairs.
    expect(html).not.toMatch(/<p>(?:(?!<\/p>)[\s\S])*?<figure/)
  })
})

describe('callouts', () => {
  const html = render('Zettelkasten.md')

  it('renders a plain callout with its type and title', () => {
    expect(html).toMatch(/<div class="callout" data-callout="note">/)
    expect(html).toContain('<div class="callout-title">A callout</div>')
    expect(html).toContain('With a body.')
  })

  it('renders a collapsible callout as details/summary', () => {
    expect(html).toMatch(/<details class="callout" data-callout="warning">/)
    expect(html).toContain('<summary class="callout-title">Collapsed</summary>')
    expect(html).not.toMatch(/<details[^>]+open/)
  })

  it('leaves an ordinary blockquote alone', () => {
    const out = compile('> just a quote')
    expect(out).toContain('<blockquote>')
    expect(out).not.toContain('callout')
  })
})

describe('inline syntaxes', () => {
  const html = render('Zettelkasten.md')

  it('renders a highlight as mark', () => {
    expect(html).toContain('<mark>important</mark>')
  })

  it('strips comments', () => {
    expect(html).not.toContain('but not this comment')
    expect(html).not.toContain('%%')
  })

  it('links inline tags to their tag page', () => {
    expect(html).toMatch(/<a class="tag-chip" href="\/tags\/method\/zettelkasten"[^>]*>#method\/zettelkasten<\/a>/)
  })

  it('turns a soft newline into a break by default', () => {
    expect(html).toContain('<br>')
  })

  it('keeps soft newlines as whitespace under strictLineBreaks', () => {
    expect(render('Zettelkasten.md', { strictLineBreaks: true })).not.toContain('<br>')
  })

  it('never makes a tag chip out of text in a code fence', () => {
    expect(html).not.toMatch(/tag-chip[^>]*>#AlsoLiteral/)
  })
})

describe('transclusion', () => {
  it('inlines a target inside an aside that links back to it', () => {
    const html = render('cycles/A.md')
    expect(html).toContain('class="transclusion"')
    expect(html).toMatch(/<a class="transclusion-source" href="\/cycles\/b">B<\/a>/)
  })

  it('stops at a cycle instead of recursing', () => {
    const html = render('cycles/A.md')
    expect(html).toContain('data-transclusion="cycle"')
    expect(html).toContain('already open above')
  })

  it('stops at the configured depth', () => {
    const html = render('cycles/A.md', { transcludeDepth: 0 })
    expect(html).toContain('data-transclusion="depth"')
  })
})

describe('whitespace around inline elements (the compressHTML: jsx trap)', () => {
  it('keeps the space between a word and a following link', () => {
    const out = compile('Invented by [[Luhmann]] in Bielefeld.')
    expect(out).toContain('by <a')
    expect(out).toContain('</a> in')
  })

  it('keeps the space around emphasis next to a link', () => {
    const out = compile('An *emphasised* [[Luhmann]] word.')
    expect(out).toMatch(/<em>emphasised<\/em> <a/)
  })
})

/** Compile an arbitrary snippet as though it were a note at the vault root. */
function compile(markdown: string, overrides: JotterConfigInput = {}): string {
  clearVaultCache()
  const vault = scanVault({ root: VAULT })
  const config = defineConfig({ vault: VAULT, ...overrides })
  const result = markdownToHtml(markdown, {
    features: satteriFeatures,
    mdastPlugins: jotterPlugins(vault, config),
    fileURL: pathToFileURL(join(VAULT, 'Zettelkasten.md')),
  })
  return typeof result === 'string' ? result : (result as { html: string }).html
}
