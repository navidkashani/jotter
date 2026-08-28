import { describe, expect, it } from 'vitest'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { markdownToHtml } from 'satteri'

import { scanVault, clearVaultCache } from '../src/lib/vault.js'
import { defineConfig, type JotterConfigInput } from '../src/lib/config.js'
import { jotterPlugins, jotterHastPlugins, satteriFeatures } from '../src/markdown/index.js'

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
    hastPlugins: jotterHastPlugins(vault, config),
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

/**
 * The build-time half is unit-tested in `lib.test.ts`; this is the half that
 * only shows up in finished HTML — which anchors get the attributes, and which
 * emphatically do not.
 */
describe('hover previews', () => {
  const on = { features: { hoverPreview: true } }

  it('ships nothing at all with the flag off', () => {
    expect(render('Previews.md')).not.toContain('data-preview')
  })

  it('puts the target’s title and opening paragraph on a resolved wikilink', () => {
    expect(render('Previews.md', on)).toContain(
      '<a href="/notes/luhmann" data-preview-title="Niklas Luhmann" data-preview="A sociologist. Back to Zettelkasten.">',
    )
  })

  it('previews the section a heading link points at, and names it', () => {
    const html = render('Previews.md', on)
    // `>` needs no escaping inside a double-quoted attribute value, so this
    // reads literally here while the link's own text renders it as `&gt;`.
    expect(html).toContain('data-preview-title="Sections > How it works"')
    expect(html).toContain(
      'data-preview="Each note gets an address, and new notes are filed behind whichever note they answer."',
    )
  })

  it('falls back to the note for a heading that is missing, empty or fenced', () => {
    const html = render('Previews.md', on)
    for (const anchor of ['#nowhere', '#hidden', '#nothing-under-here']) {
      expect(html).toContain(
        `<a href="/sections${anchor}" data-preview-title="Sections" data-preview="The opening of the whole note,`,
      )
    }
  })

  it('never puts an excerpt on a dead link', () => {
    const html = render('Previews.md', on) + render('Zettelkasten.md', on)
    expect(html).toMatch(/class="dead-link"/)
    expect(html).not.toMatch(/<span[^>]*data-preview/)
  })

  /**
   * The regression test that stops the transclusion hole reopening.
   * `preresolveLinks` rewrites a transcluded note's wikilinks to `/slug#anchor`
   * before the host is parsed, so these arrive at the link visitor looking
   * exactly like external ones.
   */
  it('reaches a link that transclusion pre-resolved into an href', () => {
    expect(render('Previews.md', on)).toContain(
      '<a href="/zettelkasten" data-preview-title="Zettelkasten" data-preview="Invented by Luhmann.',
    )
  })

  it('reaches a hand-written internal markdown link out of the same branch', () => {
    expect(render('Previews.md', on)).toContain(
      '<a href="/sections" data-preview-title="Sections" data-preview="The opening of the whole note,',
    )
  })

  it('leaves genuinely external links alone, including protocol-relative ones', () => {
    const html = render('Previews.md', on)
    expect(html).toMatch(/<a href="https:\/\/example\.com">/)
    expect(html).toMatch(/<a href="\/\/example\.com\/notes\/luhmann">/)
  })

  /**
   * An inline transclusion is a `link` an earlier plugin already dressed, so
   * the attributes have to merge rather than overwrite. Its sibling, the
   * `.transclusion-source` back-link, is raw HTML and never reaches a visitor
   * at all — that asymmetry is a consequence of how each is built, and it is
   * recorded here rather than discovered later.
   */
  it('merges into an inline transclusion without stripping its class', () => {
    const html = render('Previews.md', on)
    expect(html).toContain('<a class="transclusion-source" href="/notes/luhmann">')
    expect(html).not.toMatch(/<a class="transclusion-source"[^>]*data-preview/)
  })
})

/**
 * Per-block direction, through the real pipeline rather than against
 * `firstStrong` directly. `test/bidi.test.ts` owns the rule; what is asserted
 * here is everything the rule cannot say on its own — which nodes get asked,
 * what each one inherits, and that a block agreeing with its page emits
 * nothing at all.
 */
describe('text direction', () => {
  const ltr = render('notes/Mixed direction.md')
  const rtl = render('notes/Mixed direction.md', { dir: 'rtl' })

  it('marks a Persian paragraph on an English site', () => {
    expect(ltr).toMatch(/<p dir="rtl">اینجا محلی هست/)
  })

  it('marks a Persian heading and a Persian list item', () => {
    expect(ltr).toMatch(/<h2[^>]*\bdir="rtl"/)
    expect(ltr).toMatch(/<li dir="rtl">وبلاگ شخصی<\/li>/)
  })

  /**
   * The claim the whole feature rests on. Not "the English blocks are marked
   * `ltr`" — they carry no `dir` at all, which is what makes a monolingual
   * vault byte-identical to a build without any of this.
   */
  it('leaves every English block on an English site completely unmarked', () => {
    expect(ltr).toContain('<p>An English paragraph, on an English site')
    expect(ltr).toContain('<li>An English item in the same list.</li>')
    expect(ltr).not.toContain('dir="ltr"')
  })

  it('marks a table cell, a callout title and a blockquote body', () => {
    expect(ltr).toMatch(/<t[hd] dir="rtl">ابزار<\/t[hd]>/)
    expect(ltr).toMatch(/<div class="callout-title" dir="rtl">یک هشدار فارسی<\/div>/)
  })

  /**
   * The assertion that justifies the hast seam, and the one that goes red if
   * this is ever moved to mdast. Transclusion splices a raw markdown string
   * wrapped in a literal `<aside>`; the aside arrives as a `raw` node and the
   * paragraph inside it does not exist at all while mdast is being walked.
   */
  it('reaches a paragraph that transclusion brought in', () => {
    expect(ltr).toMatch(/<aside class="transclusion"[\s\S]*?<p dir="rtl">این یادداشت به فارسی/)
  })

  it('never repeats a dir a block already inherits from its parent', () => {
    // The Persian blockquote is marked; the paragraph inside it must not be.
    expect(rtl).not.toMatch(/<blockquote dir="ltr">\s*<p dir="ltr">/)
    expect(ltr).not.toMatch(/dir="rtl"[^>]*>\s*<p dir="rtl">/)
  })

  /**
   * The mirror. An RTL site marks the *English*, and its own script goes
   * untouched — one rule, no second code path.
   */
  it('marks the English and leaves the Persian alone on an RTL site', () => {
    expect(rtl).toMatch(/<p dir="ltr">An English paragraph/)
    expect(rtl).toMatch(/<li dir="ltr">An English item in the same list\.<\/li>/)
    expect(rtl).toContain('<p>اینجا محلی هست')
    expect(rtl).not.toContain('dir="rtl"')
  })

  /**
   * `pre` resolves to `ltr` — code is left-to-right and must not be re-ordered
   * — but it is emitted under the same rule as everything else, so it costs an
   * LTR site nothing. Forcing it unconditionally was defect 3 of the plan's
   * scenario pass.
   */
  it('marks a code block only where it differs from the page', () => {
    expect(ltr).not.toMatch(/<pre[^>]*\bdir=/)
    expect(rtl).toMatch(/<pre[^>]*\bdir="ltr"/)
  })

  /** A Persian comment inside a fence is code, not prose, and is never asked. */
  it('never marks anything inside a code fence', () => {
    expect(ltr).not.toMatch(/<code[^>]*\bdir=/)
    expect(ltr).not.toMatch(/<span[^>]*\bdir=/)
  })

  /**
   * The escape hatch, and the case that catches an implementation which only
   * ever emits `rtl`: an RTL note on an LTR site, where it is the *English*
   * blocks that differ.
   */
  describe('the direction: frontmatter override', () => {
    const html = render('notes/English in Persian.md')

    it('flips the note baseline, so only its English blocks are marked', () => {
      expect(html).toContain('<p>این یادداشت به فارسی')
      expect(html).toMatch(/<p dir="ltr">An English paragraph inside an RTL note/)
      expect(html).toMatch(/<h2[^>]*\bdir="ltr"/)
      expect(html).toMatch(/<li dir="ltr">An English list item<\/li>/)
      expect(html).not.toContain('dir="rtl"')
    })

    it('is what the note says, not what the site says', () => {
      // Same note, RTL site: the note already agreed, so nothing changes.
      const onRtlSite = render('notes/English in Persian.md', { dir: 'rtl' })
      expect(onRtlSite).toMatch(/<p dir="ltr">An English paragraph inside an RTL note/)
    })
  })
})
